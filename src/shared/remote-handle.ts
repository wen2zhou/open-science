// Versioned remote job handle + legacy reader (design.md §4.3).
//
// New jobs (from Issue 02 onward) store a versioned, discriminated JSON handle so a job can be
// recovered, polled, and cancelled by its snapshotted driver regardless of later host re-probes. The
// reader MUST also accept the existing unversioned PID JSON written by the Direct dispatcher today —
// historical rows are never batch-rewritten (design.md §10), and Direct SSH must remain releasable
// after every PR (design.md §3 invariant 7).
//
// This is the frozen baseline shape (Issue 01 contract baseline). Issue 02 (Driver seam) starts
// WRITING this handle; Issue 01 only defines the reader + types so legacy rows keep reading.

// Per-job shared-filesystem paths, common to every driver variant.
export type JobPaths = {
  workdir: string
  stdout: string
  stderr: string
  exitCode: string
}

// The versioned handle (design.md §4.3). A discriminated union on `driver` so the poller/dispatcher can
// branch without parsing provider-specific fields.
export type RemoteHandleV1 =
  | { version: 1; driver: 'direct'; pid: number; pgid: number; paths: JobPaths }
  | { version: 1; driver: 'slurm'; schedulerJobId: string; paths: JobPaths }

// The legacy unversioned handle written today by job-dispatcher.ts (Direct SSH). Kept here as the
// authoritative legacy shape so the reader and the writer agree byte-for-byte.
export type LegacyDirectHandle = {
  pid: number
  exit_code_path: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

// A normalized handle the poller/canceller can consume uniformly. `kind` lets callers handle legacy
// rows without understanding the versioned union, while preserving every original field so Issue 02's
// driver can take over with no information loss.
export type ParsedRemoteHandle =
  | {
      kind: 'direct-v1'
      raw: Extract<RemoteHandleV1, { driver: 'direct' }>
      pid: number
      paths: JobPaths
    }
  | {
      kind: 'slurm-v1'
      raw: Extract<RemoteHandleV1, { driver: 'slurm' }>
      schedulerJobId: string
      paths: JobPaths
    }
  | {
      kind: 'legacy-direct'
      raw: LegacyDirectHandle
      pid: number
      paths: JobPaths
    }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

// Parses a JobPaths object from a v1 handle, returning undefined when required paths are missing. A
// missing path does not crash the poller — it degrades so the job row stays readable (design.md §10).
const parseJobPaths = (v: unknown): JobPaths | undefined => {
  if (!isPlainObject(v)) return undefined
  const workdir = asString(v['workdir'])
  const stdout = asString(v['stdout'])
  const stderr = asString(v['stderr'])
  const exitCode = asString(v['exitCode'])
  if (!workdir || !stdout || !stderr || !exitCode) return undefined
  return { workdir, stdout, stderr, exitCode }
}

// Reads a versioned RemoteHandleV1.
const parseV1 = (obj: Record<string, unknown>): ParsedRemoteHandle | null => {
  if (obj['version'] !== 1) return null
  const driver = obj['driver']
  const paths = parseJobPaths(obj['paths'])
  if (!paths) return null

  if (driver === 'direct') {
    const pid = asNumber(obj['pid'])
    const pgid = asNumber(obj['pgid'])
    if (pid === undefined) return null
    const raw: Extract<RemoteHandleV1, { driver: 'direct' }> = {
      version: 1,
      driver: 'direct',
      pid,
      pgid: pgid ?? pid,
      paths
    }
    return { kind: 'direct-v1', raw, pid, paths }
  }
  if (driver === 'slurm') {
    const schedulerJobId = asString(obj['schedulerJobId'])
    if (!schedulerJobId) return null
    const raw: Extract<RemoteHandleV1, { driver: 'slurm' }> = {
      version: 1,
      driver: 'slurm',
      schedulerJobId,
      paths
    }
    return { kind: 'slurm-v1', raw, schedulerJobId, paths }
  }
  return null
}

// Reads the legacy unversioned PID JSON written by the Direct dispatcher today. Treats any JSON object
// with a numeric pid as a legacy Direct handle (design.md §4.3 — "the reader treats the existing
// unversioned PID JSON as a legacy Direct handle").
const parseLegacyDirect = (obj: Record<string, unknown>): ParsedRemoteHandle | null => {
  const pid = asNumber(obj['pid'])
  if (pid === undefined) return null
  const workdir = asString(obj['workdir']) ?? ''
  const stdout = asString(obj['stdout_path']) ?? `${workdir}/stdout`
  const stderr = asString(obj['stderr_path']) ?? `${workdir}/stderr`
  const exitCode = asString(obj['exit_code_path']) ?? `${workdir}/exit_code`
  const raw: LegacyDirectHandle = {
    pid,
    exit_code_path: exitCode,
    stdout_path: stdout,
    stderr_path: stderr,
    workdir
  }
  return { kind: 'legacy-direct', raw, pid, paths: { workdir, stdout, stderr, exitCode } }
}

// The single reader entry point. Accepts:
//   - undefined / null / empty  → null (job not yet dispatched)
//   - a versioned RemoteHandleV1 → normalized direct-v1 / slurm-v1
//   - legacy PID JSON            → normalized legacy-direct
// Never throws: a corrupt JSON string degrades to null so one bad row cannot break loading the poll
// batch (mirrors the parseJson defensive pattern in repository.ts).
export const parseRemoteHandle = (raw: string | undefined | null): ParsedRemoteHandle | null => {
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(obj)) return null

  // Versioned handles always carry an explicit numeric `version`. Anything else is treated as legacy.
  if (obj['version'] === 1) {
    return parseV1(obj)
  }
  return parseLegacyDirect(obj)
}
