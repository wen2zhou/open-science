// Slurm compute driver (design.md §4.2, §4.4, §4.5).
//
// Owns ONLY the remote Slurm mechanics:
//   - dispatch: validate the script's leading #SBATCH block against structured resources, build an
//     sbatch wrapper, submit via `sbatch --parsable`, parse the scheduler job id, return a slurm-v1
//     handle. Directive/reserved-key rejection happens HERE, before any SSH (design.md §4.5).
//   - pollMany: one `squeue` call for active jobs, one `sacct` call for jobs that left the queue, with
//     accounting-delay tolerance (a job absent from both stays non-terminal). Tails are read from the
//     per-job workdir. Connectivity failure becomes `unreachable` (host down != job failed).
//   - cancel: `scancel <id>`, best-effort.
//
// It does NOT own approval, staging, harvest, notifications, or status transitions — shared
// orchestration does (design.md §3 invariant 2). The state mapping PENDING→submitted / RUNNING→running
// is performed by the poller from `RemoteObservation` (alive/exitCode + remoteState); this driver only
// reports scheduler-native state.

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
import { quoteRemotePath, toBase64 } from './job-dispatcher'
import { buildSbatchWrapper } from './slurm-wrapper'
import { parseAllowedDirectives } from './slurm-directives'

// Output cap for sbatch submission (the job id is short).
const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024
const DISPATCH_TIMEOUT_MS = 120_000

// Polling output cap per job (two tails + state lines).
const TAIL_MAX_BYTES = 65536
const PER_JOB_POLL_BYTES = TAIL_MAX_BYTES * 2 + 1024
const POLL_TIMEOUT_MS = 30_000

const CANCEL_TIMEOUT_MS = 10_000

// A structured dispatch failure (mirrors DirectDispatchError). `code` is the job error_code.
export class SlurmDispatchError extends Error {
  constructor(
    readonly code: 'host_unreachable' | 'dispatch_failed' | 'invalid_directives',
    readonly detail: string
  ) {
    super(detail)
    this.name = 'SlurmDispatchError'
  }
}

export type SlurmDriverDeps = {
  runner: SshRunner
  makeNonce?: () => string
}

// A DriverJob whose parsed handle is known to be the slurm-v1 variant (so `schedulerJobId` is
// accessible without a cast). Produced by the `isSlurmJob` type guard below.
type SlurmDriverJob = DriverJob & { handle: Extract<DriverJob['handle'], { kind: 'slurm-v1' }> }

// Type guard: narrows a DriverJob to one whose parsed handle is the slurm-v1 variant (so callers can
// access `schedulerJobId` without a cast). Mirrors the discriminated-union narrowing on `kind`.
const isSlurmJob = (job: DriverJob): job is SlurmDriverJob => job.handle.kind === 'slurm-v1'

export class SlurmDriver implements ComputeDriver {
  readonly kind = 'slurm' as const
  private readonly runner: SshRunner
  private readonly makeNonceFn: () => string

  constructor(deps: SlurmDriverDeps) {
    this.runner = deps.runner
    this.makeNonceFn = deps.makeNonce ?? (() => randomBytes(12).toString('hex') + '_')
  }

  async dispatch(context: DispatchContext): Promise<DriverHandle> {
    const { target, workdir, command, timeoutSeconds, jobId, resources } = context
    if (!target) throw new Error('SlurmDriver.dispatch requires a resolved SSH target')

    // Validate the script's leading directive block BEFORE any SSH (design.md §4.5). Reserved keys and
    // keys conflicting with structured resources are rejected here with a structured error.
    const directiveCheck = parseAllowedDirectives(command, resources)
    if (!directiveCheck.ok) {
      throw new SlurmDispatchError('invalid_directives', directiveCheck.reason)
    }

    const wrapper = buildSbatchWrapper({
      command,
      timeoutSeconds,
      resources,
      allowedDirectives: directiveCheck.directives,
      jobName: `openscience-${jobId.slice(0, 8)}`
    })
    const wrapperB64 = toBase64(wrapper)

    const quotedWorkdir = quoteRemotePath(workdir)
    // One SSH command: mkdir workdir, write the sbatch wrapper via base64, submit with --parsable.
    const submitCmd = [
      `mkdir -p ${quotedWorkdir}`,
      `cd ${quotedWorkdir}`,
      `printf '%s' ${JSON.stringify(wrapperB64)} | base64 -d > job.sbatch`,
      `sbatch --parsable job.sbatch`
    ].join('\n')

    let runResult
    try {
      runResult = await this.runner.run(target, submitCmd, {
        timeoutMs: DISPATCH_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
      })
    } catch (err) {
      const tail = err instanceof Error ? err.message : String(err)
      throw new SlurmDispatchError('host_unreachable', tail)
    }

    if (runResult.timedOut || runResult.exitCode === 255) {
      throw new SlurmDispatchError('host_unreachable', runResult.stderr || 'SSH connection failed')
    }
    if (runResult.exitCode !== 0) {
      throw new SlurmDispatchError(
        'dispatch_failed',
        runResult.stderr || `exit code ${runResult.exitCode ?? 'null'}`
      )
    }

    const schedulerJobId = parseSbatchJobId(runResult.stdout)
    if (!schedulerJobId) {
      throw new SlurmDispatchError(
        'dispatch_failed',
        `Could not parse sbatch job id from output: ${JSON.stringify(runResult.stdout)}`
      )
    }

    return {
      version: 1,
      driver: 'slurm',
      schedulerJobId,
      paths: {
        workdir,
        stdout: `${workdir}/stdout`,
        stderr: `${workdir}/stderr`,
        exitCode: `${workdir}/exit_code`
      }
    }
  }

  async pollMany(context: DriverContext, jobs: DriverJob[]): Promise<PollManyResult> {
    const { target } = context
    if (!target) return { kind: 'unreachable', message: 'no SSH target' }
    if (jobs.length === 0) return { kind: 'ok', observations: new Map() }

    // Slurm jobs only. (A direct handle routed here is a misconfiguration; skip it.) The type guard
    // narrows the parsed handle to the slurm-v1 variant so schedulerJobId is accessible below.
    const slurmJobs = jobs.filter(isSlurmJob)
    if (slurmJobs.length === 0) return { kind: 'ok', observations: new Map() }

    const observations = new Map<string, RemoteObservation>()

    // Step 1: squeue for active jobs (one call). Format: JobID|State|Reason (--noheader, parsable2).
    const ids = slurmJobs.map((j) => j.handle.schedulerJobId)
    const idList = ids.join(',')
    const squeueCmd = [
      `squeue --noheader --states=all --parsable2 -j ${shellToken(idList)} ` +
        `--format='%i|%T|%r' 2>/dev/null || true`
    ].join('\n')

    let squeueResult
    try {
      squeueResult = await this.runner.run(target, squeueCmd, {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: slurmJobs.length * PER_JOB_POLL_BYTES
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { kind: 'unreachable', message: msg }
    }
    if (squeueResult.timedOut || squeueResult.exitCode === 255) {
      return { kind: 'unreachable', message: squeueResult.stderr || 'SSH unreachable' }
    }

    // Parse active jobs. Map schedulerJobId → {state, reason}.
    const active = new Map<string, { state: string; reason: string }>()
    for (const line of squeueResult.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [sid, state, reason] = trimmed.split('|')
      if (!sid || !state) continue
      active.set(sid, { state, reason: reason ?? '' })
    }

    // Jobs still in the queue: map to alive/non-terminal observations.
    const terminalCandidates: SlurmDriverJob[] = []
    for (const job of slurmJobs) {
      const sid = job.handle.schedulerJobId
      const a = active.get(sid)
      if (!a) {
        // Not in squeue → possibly terminal. Confirm via sacct.
        terminalCandidates.push(job)
        continue
      }
      observations.set(job.jobId, this._observeActive(sid, a.state, a.reason))
    }

    // Step 2: sacct for jobs that left the queue (accounting-delay tolerant). If sacct has no record,
    // the job is left unobserved (non-terminal) and re-polled next tick.
    if (terminalCandidates.length > 0) {
      const termIds = terminalCandidates.map((j) => j.handle.schedulerJobId).join(',')
      const sacctCmd = [
        `sacct --parsable2 --noheader -j ${shellToken(termIds)} ` +
          `--format=JobIDRaw,State,ExitCode 2>/dev/null || true`
      ].join('\n')
      const sacctResult = await this.runner.run(target, sacctCmd, {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: terminalCandidates.length * PER_JOB_POLL_BYTES
      })

      // sacct JobIDRaw avoids array-task suffixes; map raw id → {state, exit}.
      const termByRaw = new Map<string, { state: string; exit: number }>()
      if (sacctResult.exitCode === 0) {
        for (const line of sacctResult.stdout.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const [rawId, state, exitStr] = trimmed.split('|')
          if (!rawId || !state) continue
          // ExitCode is "code:signal" (e.g. "0:0", "1:0", "0:9"). Take the code portion.
          const code = Number.parseInt((exitStr ?? '').split(':')[0] ?? '', 10)
          // Keep the first row per raw id (the parent job row, not .batch/.ext).
          if (!termByRaw.has(rawId)) {
            termByRaw.set(rawId, { state, exit: Number.isFinite(code) ? code : 0 })
          }
        }
      }

      // Read tails for terminal jobs in one batched call (nonce-prefixed, like the Direct driver).
      const observedTerminal = terminalCandidates.filter((j) =>
        termByRaw.has(j.handle.schedulerJobId)
      )
      const tails =
        observedTerminal.length > 0 ? await this._readTails(target, observedTerminal) : new Map()

      for (const job of terminalCandidates) {
        const sid = job.handle.schedulerJobId
        const t = termByRaw.get(sid)
        if (!t) continue // accounting delay — leave non-terminal (not observed this tick)
        const tail = tails.get(job.jobId)
        observations.set(job.jobId, {
          alive: false,
          exitCode: t.exit,
          hasExitCode: true,
          stdoutTail: tail?.stdout ?? '',
          stderrTail: tail?.stderr ?? '',
          remoteState: t.state,
          schedulerDiagnostic: this._diagnosticFor(t.state)
        })
      }
    }

    return { kind: 'ok', observations }
  }

  // Maps an active (in-queue) job to a non-terminal observation. PENDING/RUNNING etc. are alive; the
  // poller derives `submitted` (PENDING) vs `running` (RUNNING) from remoteState.
  private _observeActive(schedulerJobId: string, state: string, reason: string): RemoteObservation {
    void schedulerJobId
    return {
      alive: true,
      exitCode: null,
      hasExitCode: false,
      stdoutTail: '',
      stderrTail: '',
      remoteState: state,
      queueReason: reason || undefined
    }
  }

  // Reads the bounded stdout/stderr tails for a set of terminal jobs in one batched SSH call.
  // Nonce-prefixed sectioning (same defensive pattern as the Direct driver) so adversarial log content
  // cannot collide with the markers.
  private async _readTails(
    target: import('./ssh-runner').ResolvedSshTarget,
    jobs: DriverJob[]
  ): Promise<Map<string, { stdout: string; stderr: string }>> {
    const nonce = this.makeNonceFn()
    const parts: string[] = []
    for (const job of jobs) {
      const { stdout, stderr } = job.handle.paths
      parts.push(
        `echo "${nonce}TAIL_START:${job.jobId}"`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(stdout)} 2>/dev/null || true`,
        `echo "${nonce}STDOUT_END:${job.jobId}"`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(stderr)} 2>/dev/null || true`,
        `echo "${nonce}STDERR_END:${job.jobId}"`
      )
    }
    const result = await this.runner.run(target, parts.join('\n'), {
      timeoutMs: POLL_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: jobs.length * PER_JOB_POLL_BYTES
    })
    return this._parseTails(result.stdout, jobs, nonce)
  }

  private _parseTails(
    output: string,
    jobs: DriverJob[],
    nonce: string
  ): Map<string, { stdout: string; stderr: string }> {
    const out = new Map<string, { stdout: string; stderr: string }>()
    const esc = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sections = output.split(new RegExp(`^${esc}TAIL_START:`, 'm'))
    for (const section of sections) {
      if (!section.trim()) continue
      const nl = section.indexOf('\n')
      if (nl === -1) continue
      const jobId = section.slice(0, nl).trim()
      const body = section.slice(nl + 1)
      const job = jobs.find((j) => j.jobId === jobId)
      if (!job) continue
      const stdoutEnd = `${nonce}STDOUT_END:${jobId}`
      const stderrEnd = `${nonce}STDERR_END:${jobId}`
      const stdoutEndIdx = body.indexOf(stdoutEnd)
      const stdoutTail = stdoutEndIdx >= 0 ? body.slice(0, stdoutEndIdx).replace(/\n$/, '') : ''
      const stderrStart = body.indexOf('\n', stdoutEndIdx + stdoutEnd.length) + 1
      const stderrEndIdx = body.indexOf(stderrEnd)
      const stderrTail =
        stderrEndIdx >= stderrStart ? body.slice(stderrStart, stderrEndIdx).replace(/\n$/, '') : ''
      out.set(jobId, { stdout: stdoutTail, stderr: stderrTail })
    }
    return out
  }

  private _diagnosticFor(state: string): string | undefined {
    if (state === 'OUT_OF_MEMORY') return 'Slurm reported OUT_OF_MEMORY'
    if (state === 'TIMEOUT') return 'Slurm reported TIMEOUT (walltime exceeded)'
    if (state === 'NODE_FAIL') return 'Slurm reported NODE_FAIL'
    if (state === 'PREEMPTED') return 'Slurm reported PREEMPTED'
    return undefined
  }

  async cancel(context: DriverContext, handle: DriverHandle): Promise<void> {
    const { target } = context
    if (!target) return
    if (handle.driver !== 'slurm') return
    try {
      await this.runner.run(
        target,
        `scancel ${shellToken(handle.schedulerJobId)} 2>/dev/null || true`,
        {
          timeoutMs: CANCEL_TIMEOUT_MS,
          loginShell: false,
          maxOutputBytes: 64
        }
      )
    } catch {
      // Best-effort: a failing cancel (host down) must not wedge a terminal transition.
    }
  }
}

// Parses sbatch --parsable output (a bare job id, possibly with an array-task suffix) or the default
// "Submitted batch job N" line. Returns the base job id (array suffix stripped) or undefined.
export const parseSbatchJobId = (output: string): string | undefined => {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  // --parsable: bare integer or integer_task
  const parsable = trimmed.match(/^(\d+)(?:_\d+)?$/)
  if (parsable) return parsable[1]
  // Default human line: "Submitted batch job 12345"
  const human = trimmed.match(/Submitted batch job (\d+)/)
  if (human) return human[1]
  // Last line might be the id when sbatch prints warnings first.
  for (const line of trimmed.split('\n').reverse()) {
    const m = line.trim().match(/^(\d+)(?:_\d+)?$/)
    if (m) return m[1]
  }
  return undefined
}

// A safe single-token: only digits (job ids are numeric). This guards the interpolated id list / id
// against injection even though scheduler job ids come from sbatch output we parsed as numeric.
const shellToken = (s: string): string => {
  if (!/^\d+(,\d+)*$/.test(s)) {
    // Fallback: quote defensively for a lone numeric id with unexpected chars (shouldn't happen).
    return `'${s.replace(/'/g, "'\\''")}'`
  }
  return s
}
