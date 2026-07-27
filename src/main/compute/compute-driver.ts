// Frozen compute-driver seam (design.md §4.2).
//
// Drivers own ONLY remote execution mechanics: launching a detached process (Direct) or submitting a
// scheduler job (Slurm), observing their state in batches, and cancelling them. Shared orchestration —
// authorization/approval, persistence, input staging, output harvest, notification, and renderer
// broadcasting — stays in the dispatcher/poller/ComputeService and is NEVER pushed into a driver
// (design.md §3 invariant 2; cross-cutting requirement: do not inject renderer or approval deps).
//
// This contract is the frozen baseline that Issue 03 (Slurm) consumes. After Issue 03, any change to
// `ComputeDriver`, `RemoteObservation`, or the handle schema requires a dedicated design amendment
// (design.md §12 "Integration discipline").

import type { JobPaths, ParsedRemoteHandle, RemoteHandleV1 } from '../../shared/remote-handle'
import type { ComputeJob } from '../../shared/compute'
import type { ResourceRequest } from '../../shared/compute-resources'
import type { ResolvedSshTarget } from './ssh-runner'

// A resolved driver kind. Mirrors the discriminated union on `RemoteHandleV1.driver` so the registry
// and the handle reader agree on the set of drivers that exist (design.md §4.3).
export type DriverKind = 'direct' | 'slurm'

// A handle a driver returns from `dispatch` and consumes again on `pollMany`/`cancel`. New jobs store
// the versioned `RemoteHandleV1` (design.md §4.3); the registry/dispatcher persist it verbatim.
export type DriverHandle = RemoteHandleV1

// Per-job shared-filesystem paths, threaded through the driver context so a driver never re-derives
// them. These are the same `JobPaths` the versioned handle stores.
export type DriverJobPaths = JobPaths

// The shared driver context: everything a driver needs to reach the remote host. Drivers MUST NOT
// carry host credentials or renderer/approval handles here — only the resolved SSH target and the
// job's pre-staged work directory. `target` is optional so non-SSH drivers (future local/bridge) can
// evolve the seam without forcing a fake target; the Direct/Slurm drivers always set it.
export type DriverContext = {
  // The resolved SSH connection target (ssh -G result + overrides). Always set for Direct/Slurm.
  target?: ResolvedSshTarget
  // The job's pre-computed remote work directory (design.md §4.5). Drivers must use this verbatim.
  workdir: string
}

// Context handed to `dispatch`. The shared orchestration layer resolves the SSH target, computes the
// workdir, and prepares the staged-input manifest BEFORE invoking the driver, so the driver's only job
// is "write the scripts, launch detached, return a handle". This keeps staging/approval out of the
// driver (design.md §4.2).
export type DispatchContext = DriverContext & {
  // The raw job command (written to command.sh by the Direct driver). The driver owns script assembly.
  command: string
  // Per-job wall-clock timeout in seconds (drives the remote `timeout` wrapper for Direct).
  timeoutSeconds: number
  // The jobId, so the driver can stamp per-job files (job.pid etc.) if it needs them.
  jobId: string
  // The validated structured resource request (design.md §5). The Direct driver ignores it; the Slurm
  // driver renders it to #SBATCH directives. Always defined for new jobs (defaults to an empty request
  // when the caller supplied no resources).
  resources: ResourceRequest
  // The deterministic environment preamble (design.md §8.2 / cross-cutting: Direct SSH and Slurm
  // consume the SAME resolved preamble). Undefined for plain command jobs. The driver prepends it to
  // the job command so activation runs BEFORE the workload, identically for both backends.
  environmentPreamble?: string
}

// One job handed to `pollMany`, in the normalized form the poller already parsed. The driver consumes
// the versioned handle (or, for legacy rows, the normalized legacy handle) and returns an observation.
export type DriverJob = {
  jobId: string
  // The normalized handle (direct-v1 / slurm-v1 / legacy-direct). Legacy rows flow through unchanged
  // (design.md §10 / cross-cutting: no batch rewrite) — the Direct driver treats legacy-direct and
  // direct-v1 identically.
  handle: ParsedRemoteHandle
}

// A single job's observed state, as the poller's state machine consumes it. This is the provider-neutral
// projection of "is it alive, did it exit, what do the tail buffers say". The provider-neutral `alive` /
// `exitCode` / tails fields drive the cross-provider state machine; the optional scheduler diagnostics
// (`remoteState`, `queueReason`, `schedulerDiagnostic`) carry scheduler-specific detail that the poller
// persists SEPARATELY from `status` so provider state names never leak into the state machine
// (design.md §4.4 — "remoteState, queueReason, and a detailed error code ... prevent scheduler-specific
// state names from leaking").
//
// NOTE (Issue 03 design decision): design.md §4.2 said scheduler-specific names "stay inside the driver
// and are NOT surfaced here". That was the Issue 02 baseline. Issue 03 (this PR) is the Slurm slice and
// §4.4 requires `remoteState`/`queueReason` to be PERSISTED on the job row. Rather than have the driver
// touch job status (forbidden — design.md §3 invariant 2), we extend `RemoteObservation` with OPTIONAL
// scheduler diagnostics that the poller records alongside `status`. This keeps the driver owning only
// remote mechanics while letting scheduler detail reach the DB through the frozen observation shape.
// This is the last PR allowed to evolve this shape (design.md §12 — freeze after PR3).
export type RemoteObservation = {
  // Whether the launched process/scheduler-job is still alive (kill -0 success / squeue present).
  alive: boolean
  // The numeric exit code if the job has reached a terminal process exit, else null.
  exitCode: number | null
  // True when the driver could read a definitive exit code (terminal). When false the poller keeps
  // the job non-terminal and re-polls next tick.
  hasExitCode: boolean
  // The captured stdout/stderr tails (bounded). The driver owns the capture size (design.md §8: 64KiB).
  stdoutTail: string
  stderrTail: string
  // Optional scheduler-native state name (e.g. Slurm "PENDING"/"RUNNING"/"COMPLETED"/"FAILED"). The
  // poller records this as remote_state WITHOUT letting it drive `status` for non-terminal jobs.
  remoteState?: string
  // Optional scheduler queue/pending reason (e.g. Slurm "Priority"/"Resources"). Recorded separately.
  queueReason?: string
  // Optional free-form scheduler diagnostic (e.g. a non-zero sacct-derived note). Recorded verbatim.
  schedulerDiagnostic?: string
}

// The result of `pollMany`. Two disjoint outcomes so the poller can implement design.md §8 boundary 2
// ("host unreachable ≠ job failed") without the driver touching job status:
//
//   - `ok`: the batch reached the host. `observations` holds one entry per job the driver observed;
//     a job absent from the map is left non-terminal by the poller (re-polled next tick). `errors`
//     (optional) carries a per-job transient connectivity message to record as lastPollError WITHOUT
//     flipping status — used when a sub-batch SSH call failed mid-sweep but the overall call still
//     returned some observations.
//   - `unreachable`: the WHOLE batch could not reach the host (SSH timed out / exit 255). The poller
//     records lastPollError for every submitted job and flips NO status.
export type PollManyResult =
  | { kind: 'ok'; observations: Map<string, RemoteObservation>; errors?: Map<string, string> }
  | { kind: 'unreachable'; message: string }

// The frozen driver interface (design.md §4.2). `pollMany` is required (not per-job `poll`) so a
// scheduler login node never receives one SSH command per tracked job (cross-cutting requirement).
export interface ComputeDriver {
  readonly kind: DriverKind
  // Launches the job remotely and returns a versioned handle. Throws on unexpected infra failure;
  // the dispatcher wraps it into job status. The driver does NOT stage inputs or write job status —
  // shared orchestration does that before/after this call.
  dispatch(context: DispatchContext): Promise<DriverHandle>
  // Observes a batch of jobs for one provider in as few SSH round-trips as practical. Returns a
  // `PollManyResult`; never throws for connectivity issues (those become `unreachable`).
  pollMany(context: DriverContext, jobs: DriverJob[]): Promise<PollManyResult>
  // Cancels a launched job (Direct: process-group kill; Slurm: scancel). Best-effort: swallows
  // connectivity errors so a failing cancel cannot wedge a terminal transition.
  cancel(context: DriverContext, handle: DriverHandle): Promise<void>
}

// ---------------------------------------------------------------------------
// Driver registry (design.md §4.2 — "shared driver selection entry").
// ---------------------------------------------------------------------------

// The registry maps a resolved driver kind to its driver instance. Drivers are singletons registered
// once at process start; `submit_job` snapshots the resolved KIND onto the job, and the
// poller/dispatcher look the driver up by that kind so a job is always served by its snapshotted
// driver regardless of later host re-probes (design.md §4.1).
export class ComputeDriverRegistry {
  private readonly drivers = new Map<DriverKind, ComputeDriver>()

  register(driver: ComputeDriver): void {
    this.drivers.set(driver.kind, driver)
  }

  // Looks up the driver for a resolved kind. Returns undefined when no driver is registered for that
  // kind (e.g. Slurm before Issue 03). Callers must treat undefined as "this backend is not enabled"
  // rather than silently falling back to another driver (design.md §3 invariant 7).
  get(kind: DriverKind): ComputeDriver | undefined {
    return this.drivers.get(kind)
  }

  has(kind: DriverKind): boolean {
    return this.drivers.has(kind)
  }
}

// Process-wide registry. Production wires Direct (this issue) and later Slurm (Issue 03) into it at
// startup; tests inject their own registry with a fake driver for isolation.
export const sharedComputeDriverRegistry = new ComputeDriverRegistry()

// Resolves the driver for a job. Falls back to 'direct' for legacy rows that predate the `driver`
// column (design.md §10 — legacy rows keep working without a rewrite). Returns undefined when the
// snapshotted driver kind has no registered driver (Slurm before Issue 03), so the caller can fail
// fast rather than dispatching via the wrong backend.
export const resolveJobDriver = (
  job: Pick<ComputeJob, 'driver'>,
  registry: ComputeDriverRegistry = sharedComputeDriverRegistry
): ComputeDriver | undefined => {
  const kind: DriverKind = job.driver ?? 'direct'
  return registry.get(kind)
}
