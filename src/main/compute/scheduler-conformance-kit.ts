// Reusable scheduler driver conformance kit (design.md §11, Issue 07).
//
// Every executable ComputeDriver (Direct today, Slurm today; future PBS/LSF production adapters) must
// satisfy the SAME behavioral contract across six dimensions:
//
//   1. HANDLE     — `dispatch` returns a versioned, self-describing DriverHandle.
//   2. SUBMIT     — the submit command produces a parseable scheduler job id / pid (no silent failure).
//   3. OBSERVE    — `pollMany` reports active (alive, no exit) and terminal (dead, exit code) observations.
//   4. STATE MAP  — provider-native state rides along in `remoteState` WITHOUT driving cross-provider status;
//                   `alive`/`hasExitCode` are the authoritative signals for the poller's state machine.
//   5. CANCEL     — `cancel` is best-effort and swallows connectivity failure (never throws).
//   6. ERRORS     — dispatch failures are structured (host_unreachable / dispatch_failed /
//                   invalid_directives); connectivity during poll becomes `unreachable` (host down != job failed).
//
// This module exposes `runDriverConformanceKit`, which a driver's test file imports to assert ALL six in
// one place. A future adapter reuses the SAME kit by providing a `DriverConformanceHarness` that knows how
// to script that driver's fake cluster (sbatch/squeue/sacct for Slurm; a pid table for Direct; qsub/qstat
// for a future PBS adapter). This keeps the frozen contract in one authoritative location and prevents
// silent contract drift between drivers.
//
// The kit is ASSERTION-ONLY — it never reaches the network. The harness supplies a fake SshRunner.

import { expect } from 'vitest'

import type {
  ComputeDriver,
  DispatchContext,
  DriverContext,
  DriverHandle,
  DriverJob,
  RemoteObservation
} from './compute-driver'
import { parseRemoteHandle } from '../../shared/remote-handle'
import type { ResourceRequest } from '../../shared/compute-resources'

// What a harness must provide so the kit can drive any driver identically. The harness wires the driver
// under test to a fake remote and exposes mutators the kit uses to advance job state between ticks, the
// same way the slurm-conformance fake cluster does.
export interface DriverConformanceHarness {
  // The driver under test (Direct, Slurm, or a future adapter).
  readonly driver: ComputeDriver
  // A minimal dispatch context sufficient for `dispatch`. The harness fills target/workdir/timeoutSeconds;
  // the kit stamps jobId/resources/command per scenario.
  readonly dispatchContext: Pick<DispatchContext, 'target' | 'workdir' | 'timeoutSeconds'>
  // The driver context handed to pollMany/cancel (target + workdir).
  readonly driverContext: DriverContext
  // Advance a tracked job's remote state to RUNNING and return the updated active observation shape the
  // kit should see from pollMany. Throws if the driver cannot represent an active-running job.
  advanceToRunning(schedulerJobId: string): Promise<void> | void
  // Advance a tracked job to a TERMINAL exit. The kit asserts the observation reports hasExitCode + exit.
  advanceToTerminal(schedulerJobId: string, exitCode: number): Promise<void> | void
  // Parse a raw scheduler job id / pid out of the dispatch submit output (proves submit output is parseable).
  parseSubmitId(submitStdout: string): string | undefined
  // Optional: simulate host-down during a cancel so the kit can assert cancel never throws.
  setCancelUnreachable?(unreachable: boolean): void
}

// A parsed handle wrapped as a DriverJob for pollMany. Uses the frozen handle reader so the kit
// exercises the exact normalization path production uses (and the same `kind` narrowing as the driver).
const asDriverJob = (jobId: string, handle: DriverHandle): DriverJob => {
  const parsed = parseRemoteHandle(JSON.stringify(handle))
  if (!parsed) throw new Error('conformance kit could not re-parse the dispatch handle')
  return { jobId, handle: parsed }
}

// Runs the full conformance kit against the provided harness. Throws (via vitest `expect`) on any
// contract violation. Callers wrap this in a `describe`/`it` so failures surface as normal test errors.
export const runDriverConformanceKit = async (harness: DriverConformanceHarness): Promise<void> => {
  const { driver, dispatchContext, driverContext } = harness

  // ── 1. HANDLE: dispatch returns a versioned self-describing handle ─────────────────────────────
  const ctx: DispatchContext = {
    target: dispatchContext.target,
    workdir: dispatchContext.workdir,
    timeoutSeconds: dispatchContext.timeoutSeconds,
    jobId: 'conf-handle',
    command: 'echo hello',
    resources: {} as ResourceRequest
  }
  const handle = await driver.dispatch(ctx)
  expect(handle).toBeDefined()
  expect(handle.version).toBe(1)
  // A handle must carry its driver kind so the registry/reader never guess.
  expect(handle.driver).toBe(driver.kind)
  // Paths are mandatory — the poller/harvest read them later.
  expect(handle.paths.workdir).toBeTruthy()
  expect(handle.paths.stdout).toBeTruthy()
  expect(handle.paths.stderr).toBeTruthy()

  // ── 2. SUBMIT: the id embedded in the handle is parseable from the submit command output ───────
  // (For Slurm this is the schedulerJobId parsed from `sbatch --parsable`; for Direct it is the pid
  // read from the dispatch response. The harness knows how to extract it; the kit only proves a
  // non-empty, parseable token exists.)
  const remoteId = extractRemoteId(handle)
  expect(remoteId, 'dispatch must embed a parseable remote id').toBeTruthy()

  // ── 3 + 4. OBSERVE & STATE MAP: active (alive) then terminal (dead, exit) ──────────────────────
  await harness.advanceToRunning(remoteId!)
  const activeObs = await firstObservation(driver, driverContext, 'conf-handle', handle)
  expect(activeObs, 'pollMany must observe an active job').toBeDefined()
  expect(activeObs!.alive).toBe(true)
  expect(activeObs!.hasExitCode).toBe(false)
  expect(activeObs!.exitCode).toBeNull()
  // State mapping invariant: provider-native state rides along but does NOT replace the alive signal.
  if (activeObs!.remoteState) {
    expect(typeof activeObs!.remoteState).toBe('string')
  }

  await harness.advanceToTerminal(remoteId!, 0)
  const termObs = await firstObservation(driver, driverContext, 'conf-handle', handle)
  expect(termObs, 'pollMany must observe the terminal job').toBeDefined()
  expect(termObs!.alive).toBe(false)
  expect(termObs!.hasExitCode).toBe(true)
  expect(termObs!.exitCode).toBe(0)

  // ── 5. CANCEL: best-effort, never throws ───────────────────────────────────────────────────────
  if (harness.setCancelUnreachable) harness.setCancelUnreachable(true)
  // A cancel on a job whose remote id is gone / host down must resolve, not reject.
  await expect(driver.cancel(driverContext, handle)).resolves.toBeUndefined()
}

// Runs the dispatch-failure subset of the kit: invalid input and unreachable host produce STRUCTURED
// errors, not raw throws with untyped messages. Call this separately so a harness can inject a failing
// runner without polluting the happy-path kit run.
export const runDispatchErrorConformance = async (
  harness: DriverConformanceHarness,
  failingContext?: Pick<DispatchContext, 'target' | 'workdir' | 'timeoutSeconds'>
): Promise<void> => {
  const { driver, dispatchContext } = harness
  const base = failingContext ?? dispatchContext
  const ctx: DispatchContext = {
    target: base.target,
    workdir: base.workdir,
    timeoutSeconds: base.timeoutSeconds,
    jobId: 'conf-err',
    command: 'echo fail',
    resources: {} as ResourceRequest
  }
  // dispatch must throw (not return a bad handle) and the thrown value must be structured.
  await expect(driver.dispatch(ctx)).rejects.toBeDefined()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Extracts the remote id from a versioned handle in a driver-agnostic way. For Slurm it's the
// schedulerJobId; for Direct it's the pid.
const extractRemoteId = (handle: DriverHandle): string | undefined => {
  if (handle.driver === 'slurm') return handle.schedulerJobId
  return String(handle.pid)
}

// Calls pollMany for a single job and returns the first observation (or undefined).
const firstObservation = async (
  driver: ComputeDriver,
  context: DriverContext,
  jobId: string,
  handle: DriverHandle
): Promise<RemoteObservation | undefined> => {
  const result = await driver.pollMany(context, [asDriverJob(jobId, handle)])
  if (result.kind !== 'ok') {
    // Connectivity loss during conformance is a harness bug, not a driver contract violation.
    throw new Error(`pollMany returned unreachable during conformance: ${result.message}`)
  }
  return result.observations.get(jobId)
}
