// NON-PRODUCTION PBS/LSF command-output parsers and state mapping (design.md §11, Issue 07).
//
// V1 ships ONLY Direct and Slurm as executable backends. PBS and LSF are explicitly OUT OF SCOPE for
// production submission (design.md §2, PRD "范围与发布边界"). This module exists so a future PBS/LSF
// adapter has a contract to conform to, AND so the cross-provider state mapping is documented and
// fixture-tested TODAY without a freely available production-equivalent cluster (LSF especially has no
// freely testable equivalent; OpenPBS gets end-to-end coverage later).
//
// What this module DOES:
//   - Parse `qsub` / `bsub` submit output into a scheduler job id (handle shape a future driver returns).
//   - Parse `qstat` / `bjobs` active-query output into per-job active state + reason.
//   - Parse `qstat -x` / `bjobs -l`/`bhist`-style accounting rows into a terminal state + exit code.
//   - Map the provider-native state names onto the FROZEN cross-provider observation shape the poller's
//     state machine already consumes (`RemoteObservation.remoteState` + `alive`/`exitCode`), so the
//     poller's state mapping PENDING→submitted / RUNNING→running / COMPLETED→success works unchanged.
//
// What this module DOES NOT do:
//   - Submit, cancel, or observe a real job. There is NO `PbsDriver` / `LsfDriver` registered in the
//     `ComputeDriverRegistry`, and `_resolveDriver` rejects PBS/LSF-detected hosts with a structured
//     error (design.md §3 invariant 7). The fixtures here cannot change backend selection.
//
// All parsers are deliberately tolerant: they return `undefined` for an unrecognized row (the future
// adapter/poller treats that as "accounting delay — keep non-terminal"), exactly like the Slurm driver's
// squeue/sacct handling. They never throw on malformed output.

import type { RemoteObservation } from './compute-driver'

// The provider kinds this module covers. Kept narrow so the registry/`_resolveDriver` stays the single
// authority on which backends are executable.
export type PbsLsfKind = 'pbs' | 'lsf'

// ---------------------------------------------------------------------------
// PBS (qsub / qstat / qdel)
// ---------------------------------------------------------------------------

// `qsub` prints a bare job id (e.g. "1234567.gpuserver01"). OpenPBS ids carry an optional ".<server>"
// suffix; Torque ids are bare numerics. We keep the full token as the scheduler job id and let the
// future driver decide whether to strip the server suffix.
export const parseQsubJobId = (output: string): string | undefined => {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  // First whitespace-free token of the last non-empty line.
  for (const line of trimmed.split('\n').reverse()) {
    const tok = line.trim()
    if (!tok) continue
    // qsub ids: digits optionally followed by .<server-name>. Reject anything with shell metacharacters.
    const m = tok.match(/^(\d+(?:\.[A-Za-z0-9_.-]+)?)/)
    if (m) return m[1]
  }
  return undefined
}

// `qstat` (OpenPBS) default table columns include a 2-char "S" state column. This maps the documented
// OpenPBS/Torque single-letter states to the cross-provider `alive`/terminal signal the poller needs.
//
// OpenPBS job states (man qstat): Q queued, H held, W waiting, R running, T transitioning, S suspended,
// E exiting, C complete/deleted/failed.
const PBS_ACTIVE_STATE = new Set(['Q', 'H', 'W', 'R', 'T', 'S'])
const PBS_TERMINAL_STATE = new Set(['E', 'C'])

// Parses one `qstat -f`/`qstat` line into {state, reason}. Returns undefined when the row does not carry
// a recognizable active PBS state (so the caller keeps the job non-terminal — accounting-delay tolerant).
export type PbsActiveRow = { schedulerJobId: string; state: string; reason?: string }

export const parseQstatLine = (line: string): PbsActiveRow | undefined => {
  // Parsable default-table row: "<job id>  <name>  <user>  <time>  <S> <queue>" — the 5th whitespace field
  // is the single-letter state. We do NOT hardcode column offsets (PBS varies); we find the S column by
  // matching a known single-letter state token.
  const fields = line.trim().split(/\s+/)
  if (fields.length < 5) return undefined
  const jobId = fields[0]
  if (!/^\d+(\.[A-Za-z0-9_.-]+)?$/.test(jobId)) return undefined
  const stateIdx = fields.findIndex((f, i) => i > 0 && PBS_ACTIVE_STATE.has(f))
  if (stateIdx <= 0) return undefined
  return { schedulerJobId: jobId, state: fields[stateIdx]!, reason: fields[fields.length - 1] }
}

// `qstat -x -f` (OpenPBS) exposes "job_state = C" plus "Exit_status = N" and "ctime"/"stime"/"mtime".
// `qstat -x` table mode prints a state column + (for Torque) "Exit_status". This parser extracts a
// terminal observation from a key=value block (the most portable form).
export type PbsTerminalRow = { state: string; exit: number }

export const parsePbsTerminalBlock = (block: string): PbsTerminalRow | undefined => {
  const stateMatch = block.match(/job_state\s*=\s*(\S+)/)
  const exitMatch = block.match(/Exit_status\s*=\s*(-?\d+)/)
  if (!stateMatch) return undefined
  const state = stateMatch[1]!
  if (!PBS_TERMINAL_STATE.has(state) && state !== 'F') return undefined // not terminal
  const exit = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : 0
  return { state, exit: Number.isFinite(exit) ? exit : 0 }
}

// Maps a parsed PBS state (active or terminal) onto the frozen RemoteObservation shape. The poller derives
// application status from `alive`/`exitCode`/`hasExitCode` exactly as it does for Slurm; the native PBS
// state rides along in `remoteState` (design.md §4.4 — provider names never leak into the state machine).
export const pbsStateToObservation = (
  active: PbsActiveRow | undefined,
  terminal: PbsTerminalRow | undefined
): RemoteObservation | undefined => {
  if (terminal) {
    return {
      alive: false,
      exitCode: terminal.exit,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: '',
      remoteState: terminal.state,
      schedulerDiagnostic: pbsDiagnosticFor(terminal.state)
    }
  }
  if (active) {
    return {
      alive: true,
      exitCode: null,
      hasExitCode: false,
      stdoutTail: '',
      stderrTail: '',
      remoteState: active.state,
      queueReason: active.reason
    }
  }
  return undefined
}

const pbsDiagnosticFor = (state: string): string | undefined => {
  if (state === 'F') return 'PBS job failed (non-zero Exit_status)'
  return undefined
}

// ---------------------------------------------------------------------------
// LSF (bsub / bjobs / bkill)
// ---------------------------------------------------------------------------

// `bsub` prints "Job <1234567> is submitted to queue <normal>." on success. Extract the bare numeric id.
export const parseBsubJobId = (output: string): string | undefined => {
  const m = output.match(/Job\s+<(\d+)>/i)
  return m ? m[1] : undefined
}

// `bjobs` (LSF) prints a table: JOBID USER STAT QUEUE ... The STAT column is a short token (UNDONE/PSUSP
// are multi-char; RUN/PEND are common). Documented LSF STAT values: PEND, RUN, USUSP, SSUSP, PSUSP, WAIT,
// DONE, EXIT, UNKWN, ZOMBI, FOUND, SKIPPED.
const LSF_ACTIVE_STATE = new Set(['PEND', 'RUN', 'USUSP', 'SSUSP', 'PSUSP', 'WAIT', 'PROV'])
const LSF_TERMINAL_STATE = new Set(['DONE', 'EXIT', 'ZOMBI', 'SKIPPED'])

export type LsfActiveRow = { schedulerJobId: string; state: string; reason?: string }

export const parseBjobsLine = (line: string): LsfActiveRow | undefined => {
  const fields = line.trim().split(/\s+/)
  if (fields.length < 3) return undefined
  const jobId = fields[0]
  if (!/^\d+$/.test(jobId)) return undefined
  // bjobs default: JOBID USER STAT QUEUE FROM_HOST EXEC_HOST JOB_NAME SUBMIT_TIME. STAT is field[2].
  const state = fields[2]
  if (!state || !LSF_ACTIVE_STATE.has(state)) return undefined
  return { schedulerJobId: jobId, state }
}

// `bjobs -l` and `bhist -l` both surface an exit reason. `bjobs` for a terminal job may print
// "Done successfully" or "Exited with exit code N". `bjobs -a` keeps DONE/EXIT rows in the table.
export const parseLsfExitCode = (detail: string): number | undefined => {
  const m = detail.match(/exit code\s*(-?\d+)/i)
  if (!m) return undefined
  const code = Number.parseInt(m[1]!, 10)
  return Number.isFinite(code) ? code : undefined
}

export type LsfTerminalRow = { state: string; exit: number }

export const parseLsfTerminalBlock = (detail: string): LsfTerminalRow | undefined => {
  // A terminal bjobs line maps the STAT token. DONE = success (exit 0); EXIT = failure (non-zero).
  const done = /\bDONE\b/.test(detail)
  const exited = /\bEXIT\b/.test(detail)
  const otherTerminal = [...LSF_TERMINAL_STATE.values()].some(
    (s) => s !== 'DONE' && s !== 'EXIT' && new RegExp(`\\b${s}\\b`).test(detail)
  )
  if (!done && !exited && !otherTerminal) return undefined
  const state = done ? 'DONE' : exited ? 'EXIT' : 'ZOMBI'
  const exit = done ? 0 : (parseLsfExitCode(detail) ?? 1)
  return { state, exit }
}

export const lsfStateToObservation = (
  active: LsfActiveRow | undefined,
  terminal: LsfTerminalRow | undefined
): RemoteObservation | undefined => {
  if (terminal) {
    return {
      alive: false,
      exitCode: terminal.exit,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: '',
      remoteState: terminal.state,
      schedulerDiagnostic: lsfDiagnosticFor(terminal.state)
    }
  }
  if (active) {
    return {
      alive: true,
      exitCode: null,
      hasExitCode: false,
      stdoutTail: '',
      stderrTail: '',
      remoteState: active.state,
      queueReason: active.reason
    }
  }
  return undefined
}

const lsfDiagnosticFor = (state: string): string | undefined => {
  if (state === 'EXIT') return 'LSF job exited non-zero'
  if (state === 'ZOMBI') return 'LSF job became a zombie (no longer controllable)'
  return undefined
}

// ---------------------------------------------------------------------------
// qdel / bkill command builders (NON-PRODUCTION — documented contract only).
//
// These are exported so a fixture test can assert the SHAPE of the cancel command a future adapter would
// issue, but they are NEVER wired into a registered driver. The token safety mirrors the Slurm driver's
// numeric-only guard so a future adapter cannot interpolate a hostile id.
// ---------------------------------------------------------------------------

const numericToken = (s: string): string => {
  if (/^\d+$/.test(s)) return s
  // PBS ids may carry ".<server>"; allow the dotted form but quote-defensively otherwise.
  if (/^\d+(\.[A-Za-z0-9_.-]+)?$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}

export const buildQdelCommand = (schedulerJobId: string): string =>
  `qdel ${numericToken(schedulerJobId)}`

export const buildBkillCommand = (schedulerJobId: string): string =>
  `bkill ${numericToken(schedulerJobId)}`
