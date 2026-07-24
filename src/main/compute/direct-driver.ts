// Direct SSH compute driver (design.md §4.2) — the first `ComputeDriver` implementation.
//
// This driver owns the remote execution mechanics that used to live inline in job-dispatcher.ts and
// job-poller.ts: building the launcher script, base64-transferring it, launching a detached process
// (nohup + setsid), observing process liveness + exit_code + stdout/stderr tails in a batched SSH
// round-trip, and cancelling via the process group. It does NOT own approval, staging, harvest,
// notifications, or status transitions — shared orchestration does (design.md §3 invariant 2).
//
// The detached-process behavior is preserved byte-for-byte from the pre-refactor Direct path: same
// launcher script, same dispatch SSH command, same nonce-prefixed batched poll format, same 64 KiB
// tail cap, same timeout grace, same exit-137 timeout/OOM disambiguation input. This is the frozen
// seam Issue 03's Slurm driver consumes alongside.

import { randomBytes } from 'node:crypto'

import type {
  ComputeDriver,
  DispatchContext,
  DriverContext,
  DriverHandle,
  DriverJob,
  PollManyResult,
  RemoteObservation
} from './compute-driver'
import type { SshRunner } from './ssh-runner'
import { buildLauncherScript, quoteRemotePath, toBase64 } from './job-dispatcher'

// Maximum bytes for the per-job dispatch SSH command (enough for base64 of large scripts).
const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024

// Timeout for the dispatch SSH connection (mkdir + write files + launch). Generous to accommodate
// slow cluster file systems; the job itself runs detached so the connection can close after.
const DISPATCH_TIMEOUT_MS = 120_000

// Maximum bytes to capture per stream tail (64 KiB per design.md §8).
const TAIL_MAX_BYTES = 65536

// Per-job output budget for a poll: two tails (stdout+stderr) plus marker/pid/exit-code lines.
// The 1 KiB pad covers the seven nonce-prefixed marker lines and the exit-code/alive output.
const PER_JOB_POLL_BYTES = TAIL_MAX_BYTES * 2 + 1024

// Timeout for the per-batch poll SSH command.
const POLL_TIMEOUT_MS = 30_000

// Maximum jobs polled in a single SSH round-trip. Bounds peak memory per call
// (~POLL_BATCH_MAX_JOBS × PER_JOB_POLL_BYTES ≈ 1 MiB) while guaranteeing every job's section fits.
const POLL_BATCH_MAX_JOBS = 8

// Dependency interface. Tests inject a fake SshRunner and a deterministic nonce generator; production
// wires the SystemSshRunner and a random per-tick nonce.
export type DirectDriverDeps = {
  runner: SshRunner
  // Injectable nonce generator (defaults to a random per-tick hex string). The nonce prefixes every
  // structural marker so adversarial job tail content cannot collide with section/field markers.
  makeNonce?: () => string
}

// Direct SSH driver. See module docstring. Registered under kind 'direct'.
export class DirectDriver implements ComputeDriver {
  readonly kind = 'direct' as const
  private readonly runner: SshRunner
  private readonly makeNonceFn: () => string

  constructor(deps: DirectDriverDeps) {
    this.runner = deps.runner
    this.makeNonceFn = deps.makeNonce ?? (() => randomBytes(12).toString('hex') + '_')
  }

  // Launches the detached remote process and returns a versioned direct handle. Mirrors the
  // pre-refactor dispatch command exactly so the remote workdir layout is unchanged for legacy rows.
  async dispatch(context: DispatchContext): Promise<DriverHandle> {
    const { target, workdir, command, timeoutSeconds } = context
    if (!target) throw new Error('DirectDriver.dispatch requires a resolved SSH target')

    const launcherScript = buildLauncherScript(timeoutSeconds)
    const commandB64 = toBase64(command)
    const launcherB64 = toBase64(launcherScript)

    const quotedWorkdir = quoteRemotePath(workdir)
    // One SSH command: mkdir workdir, write scripts via base64 pipes, launch detached, echo pid.
    const dispatchCmd = [
      `mkdir -p ${quotedWorkdir}`,
      `cd ${quotedWorkdir}`,
      `printf '%s' ${JSON.stringify(commandB64)} | base64 -d > command.sh`,
      `printf '%s' ${JSON.stringify(launcherB64)} | base64 -d > launcher.sh`,
      `chmod +x command.sh launcher.sh`,
      // Detached launch: nohup + setsid so the process survives SSH disconnect.
      `nohup setsid bash launcher.sh >/dev/null 2>&1 &`,
      // Write pid to file AND echo it so we can read it back in this round-trip.
      `LAUNCHED_PID=$!`,
      `echo $LAUNCHED_PID > job.pid`,
      `echo $LAUNCHED_PID`
    ].join('\n')

    const runResult = await this.runner.run(target, dispatchCmd, {
      timeoutMs: DISPATCH_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
    })

    // The dispatcher maps these into job status; the driver surfaces them as a thrown error so the
    // shared layer records the right error_code (host_unreachable vs dispatch_failed).
    if (runResult.timedOut || runResult.exitCode === 255) {
      const tail = runResult.stderr || 'SSH connection failed'
      throw new DirectDispatchError('host_unreachable', tail)
    }
    if (runResult.exitCode !== 0) {
      const tail = runResult.stderr || `exit code ${runResult.exitCode ?? 'null'}`
      throw new DirectDispatchError('dispatch_failed', tail)
    }

    const pid = Number.parseInt(runResult.stdout.trim().split('\n').pop() ?? '', 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new DirectDispatchError(
        'dispatch_failed',
        `Could not read pid from dispatch output: ${JSON.stringify(runResult.stdout)}`
      )
    }

    // Versioned direct handle (design.md §4.3). pgid defaults to pid (setsid puts the child in its
    // own process group whose id equals the child pid), so process-group cancellation can target it.
    return {
      version: 1,
      driver: 'direct',
      pid,
      pgid: pid,
      paths: {
        workdir,
        stdout: `${workdir}/stdout`,
        stderr: `${workdir}/stderr`,
        exitCode: `${workdir}/exit_code`
      }
    }
  }

  // Observes a batch of direct jobs in as few SSH round-trips as practical, parsing the
  // nonce-prefixed output into per-job observations. Connectivity failures become `unreachable` so
  // the poller can record lastPollError WITHOUT flipping status (design.md §8 boundary 2).
  async pollMany(context: DriverContext, jobs: DriverJob[]): Promise<PollManyResult> {
    const { target } = context
    if (!target) return { kind: 'unreachable', message: 'no SSH target' }
    if (jobs.length === 0) return { kind: 'ok', observations: new Map() }

    const observations = new Map<string, RemoteObservation>()
    const errors = new Map<string, string>()

    // Poll in sub-batches so the SSH output cap always fits every job's section. Batches run
    // sequentially to reuse one connection and avoid a fan-out of concurrent ssh processes.
    for (let i = 0; i < jobs.length; i += POLL_BATCH_MAX_JOBS) {
      const batch = jobs.slice(i, i + POLL_BATCH_MAX_JOBS)
      const result = await this._pollBatch(target, batch)
      if (result.kind === 'unreachable') {
        // This sub-batch could not reach the host. Record a per-job transient error so the poller
        // stamps lastPollError WITHOUT flipping status (design.md §8 boundary 2). Continue so a
        // later sub-batch on a momentarily-recovered connection can still observe its jobs.
        for (const job of batch) errors.set(job.jobId, result.message)
        continue
      }
      for (const [jobId, obs] of result.observations) observations.set(jobId, obs)
    }

    // If every job is unreachable (no observations, all errored) report a whole-batch unreachable so
    // the poller can short-circuit its per-job handling; otherwise surface the partial result.
    if (observations.size === 0 && errors.size > 0) {
      return { kind: 'unreachable', message: errors.values().next().value ?? 'SSH unreachable' }
    }

    return errors.size > 0
      ? { kind: 'ok', observations, errors }
      : { kind: 'ok', observations }
  }

  // Polls one sub-batch in a single SSH round-trip (the original pre-refactor batched format).
  private async _pollBatch(
    target: import('./ssh-runner').ResolvedSshTarget,
    jobs: DriverJob[]
  ): Promise<PollManyResult> {
    const nonce = this.makeNonceFn()

    // Build per-job check commands, batched into one SSH round-trip (same format as pre-refactor).
    const parts: string[] = []
    const batched: DriverJob[] = []
    for (const job of jobs) {
      // The Direct driver only polls direct-v1 / legacy-direct handles (both carry a pid + paths).
      // A slurm-v1 handle routed here is a misconfiguration; skip it so it stays non-terminal.
      if (job.handle.kind === 'slurm-v1') continue
      const pid = job.handle.pid
      const { stdout, stderr, exitCode } = job.handle.paths
      if (pid === undefined) continue
      batched.push(job)

      parts.push(
        `echo "${nonce}JOB_START:${job.jobId}"`,
        `kill -0 ${pid} 2>/dev/null && echo "${nonce}alive:1" || echo "${nonce}alive:0"`,
        `if [ -f ${quoteRemotePath(exitCode)} ]; then cat ${quoteRemotePath(exitCode)}; else echo ""; fi`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(stdout)} 2>/dev/null || true`,
        `echo "${nonce}STDOUT_END:${job.jobId}"`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(stderr)} 2>/dev/null || true`,
        `echo "${nonce}STDERR_END:${job.jobId}"`
      )
    }

    if (parts.length === 0) return { kind: 'ok', observations: new Map() }

    const maxOutputBytes = batched.length * PER_JOB_POLL_BYTES
    const pollCmd = parts.join('\n')
    let runResult
    try {
      runResult = await this.runner.run(target, pollCmd, {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { kind: 'unreachable', message: msg }
    }

    if (runResult.timedOut || runResult.exitCode === 255) {
      const msg =
        runResult.stderr || (runResult.timedOut ? 'SSH connection timed out' : 'SSH exit 255')
      return { kind: 'unreachable', message: msg }
    }

    return { kind: 'ok', observations: this._parsePollOutput(runResult.stdout, batched, nonce) }
  }

  // Parses the batched nonce-prefixed output into per-job observations (same parsing the
  // pre-refactor poller used, lifted verbatim so behavior is preserved).
  private _parsePollOutput(
    output: string,
    jobs: DriverJob[],
    nonce: string
  ): Map<string, RemoteObservation> {
    const observations = new Map<string, RemoteObservation>()
    const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sections = output.split(new RegExp(`^${escapedNonce}JOB_START:`, 'm'))

    for (const section of sections) {
      if (!section.trim()) continue
      const firstNewline = section.indexOf('\n')
      if (firstNewline === -1) continue
      const jobId = section.slice(0, firstNewline).trim()
      const body = section.slice(firstNewline + 1)

      const job = jobs.find((j) => j.jobId === jobId)
      if (!job) continue

      const aliveMatch = body.match(new RegExp(`^${escapedNonce}alive:([01])`, 'm'))
      const alive = aliveMatch?.[1] === '1'

      const alivePrefix = `${nonce}alive:`
      const lines = body.split('\n')
      let exitCodeRaw = ''
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.startsWith(alivePrefix)) {
          exitCodeRaw = lines[i + 1]?.trim() ?? ''
          break
        }
      }
      const exitCode = exitCodeRaw.trim() === '' ? null : Number.parseInt(exitCodeRaw.trim(), 10)
      const hasExitCode = exitCode !== null && Number.isFinite(exitCode)

      const stdoutEndMarker = `${nonce}STDOUT_END:${jobId}`
      const stderrEndMarker = `${nonce}STDERR_END:${jobId}`
      const stdoutStart = body.indexOf('\n', body.indexOf('\n', body.indexOf('\n') + 1) + 1) + 1
      const stdoutEnd = body.indexOf(stdoutEndMarker)
      const stdoutTail =
        stdoutEnd > stdoutStart ? body.slice(stdoutStart, stdoutEnd).replace(/\n$/, '') : ''

      const stderrStart = body.indexOf('\n', stdoutEnd + stdoutEndMarker.length) + 1
      const stderrEnd = body.indexOf(stderrEndMarker)
      const stderrTail =
        stderrEnd > stderrStart ? body.slice(stderrStart, stderrEnd).replace(/\n$/, '') : ''

      observations.set(jobId, { alive, exitCode, hasExitCode, stdoutTail, stderrTail })
    }

    return observations
  }

  // Cancels a launched direct job by killing its process group (setsid makes pgid == pid). This is
  // the testable process-group cancel semantics (acceptance criterion); the user-facing cancel button
  // is a later issue (Issue 04). Best-effort: swallows connectivity errors so a failing cancel cannot
  // wedge a terminal transition.
  async cancel(context: DriverContext, handle: DriverHandle): Promise<void> {
    const { target } = context
    if (!target) return
    if (handle.driver !== 'direct') return // not a direct handle — nothing for this driver to do
    const pgid = handle.pgid ?? handle.pid
    try {
      await this.runner.run(
        target,
        `kill -- -${pgid} 2>/dev/null; kill -9 -${pgid} 2>/dev/null; true`,
        { timeoutMs: 10_000, loginShell: false, maxOutputBytes: 64 }
      )
    } catch {
      // Best-effort: a failing cancel (host down) must not propagate.
    }
  }
}

// A structured dispatch failure so the shared dispatcher can map it to the right error_code without
// the driver knowing about job status. `code` is the job error_code; `detail` becomes stderrTail.
export class DirectDispatchError extends Error {
  constructor(
    readonly code: 'host_unreachable' | 'dispatch_failed',
    readonly detail: string
  ) {
    super(detail)
    this.name = 'DirectDispatchError'
  }
}

// (No unreachable sentinel observation: an unreachable job is reported via `PollManyResult.errors`
// / `kind: 'unreachable'`, and the poller records lastPollError + flips NO status itself.)
