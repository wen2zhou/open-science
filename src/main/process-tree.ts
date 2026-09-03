import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

// Optional sink for kill-path diagnostics; callers with a logger pass one, tests and the notebook path
// omit it. Kept minimal so process-tree stays free of the Electron logger's import graph.
export type ProcessTreeLogger = { error: (message: string, error?: unknown) => void }

// Outcome of a tree teardown. `reaped` is true only when we are confident the WHOLE tree is gone:
// Windows taskkill /T exited 0, or POSIX left no surviving descendant and the direct child exited.
// A fallback path (taskkill failed → only the parent was direct-killed) reports reaped:false so a
// caller that must guarantee released file handles (the update-install gate) can refuse to proceed.
export type ProcessTreeKillResult = { reaped: boolean }

type OwnedPosixProcessGroup = Readonly<{
  kind: 'owned-posix-process-group'
  id: number
}>

type PosixProcessIdentity = Readonly<{
  pid: number
  ppid: number
  pgid: number
  sid: number
  birthToken: string | undefined
}>

type PosixProcessTable = Readonly<{
  processes: Map<number, PosixProcessIdentity>
  complete: boolean
}>

type PosixProcessTracker = {
  leaderPid: number
  // undefined until the first complete sample, null once that sample proves the leader was already
  // absent. Null is permanent: a later process with the same pid is an unowned replacement.
  leaderIdentity: PosixProcessIdentity | null | undefined
  identities: Map<number, PosixProcessIdentity>
  complete: boolean
}

// A detached POSIX child is the leader of a private process group whose stable id is its spawn pid.
// Keep that ownership receipt on the child handle so teardown can still address the group after the
// leader exits and its descendants are reparented. Unregistered children retain PPID-tree teardown.
const ownedPosixProcessGroups = new WeakMap<ChildProcess, OwnedPosixProcessGroup>()
const trackedPosixProcessTrees = new WeakMap<ChildProcess, PosixProcessTracker>()
const activePosixProcessTrackers = new Set<PosixProcessTracker>()
let ownershipSampleTimer: NodeJS.Timeout | undefined
let ownershipSampling: Promise<PosixProcessTable> | undefined
let ownershipResampleRequested = false

export const registerOwnedPosixProcessGroup = (child: ChildProcess): void => {
  const groupId = child.pid
  if (groupId === undefined || !Number.isSafeInteger(groupId) || groupId <= 0) return
  ownedPosixProcessGroups.set(child, { kind: 'owned-posix-process-group', id: groupId })
}

// Upper bound for awaiting a direct child's real exit (POSIX) or taskkill's own completion (Windows).
// Bounded so a wedged process can never hang app teardown; the caller (before-quit) also time-bounds
// the whole shutdown, this is a second, tighter guard scoped to a single tree.
const TERMINATE_GRACE_MS = 3_000

// Shorter wait after escalating to SIGKILL: SIGKILL is uncatchable, so a process that survives it is a
// kernel-level unkillable (uninterruptible sleep) we cannot do anything about — don't wait the full grace.
const SIGKILL_GRACE_MS = 1_000
const PROCESS_GROUP_POLL_MS = 25
const PROCESS_OWNERSHIP_SAMPLE_MS = 250

// Signals the direct child, tolerating an already-exited process or a handle with no pid. Skips a child
// already signaled so a first, graceful pass is a no-op on retry; escalation uses forceKillChild instead.
const killDirectChild = (child: ChildProcess, signal?: NodeJS.Signals): void => {
  try {
    if (!child.killed) child.kill(signal)
  } catch {
    // A kill on an already-exited child can throw; treat it as a no-op.
  }
}

// Hard-kills the direct child, bypassing the child.killed guard (a graceful pass already set it). Prefers
// process.kill(pid) so SIGKILL is delivered even after child.kill() flipped `killed`, falling back to the
// handle when no pid is exposed.
const forceKillChild = (child: ChildProcess): void => {
  try {
    if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    // Already gone, or we cannot signal it; nothing more to do.
  }
}

// True while the pid still exists. Signal 0 performs the permission/existence check without delivering a
// signal: ESRCH means gone, EPERM means alive but not ours to signal.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Sends a signal to each pid, ignoring processes that have already exited or that we cannot signal.
const signalPids = (pids: number[], signal: NodeJS.Signals): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited, or no permission; ignore and continue.
    }
  }
}

// Negative POSIX pids address a process group. Treat every error except ESRCH as potentially alive so
// permission or platform failures fail closed instead of claiming an owned group was reaped.
const isProcessGroupAlive = (groupId: number): boolean => {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const signalProcessGroup = (groupId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-groupId, signal)
  } catch {
    // The group may already be gone or inaccessible. The subsequent liveness wait decides reaped.
  }
}

const waitUntil = (condition: () => boolean, ms: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const deadline = Date.now() + ms
    const poll = (): void => {
      if (condition()) {
        resolve(true)
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        resolve(false)
        return
      }
      const timer = setTimeout(poll, Math.min(PROCESS_GROUP_POLL_MS, remaining))
      timer.unref?.()
    }
    poll()
  })

const waitForProcessGroupExit = (groupId: number, ms: number): Promise<boolean> =>
  waitUntil(() => !isProcessGroupAlive(groupId), ms)

const waitForPidsExit = (pids: number[], ms: number): Promise<boolean> =>
  waitUntil(() => pids.every((pid) => !isProcessAlive(pid)), ms)

// Resolves true once the child actually exits, or false once the grace elapses without an exit — so the
// caller can decide whether to escalate. The timer is cleared on exit (and unref'd) so a settled wait
// never leaves a live timer to fire spuriously or keep the process alive.
const waitForExit = (child: ChildProcess, ms: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    let settled = false
    const done = (exited: boolean): void => {
      if (settled) return
      settled = true
      resolve(exited)
    }
    const timer = setTimeout(() => done(false), ms)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
    child.once('close', () => {
      clearTimeout(timer)
      done(true)
    })
  })

type DescendantSnapshot = { pids: number[]; complete: boolean }

const parseLinuxProcStat = (stat: string): PosixProcessIdentity | undefined => {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) return undefined
  const pid = Number(stat.slice(0, stat.indexOf(' ')))
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u)
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const sid = Number(fields[3])
  const starttime = fields[19]
  if (
    ![pid, ppid, pgid, sid].every(Number.isSafeInteger) ||
    pid <= 0 ||
    starttime === undefined ||
    !/^\d+$/u.test(starttime)
  ) {
    return undefined
  }
  return { pid, ppid, pgid, sid, birthToken: `linux-proc-starttime:${starttime}` }
}

// Linux exposes a kernel-maintained process birth token in /proc/<pid>/stat field 22. Unlike ps
// lstart, starttime is measured in clock ticks since boot, so two process epochs that reuse one pid
// within the same wall-clock second remain distinguishable.
const collectLinuxProcessTable = async (): Promise<PosixProcessTable> => {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return { processes: new Map(), complete: false }
  }

  let complete = true
  const processes = new Map<number, PosixProcessIdentity>()
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/u.test(entry))
      .map(async (entry) => {
        try {
          const identity = parseLinuxProcStat(await readFile(`/proc/${entry}/stat`, 'utf8'))
          if (identity) processes.set(identity.pid, identity)
          else complete = false
        } catch (error) {
          // A process disappearing between readdir and readFile is normal churn and cannot survive
          // teardown. Any other read failure makes the ownership snapshot incomplete.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false
        }
      })
  )
  return { processes, complete: complete && processes.size > 0 }
}

// Other POSIX platforms provide topology through ps, but not a collision-resistant process birth
// token. Keep the topology available for diagnostics while marking the table incomplete so tracked
// teardown fails closed instead of signaling a pid based on a second-resolution timestamp.
const collectPortablePosixProcessTable = (): Promise<PosixProcessTable> =>
  new Promise<PosixProcessTable>((resolve) => {
    let ps: ChildProcess
    try {
      ps = spawn('ps', ['-A', '-o', 'pid=,ppid=,pgid=,sid='], { windowsHide: true })
    } catch {
      resolve({ processes: new Map(), complete: false })
      return
    }

    let out = ''
    let settled = false
    const finish = (table: PosixProcessTable): void => {
      if (settled) return
      settled = true
      resolve(table)
    }
    const timer = setTimeout(() => {
      try {
        ps.kill()
      } catch {
        // The sampler may already have exited.
      }
      finish({ processes: new Map(), complete: false })
    }, TERMINATE_GRACE_MS)
    timer.unref?.()

    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    ps.on('error', () => {
      clearTimeout(timer)
      finish({ processes: new Map(), complete: false })
    })
    ps.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ processes: new Map(), complete: false })
        return
      }
      const processes = new Map<number, PosixProcessIdentity>()
      for (const line of out.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/u)
        if (!match) continue
        const [, pidText, ppidText, pgidText, sidText] = match
        const pid = Number(pidText)
        const ppid = Number(ppidText)
        const pgid = Number(pgidText)
        const sid = Number(sidText)
        if (![pid, ppid, pgid, sid].every(Number.isSafeInteger) || pid <= 0) continue
        processes.set(pid, { pid, ppid, pgid, sid, birthToken: undefined })
      }
      finish({ processes, complete: false })
    })
  })

const collectPosixProcessTable = (): Promise<PosixProcessTable> =>
  process.platform === 'linux' ? collectLinuxProcessTable() : collectPortablePosixProcessTable()

const samePosixIdentity = (
  expected: PosixProcessIdentity,
  actual: PosixProcessIdentity | undefined
): boolean =>
  actual !== undefined &&
  expected.birthToken !== undefined &&
  actual.birthToken !== undefined &&
  actual.pid === expected.pid &&
  actual.birthToken === expected.birthToken

const captureTrackedDescendants = (
  tracker: PosixProcessTracker,
  table: PosixProcessTable
): void => {
  tracker.complete &&= table.complete
  if (!table.complete) return
  if (tracker.leaderIdentity === null) return
  const children = new Map<number, PosixProcessIdentity[]>()
  for (const process of table.processes.values()) {
    const siblings = children.get(process.ppid) ?? []
    siblings.push(process)
    children.set(process.ppid, siblings)
  }
  const observedLeader = table.processes.get(tracker.leaderPid)
  if (tracker.leaderIdentity === undefined) {
    if (observedLeader === undefined) {
      tracker.complete = false
      tracker.leaderIdentity = null
      return
    }
    tracker.leaderIdentity = observedLeader
    tracker.identities.set(tracker.leaderPid, observedLeader)
  }
  const roots = new Set<number>()
  if (samePosixIdentity(tracker.leaderIdentity, observedLeader)) roots.add(tracker.leaderPid)
  for (const identity of tracker.identities.values()) {
    if (identity.pid === tracker.leaderPid) continue
    if (samePosixIdentity(identity, table.processes.get(identity.pid))) roots.add(identity.pid)
  }
  const stack = [...roots]
  const visited = new Set<number>()
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (visited.has(pid)) continue
    visited.add(pid)
    const identity = table.processes.get(pid)
    if (pid === tracker.leaderPid && !samePosixIdentity(tracker.leaderIdentity, identity)) continue
    if (identity && pid !== tracker.leaderPid) tracker.identities.set(pid, identity)
    for (const child of children.get(pid) ?? []) {
      if (child.pid === tracker.leaderPid && !samePosixIdentity(tracker.leaderIdentity, child)) {
        continue
      }
      tracker.identities.set(child.pid, child)
      stack.push(child.pid)
    }
  }
}

const sampleActiveProcessTrees = async (): Promise<PosixProcessTable> => {
  if (ownershipSampling) return ownershipSampling
  const trackers = [...activePosixProcessTrackers]
  const sampling = collectPosixProcessTable().then((table) => {
    for (const tracker of trackers) captureTrackedDescendants(tracker, table)
    return table
  })
  ownershipSampling = sampling
  try {
    return await sampling
  } finally {
    if (ownershipSampling === sampling) {
      ownershipSampling = undefined
      if (ownershipResampleRequested) {
        ownershipResampleRequested = false
        if (activePosixProcessTrackers.size > 0) {
          void sampleActiveProcessTrees().finally(scheduleTrackedProcessSample)
        }
      }
    }
  }
}

const scheduleTrackedProcessSample = (): void => {
  if (activePosixProcessTrackers.size === 0 || ownershipSampleTimer) return
  ownershipSampleTimer = setTimeout(() => {
    ownershipSampleTimer = undefined
    void sampleActiveProcessTrees().finally(scheduleTrackedProcessSample)
  }, PROCESS_OWNERSHIP_SAMPLE_MS)
  ownershipSampleTimer.unref?.()
}

export const trackOwnedPosixProcessTree = (child: ChildProcess): void => {
  if (trackedPosixProcessTrees.has(child)) return
  registerOwnedPosixProcessGroup(child)
  const leaderPid = child.pid
  if (leaderPid === undefined || !Number.isSafeInteger(leaderPid) || leaderPid <= 0) return
  const tracker: PosixProcessTracker = {
    leaderPid,
    leaderIdentity: undefined,
    identities: new Map(),
    complete: true
  }
  trackedPosixProcessTrees.set(child, tracker)
  activePosixProcessTrackers.add(tracker)
  if (ownershipSampling) ownershipResampleRequested = true
  void sampleActiveProcessTrees().finally(scheduleTrackedProcessSample)
}

const stopTrackedProcessTree = async (tracker: PosixProcessTracker): Promise<PosixProcessTable> => {
  if (ownershipSampling) await ownershipSampling
  activePosixProcessTrackers.delete(tracker)
  if (activePosixProcessTrackers.size === 0 && ownershipSampleTimer) {
    clearTimeout(ownershipSampleTimer)
    ownershipSampleTimer = undefined
  }
  const finalSample = await collectPosixProcessTable()
  captureTrackedDescendants(tracker, finalSample)
  return finalSample
}

// Descendant discovery on POSIX. Node's child.kill() signals only the immediate child, so a
// grandchild (conda, the claude CLI, a package manager) would otherwise be orphaned exactly as it would
// on Windows without taskkill /T. `ps -A -o pid=,ppid=` is available on both macOS (BSD) and Linux
// (procps). A failed snapshot is marked incomplete: we still kill the direct child, but MUST NOT report
// the whole tree reaped when we could not enumerate it.
const collectDescendantPids = (rootPid: number): Promise<DescendantSnapshot> =>
  new Promise<DescendantSnapshot>((resolve) => {
    let ps: ChildProcess
    try {
      ps = spawn('ps', ['-A', '-o', 'pid=,ppid='], { windowsHide: true })
    } catch {
      resolve({ pids: [], complete: false })
      return
    }

    let out = ''
    let settled = false
    const finish = (snapshot: DescendantSnapshot): void => {
      if (settled) return
      settled = true
      resolve(snapshot)
    }

    // A hung ps must not stall teardown; abandon it after the grace and fall back to the direct kill.
    // Created before the handlers so they can clear it (avoiding a forward reference from finish()).
    const timer = setTimeout(() => {
      try {
        ps.kill()
      } catch {
        // ps may have already exited.
      }
      finish({ pids: [], complete: false })
    }, TERMINATE_GRACE_MS)
    timer.unref?.()

    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    ps.on('error', () => {
      clearTimeout(timer)
      finish({ pids: [], complete: false })
    })
    ps.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ pids: [], complete: false })
        return
      }
      try {
        const childrenByParent = new Map<number, number[]>()
        for (const line of out.split('\n')) {
          const [pidText, ppidText] = line.trim().split(/\s+/)
          const pid = Number(pidText)
          const ppid = Number(ppidText)
          if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
          const siblings = childrenByParent.get(ppid) ?? []
          siblings.push(pid)
          childrenByParent.set(ppid, siblings)
        }

        // Depth-first walk from the root; the root itself is excluded (the caller kills it via its handle).
        const descendants: number[] = []
        const stack = [rootPid]
        while (stack.length > 0) {
          const current = stack.pop() as number
          for (const kid of childrenByParent.get(current) ?? []) {
            descendants.push(kid)
            stack.push(kid)
          }
        }
        finish({ pids: descendants, complete: true })
      } catch {
        finish({ pids: [], complete: false })
      }
    })
  })

// Windows tree teardown. taskkill /T /F reaps the whole tree in one shot; child.kill() alone would orphan
// grandchildren. If taskkill cannot be launched, errors, times out, or exits non-zero, the tree was NOT
// reaped, so we log and fall back to killing the direct child and awaiting its exit. Descendant cleanup on
// the fallback path is not possible without taskkill — an accepted platform limitation.
const terminateWindowsTree = async (
  child: ChildProcess,
  signal: NodeJS.Signals | undefined,
  log: ProcessTreeLogger | undefined
): Promise<ProcessTreeKillResult> => {
  // No pid means the process never spawned or is already gone — nothing left to reap.
  if (child.pid === undefined) return { reaped: true }

  let killer: ChildProcess
  try {
    killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } catch (error) {
    log?.error('taskkill failed to launch; falling back to direct kill', error)
    killDirectChild(child, signal)
    await waitForExit(child, TERMINATE_GRACE_MS)
    // Direct kill reaches only the parent; grandchildren may survive, so the tree is not cleanly reaped.
    return { reaped: false }
  }

  const reaped = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    // A wedged taskkill must not hang quit; abandon it after the grace and fall back. Cleared by the
    // exit/error handlers on the settle path so it never fires spuriously while the app keeps running.
    const timer = setTimeout(() => {
      log?.error('taskkill did not complete in time; falling back to direct kill')
      done(false)
    }, TERMINATE_GRACE_MS)
    timer.unref?.()
    // A non-zero exit means taskkill did not reap the tree (e.g. process not found). A null code (killed
    // by a signal) is treated as success to match prior behavior — it is vanishingly rare on Windows.
    killer.on('exit', (code) => {
      clearTimeout(timer)
      done(code === 0 || code === null)
    })
    killer.on('error', (error) => {
      clearTimeout(timer)
      log?.error('taskkill errored; falling back to direct kill', error)
      done(false)
    })
  })

  if (!reaped) {
    if (killer.exitCode !== null && killer.exitCode !== 0) {
      log?.error(`taskkill exited with code ${killer.exitCode}; falling back to direct kill`)
    }
    killDirectChild(child, signal)
    await waitForExit(child, TERMINATE_GRACE_MS)
    // The fallback direct kill cannot reach grandchildren taskkill would have reaped.
    return { reaped: false }
  }

  return { reaped: true }
}

// POSIX tree teardown. child.kill() reaches only the immediate child, so descendants are discovered via
// `ps` and signaled alongside it. The graceful signal (SIGTERM by default) is given the grace to take
// effect, then anything still alive — the child that ignored it, or a reparented grandchild — is
// escalated to SIGKILL and confirmed, so the function does not return leaving the tree running.
const terminatePosixTree = async (
  child: ChildProcess,
  signal: NodeJS.Signals | undefined,
  log: ProcessTreeLogger | undefined
): Promise<ProcessTreeKillResult> => {
  const gracefulSignal = signal ?? 'SIGTERM'
  const snapshot =
    child.pid === undefined ? { pids: [], complete: true } : await collectDescendantPids(child.pid)
  const descendants = snapshot.pids

  signalPids(descendants, gracefulSignal)
  killDirectChild(child, gracefulSignal)

  const exited = await waitForExit(child, TERMINATE_GRACE_MS)
  const survivors = descendants.filter(isProcessAlive)

  if (exited && survivors.length === 0) return { reaped: snapshot.complete }

  let childExited = exited
  if (survivors.length > 0) {
    log?.error(
      `process tree left ${survivors.length} descendant(s) alive after ${gracefulSignal}; escalating to SIGKILL`
    )
    signalPids(survivors, 'SIGKILL')
  }
  if (!exited) {
    log?.error(
      `process ${child.pid ?? '(no pid)'} did not exit after ${gracefulSignal}; escalating to SIGKILL`
    )
    forceKillChild(child)
    childExited = await waitForExit(child, SIGKILL_GRACE_MS)
  }

  // Re-check after SIGKILL: reaped only if the direct child exited and no descendant is still alive.
  return {
    reaped: snapshot.complete && childExited && descendants.filter(isProcessAlive).length === 0
  }
}

// An explicitly owned detached group is stronger identity than a live PPID relationship: it remains
// addressable after the leader exits and descendants are reparented. Signal only the recorded private
// group, never infer a group from an arbitrary child or from the application's own process state.
const terminateOwnedPosixProcessGroup = async (
  group: OwnedPosixProcessGroup,
  signal: NodeJS.Signals | undefined,
  log: ProcessTreeLogger | undefined
): Promise<ProcessTreeKillResult> => {
  const gracefulSignal = signal ?? 'SIGTERM'
  // Snapshot before signaling the leader so descendants that created their own process group/session
  // remain addressable even if the leader exits immediately. The owned group independently covers
  // same-group descendants after reparenting, when PPID discovery can no longer find them.
  const snapshot = await collectDescendantPids(group.id)
  signalProcessGroup(group.id, gracefulSignal)
  signalPids(snapshot.pids, gracefulSignal)
  const gracefulExit = await Promise.all([
    waitForProcessGroupExit(group.id, TERMINATE_GRACE_MS),
    waitForPidsExit(snapshot.pids, TERMINATE_GRACE_MS)
  ])
  if (gracefulExit.every(Boolean)) return { reaped: snapshot.complete }

  const survivors = snapshot.pids.filter(isProcessAlive)
  if (isProcessGroupAlive(group.id)) {
    log?.error(
      `owned process group ${group.id} did not exit after ${gracefulSignal}; escalating to SIGKILL`
    )
  }
  if (survivors.length > 0) {
    log?.error(
      `owned process tree left ${survivors.length} detached descendant(s) alive after ${gracefulSignal}; escalating to SIGKILL`
    )
  }
  signalProcessGroup(group.id, 'SIGKILL')
  signalPids(survivors, 'SIGKILL')
  const forcedExit = await Promise.all([
    waitForProcessGroupExit(group.id, SIGKILL_GRACE_MS),
    waitForPidsExit(snapshot.pids, SIGKILL_GRACE_MS)
  ])
  return { reaped: snapshot.complete && forcedExit.every(Boolean) }
}

const terminateTrackedPosixProcessTree = async (
  child: ChildProcess,
  tracker: PosixProcessTracker,
  signal: NodeJS.Signals | undefined,
  log: ProcessTreeLogger | undefined
): Promise<ProcessTreeKillResult> => {
  const gracefulSignal = signal ?? 'SIGTERM'
  const finalSample = await stopTrackedProcessTree(tracker)
  if (process.platform !== 'linux' || !finalSample.complete || tracker.leaderIdentity === null) {
    // The child handle is the only trustworthy identity on portable POSIX or after an incomplete
    // Linux snapshot. Kill it directly, but do not signal numeric descendant pids or groups.
    killDirectChild(child, gracefulSignal)
    if (!(await waitForExit(child, TERMINATE_GRACE_MS))) {
      log?.error(
        `process ${child.pid ?? '(no pid)'} did not exit after ${gracefulSignal}; escalating to SIGKILL`
      )
      forceKillChild(child)
      await waitForExit(child, SIGKILL_GRACE_MS)
    }
    return { reaped: false }
  }
  const live = [...tracker.identities.values()].filter((identity) =>
    samePosixIdentity(identity, finalSample.processes.get(identity.pid))
  )
  const ownedGroups = (identities: readonly PosixProcessIdentity[]): Set<number> =>
    new Set(
      identities
        .filter(({ pid, pgid, sid }) => pgid === tracker.leaderPid || (pid === pgid && pid === sid))
        .map(({ pgid }) => pgid)
    )
  for (const pgid of ownedGroups(live)) {
    signalProcessGroup(pgid, gracefulSignal)
  }
  signalPids(
    live.map(({ pid }) => pid),
    gracefulSignal
  )
  const gracefulExit = await waitForPidsExit(
    live.map(({ pid }) => pid),
    TERMINATE_GRACE_MS
  )
  if (gracefulExit) return { reaped: tracker.complete && finalSample.complete }

  const beforeForce = await collectPosixProcessTable()
  const survivors = live.filter((identity) =>
    samePosixIdentity(identity, beforeForce.processes.get(identity.pid))
  )
  if (survivors.length > 0) {
    log?.error(
      `owned process tree left ${survivors.length} exact descendant(s) alive after ${gracefulSignal}; escalating to SIGKILL`
    )
    for (const pgid of ownedGroups(survivors)) {
      signalProcessGroup(pgid, 'SIGKILL')
    }
    signalPids(
      survivors.map(({ pid }) => pid),
      'SIGKILL'
    )
  }
  const forcedExit = await waitForPidsExit(
    survivors.map(({ pid }) => pid),
    SIGKILL_GRACE_MS
  )
  return {
    reaped: tracker.complete && finalSample.complete && beforeForce.complete && forcedExit
  }
}

// Terminates a child process and every descendant it spawned, then waits for the direct child to actually
// exit — escalating to SIGKILL anything still alive. On Windows the tree is reaped with taskkill /T /F
// (with a direct-kill fallback); on POSIX descendants are found via `ps`, signaled, and SIGKILL-escalated.
// Returns { reaped } so a caller that must guarantee released handles can tell a clean tree teardown
// from a degraded fallback. This never rejects: any failure resolves (reaped:false) so a kill can never
// surface into the caller (before-quit -> app.exit).
export const terminateProcessTree = async (
  child: ChildProcess,
  signal?: NodeJS.Signals,
  log?: ProcessTreeLogger
): Promise<ProcessTreeKillResult> => {
  if (process.platform === 'win32') {
    return terminateWindowsTree(child, signal, log)
  }
  const ownedGroup = ownedPosixProcessGroups.get(child)
  const trackedTree = trackedPosixProcessTrees.get(child)
  if (trackedTree) return terminateTrackedPosixProcessTree(child, trackedTree, signal, log)
  if (ownedGroup) return terminateOwnedPosixProcessGroup(ownedGroup, signal, log)
  return terminatePosixTree(child, signal, log)
}
