import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { JobPoller } from './job-poller'
import { DispatchTracker } from './dispatch-tracker'
import type { HarvestFn } from './job-poller'
import type {
  ComputeDriver,
  DriverContext,
  DriverHandle,
  DriverJob,
  PollManyResult,
  RemoteObservation
} from './compute-driver'
import { ComputeDriverRegistry } from './compute-driver'
import { parseRemoteHandle } from '../../shared/remote-handle'

// Mock resolveSshTarget at module level so all tests bypass the real ssh -G call.
vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() =>
      Promise.resolve({
        sshBinary: '/usr/bin/ssh',
        host: 'biowulf.nih.gov',
        extraArgs: ['-o', 'BatchMode=yes']
      } as ResolvedSshTarget)
    )
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  project_id: 'proj-1',
  status: 'running',
  intent: 'test',
  command: 'echo hello',
  command_hash: 'abc',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 3600,
  remote_workdir: '~/.openscience/jobs/job-1',
  remote_handle: JSON.stringify({
    version: 1,
    driver: 'direct',
    pid: 1234,
    pgid: 1234,
    paths: {
      workdir: '~/.openscience/jobs/job-1',
      stdout: '~/.openscience/jobs/job-1/stdout',
      stderr: '~/.openscience/jobs/job-1/stderr',
      exitCode: '~/.openscience/jobs/job-1/exit_code'
    }
  }),
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: Date.now() - 60_000,
  submitted_at: Date.now() - 60_000,
  started_at: Date.now() - 55_000,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

const sampleHost = (): import('../../shared/compute').ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  executionBackend: 'auto',
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
})

// A fake direct driver whose pollMany returns a configured observation per job. Tests set
// `observation` (or `unreachable`) to drive the poller's state machine without SSH fixtures.
class FakeDirectDriver implements ComputeDriver {
  readonly kind = 'direct' as const
  pollCalls = 0
  cancelCalls = 0
  // Per-jobId observation to return; default = alive, no exit, empty tails.
  observations = new Map<string, RemoteObservation>()
  // When set, pollMany returns this unreachable result for the whole batch.
  unreachable: { message: string } | undefined = undefined

  dispatch(): Promise<DriverHandle> {
    return Promise.reject(new Error('not used by the poller'))
  }
  async pollMany(
    _context: DriverContext,
    jobs: DriverJob[]
  ): Promise<PollManyResult> {
    this.pollCalls++
    if (this.unreachable) return { kind: 'unreachable', message: this.unreachable.message }
    const map = new Map<string, RemoteObservation>()
    for (const job of jobs) {
      const obs = this.observations.get(job.jobId) ?? {
        alive: true,
        exitCode: null,
        hasExitCode: false,
        stdoutTail: '',
        stderrTail: ''
      }
      map.set(job.jobId, obs)
    }
    return { kind: 'ok', observations: map }
  }
  async cancel(): Promise<void> {
    this.cancelCalls++
  }
}

// Wait for `predicate` to return true, polling on a short timer. Used for the poller's fire-and-
// forget notification emit, whose async chain (emitJobNotification → buildComputeDonePayload →
// readdir) settles after the tick returns; a single microtask flush is not enough under parallel
// file execution, so we poll briefly instead of flaking.
const waitFor = async (predicate: () => boolean, timeoutMs = 500, stepMs = 5): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

// Builds a poller wired with a fake direct driver (registered under 'direct') and the given repos.
// Returns the driver so the test can assert cancel/poll call counts.
const makePollerWithFakeDriver = (
  jobRepo: ComputeJobRepository,
  hostRepo: ComputeHostRepository,
  opts: {
    onJobUpdated?: (job: ComputeJob) => void
    dispatchTracker?: DispatchTracker
    harvestFn?: HarvestFn
    broadcast?: (summary: import('../../shared/compute').JobSummary) => void
    storageRoot?: string
  } = {}
): { poller: JobPoller; driver: FakeDirectDriver } => {
  const driver = new FakeDirectDriver()
  const registry = new ComputeDriverRegistry()
  registry.register(driver)
  // Always inject a FRESH per-test DispatchTracker so no test depends on the process-wide
  // sharedDispatchTracker (which other test files mutate under parallel execution, causing flakiness).
  const dispatchTracker = opts.dispatchTracker ?? new DispatchTracker()
  // Ensure the recovery scans have no-ops when the test does not configure them (the poller calls
  // findTerminalUnharvested whenever harvestFn is set, and findErrorUnnotified when broadcast is set).
  const safeRepo = jobRepo as ComputeJobRepository & {
    findTerminalUnharvested?: () => Promise<ComputeJob[]>
    findErrorUnnotified?: () => Promise<ComputeJob[]>
  }
  if (!safeRepo.findTerminalUnharvested) {
    safeRepo.findTerminalUnharvested = () => Promise.resolve([])
  }
  if (!safeRepo.findErrorUnnotified) {
    safeRepo.findErrorUnnotified = () => Promise.resolve([])
  }
  const runner: SshRunner = { run: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })) }
  const poller = new JobPoller({
    runner,
    hostRepository: hostRepo,
    jobRepository: jobRepo,
    driverRegistry: registry,
    onJobUpdated: opts.onJobUpdated,
    dispatchTracker,
    harvestFn: opts.harvestFn,
    broadcast: opts.broadcast,
    storageRoot: opts.storageRoot
  })
  return { poller, driver }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobPoller', () => {
  it('transitions job to success when exit_code=0 is observed', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo, {
      onJobUpdated: vi.fn()
    })
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 0,
      hasExitCode: true,
      stdoutTail: 'hello',
      stderrTail: ''
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'success', exitCode: 0 })
    )
  })

  it('clears a stale lastPollError on a successful poll of a still-running job', async () => {
    // A running job that previously recorded a transient SSH error must have that error cleared once
    // a poll succeeds again (schema.prisma: "Cleared on the next successful poll").
    const job = makeJob({ status: 'running', last_poll_error: 'ssh: connect timed out' })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      get: vi.fn(() => Promise.resolve(job)),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: true,
      exitCode: null,
      hasExitCode: false,
      stdoutTail: 'still going',
      stderrTail: ''
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ lastPollError: null }))
  })

  it('transitions job to failed when exit_code != 0', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 3,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: 'error msg'
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', exitCode: 3, errorCode: 'job_failed' })
    )
  })

  it('transitions job to timeout when exit_code=124', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 124,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'timeout', exitCode: 124, errorCode: 'timeout' })
    )
  })

  it('marks process_vanished after 2 consecutive ticks of pid gone + no exit_code', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: false,
      exitCode: null,
      hasExitCode: false,
      stdoutTail: '',
      stderrTail: ''
    })

    // First tick — vanish counter = 1, not yet failed.
    await poller.tick()
    expect(update).not.toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'process_vanished' })
    )

    // Second tick — vanish counter = 2, should be failed.
    await poller.tick()
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'process_vanished' })
    )
  })

  it('does not flip job status when host is unreachable (unreachable result)', async () => {
    // design.md §8 boundary 2: host unreachable ≠ job failed. The driver returns unreachable; the
    // poller records lastPollError and flips NO status.
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.unreachable = { message: 'SSH connection timed out' }

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ lastPollError: 'SSH connection timed out', retryAfterUserAction: true })
    )
    // Status must NOT have flipped.
    expect(update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: expect.any(String) }))
  })

  it('records lastPollError when the driver throws and does not flip status', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const driver = new FakeDirectDriver()
    // Override pollMany to throw an unexpected error.
    driver.pollMany = vi.fn(() => Promise.reject(new Error('unexpected boom'))) as typeof driver.pollMany
    const registry = new ComputeDriverRegistry()
    registry.register(driver)
    const runner: SshRunner = { run: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })) }
    const poller = new JobPoller({
      runner,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      driverRegistry: registry
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ lastPollError: 'unexpected boom', retryAfterUserAction: true })
    )
    expect(update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: expect.any(String) }))
  })

  it('disambiguates exit 137: elapsed >= timeout_seconds → timeout', async () => {
    const job = makeJob({
      timeout_seconds: 10,
      started_at: Date.now() - 60_000 // 60s elapsed >> 10s timeout
    })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 137,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'timeout', errorCode: 'timeout' })
    )
  })

  it('disambiguates exit 137: elapsed < timeout_seconds → failed (OOM)', async () => {
    const job = makeJob({
      timeout_seconds: 3600,
      started_at: Date.now() - 1_000 // 1s elapsed << 1h timeout
    })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 137,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'failed', errorCode: 'job_failed' })
    )
  })

  it('poller fallback: cancels via driver and marks timeout when elapsed > startedAt+timeout+60s grace', async () => {
    const job = makeJob({
      timeout_seconds: 10,
      started_at: Date.now() - 100_000 // far past timeout + grace
    })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: true,
      exitCode: null,
      hasExitCode: false,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    // The poller-fallback kill delegates to driver.cancel (process-group semantics).
    expect(driver.cancelCalls).toBe(1)
    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'timeout', errorCode: 'timeout' })
    )
  })

  it('marks submitted job without pid as error/dispatch_failed on restart', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo)

    await poller.tick()

    expect(update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )
  })

  it('does NOT flag a submitted+no-handle job whose dispatch is still in flight', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const tracker = new DispatchTracker()
    tracker.begin(job.job_id) // dispatch is actively running in this process
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { dispatchTracker: tracker })

    await poller.tick()

    expect(update).not.toHaveBeenCalled()
  })

  it('does not tick when there are no non-terminal jobs', async () => {
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      update: vi.fn()
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn() } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)

    await poller.tick()

    expect(driver.pollCalls).toBe(0)
  })

  it('start/stop manage the interval', () => {
    const jobRepo = { findNonTerminal: vi.fn(() => Promise.resolve([])) } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn() } as unknown as ComputeHostRepository
    const fakeHandle = 42 as unknown as ReturnType<typeof globalThis.setInterval>
    const setIntervalMock = vi.fn(() => fakeHandle)
    const clearIntervalMock = vi.fn()
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo)
    // start/stop accept injected timers via the deps — rebuild a poller that wires them.
    const runner: SshRunner = { run: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })) }
    const p2 = new JobPoller({
      runner,
      hostRepository: hostRepo,
      jobRepository: jobRepo,
      setInterval: setIntervalMock as unknown as typeof globalThis.setInterval,
      clearInterval: clearIntervalMock as unknown as typeof globalThis.clearInterval
    })
    void poller
    p2.start()
    expect(setIntervalMock).toHaveBeenCalled()
    p2.stop()
    expect(clearIntervalMock).toHaveBeenCalled()
  })

  it('dispatches harvest asynchronously when a job transitions to success (does not await)', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const harvestFn = vi.fn(() => new Promise<void>(() => {})) // never resolves
    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 0,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    expect(harvestFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
  })

  it('dispatches harvest for failed and timeout terminal states', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const harvestFn = vi.fn(() => Promise.resolve())
    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 5,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    expect(harvestFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })

  it('does NOT dispatch harvest for error status (dispatch_failed)', async () => {
    // Error jobs reach the harvest-disabled noHandle path; harvestFn must not be called for them.
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const harvestFn = vi.fn(() => Promise.resolve())
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })

    await poller.tick()

    expect(harvestFn).not.toHaveBeenCalled()
  })

  it('does not re-dispatch harvest for the same job while its harvest is in-flight (dedup)', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    let resolveHarvest: () => void = () => {}
    const harvestFn = vi.fn(
      () => new Promise<void>((resolve) => { resolveHarvest = resolve })
    )
    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 0,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    // First tick: success → harvest in-flight.
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledTimes(1)

    // Second tick while harvest is still in-flight: findTerminalUnharvested would re-queue it, but the
    // in-flight dedup must suppress a second dispatch. findTerminalUnharvested returns the same job.
    ;(jobRepo as unknown as { findTerminalUnharvested: ReturnType<typeof vi.fn> }).findTerminalUnharvested =
      vi.fn(() => Promise.resolve([{ ...job, status: 'success', harvested_at: undefined }]))
    await poller.tick()
    expect(harvestFn).toHaveBeenCalledTimes(1) // still one — dedup held

    resolveHarvest()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('enforces concurrency limit of 2 (third harvest waits until one of the first two completes)', async () => {
    type JobRepo = ComputeJobRepository & { findTerminalUnharvested: ReturnType<typeof vi.fn> }
    const jobA = makeJob({ job_id: 'job-a' })
    const jobB = makeJob({ job_id: 'job-b' })
    const jobC = makeJob({ job_id: 'job-c' })
    const update = vi.fn((_id: string, u: unknown) =>
      Promise.resolve({ ...({ job_id: _id } as ComputeJob), ...(u as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([jobA, jobB, jobC])),
      update
    } as unknown as JobRepo
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const blockers: Array<() => void> = []
    const harvestFn = vi.fn(
      () => new Promise<void>((resolve) => { blockers.push(resolve) })
    )
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })

    await poller.tick()
    // Limit 2: only the first two harvests started; the third is queued.
    expect(harvestFn).toHaveBeenCalledTimes(2)

    // Release one → the queued third harvest starts.
    blockers.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(harvestFn).toHaveBeenCalledTimes(3)

    // Clean up remaining in-flight harvests.
    while (blockers.length) {
      blockers.shift()!()
    }
    await new Promise((r) => setTimeout(r, 0))
  })

  it('does not affect poller tick when a harvest fails (error isolation)', async () => {
    const job = makeJob()
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const harvestFn = vi.fn(() => Promise.reject(new Error('harvest blew up')))
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })

    // A throwing harvest must not propagate.
    await expect(poller.tick()).resolves.toBeUndefined()
  })

  it('recovery scan: harvests terminal+unharvestedAt jobs on start', async () => {
    const job = makeJob({ status: 'success', harvested_at: undefined })
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([job])),
      update: vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const harvestFn = vi.fn(() => Promise.resolve())
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })

    await poller.tick()

    expect(harvestFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
  })

  it('does not re-harvest already-harvested jobs in recovery scan', async () => {
    const harvested = makeJob({ status: 'success', harvested_at: Date.now() })
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])), // nothing unharvested
      update: vi.fn()
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const harvestFn = vi.fn(() => Promise.resolve())
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { harvestFn })

    await poller.tick()

    expect(harvestFn).not.toHaveBeenCalled()
    void harvested
  })

  it('emits notification for error/dispatch_failed job (broadcast + notifiedAt written)', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })

    // First update writes status=error; second writes notifiedAt (from emitJobNotification).
    const updatedJobWithError = {
      ...job,
      status: 'error' as const,
      error_code: 'dispatch_failed',
      finished_at: Date.now(),
      notified_at: undefined
    }
    const updatedJobWithNotif = { ...updatedJobWithError, notified_at: Date.now() }
    const update = vi
      .fn()
      .mockResolvedValueOnce(updatedJobWithError)
      .mockResolvedValue(updatedJobWithNotif)

    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findErrorUnnotified: vi.fn(() => Promise.resolve([])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const broadcast = vi.fn()
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { broadcast, storageRoot: '/store' })

    await poller.tick()
    await waitFor(() => broadcast.mock.calls.length > 0)

    expect(broadcast).toHaveBeenCalled()
  })

  it('does NOT emit notification if broadcast is not wired', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })
    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findErrorUnnotified: vi.fn(() => Promise.resolve([])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo) // no broadcast

    // No broadcast wired — the noHandle path still flips the job but must not throw.
    await expect(poller.tick()).resolves.toBeUndefined()
  })

  it('emits notification for dispatcher-written error jobs via the recovery scan', async () => {
    // A submitted+no-handle job whose dispatch is NOT in-flight (restart orphan) is flipped to error
    // in-tick; the noHandle path emits its own notification.
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })
    const updatedJobWithError = {
      ...job,
      status: 'error' as const,
      error_code: 'dispatch_failed',
      finished_at: Date.now(),
      notified_at: undefined
    }
    const updatedJobWithNotif = { ...updatedJobWithError, notified_at: Date.now() }
    const update = vi
      .fn()
      .mockResolvedValueOnce(updatedJobWithError)
      .mockResolvedValue(updatedJobWithNotif)

    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      findTerminalUnharvested: vi.fn(() => Promise.resolve([])),
      findErrorUnnotified: vi.fn(() => Promise.resolve([])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const broadcast = vi.fn()
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { broadcast, storageRoot: '/store' })

    await poller.tick()
    await waitFor(() => broadcast.mock.calls.length > 0)

    expect(broadcast).toHaveBeenCalled()
  })

  it('does not double-emit when two ticks overlap before notified_at commits', async () => {
    const job = makeJob({ status: 'submitted', remote_handle: undefined, started_at: undefined })
    let notifiedCount = 0
    const update = vi.fn((_id: string, u: unknown) => {
      const patch = u as { notified_at?: number }
      if (patch.notified_at !== undefined) notifiedCount++
      return Promise.resolve({ ...job, ...(u as object) })
    })
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([])),
      findErrorUnnotified: vi.fn(() => Promise.resolve([{ ...job, status: 'error' }])),
      get: vi.fn(() => Promise.resolve(job)),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const broadcast = vi.fn()
    const { poller } = makePollerWithFakeDriver(jobRepo, hostRepo, { broadcast, storageRoot: '/store' })

    // Two overlapping ticks before the first notified_at write completes.
    await Promise.all([poller.tick(), poller.tick()])
    await new Promise((r) => setTimeout(r, 0))

    // In-flight dedup suppresses a duplicate emit.
    expect(notifiedCount).toBeLessThanOrEqual(1)
  })

  it('polls >8 jobs for one provider, observing every job (driver batches internally)', async () => {
    const jobs: ComputeJob[] = []
    for (let i = 0; i < 10; i++) {
      jobs.push(
        makeJob({
          job_id: `job-${i}`,
          remote_handle: JSON.stringify({
            version: 1,
            driver: 'direct',
            pid: 1000 + i,
            pgid: 1000 + i,
            paths: {
              workdir: `~/.openscience/jobs/job-${i}`,
              stdout: `~/.openscience/jobs/job-${i}/stdout`,
              stderr: `~/.openscience/jobs/job-${i}/stderr`,
              exitCode: `~/.openscience/jobs/job-${i}/exit_code`
            }
          })
        })
      )
    }
    const update = vi.fn((_id: string, u: unknown) =>
      Promise.resolve({ ...({ job_id: _id } as ComputeJob), ...(u as object) })
    )
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve(jobs)),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    for (const job of jobs) {
      driver.observations.set(job.job_id, {
        alive: false,
        exitCode: 0,
        hasExitCode: true,
        stdoutTail: '',
        stderrTail: ''
      })
    }

    await poller.tick()

    // Every job transitioned to success (one batched pollMany call for the provider).
    for (const job of jobs) {
      expect(update).toHaveBeenCalledWith(job.job_id, expect.objectContaining({ status: 'success' }))
    }
    expect(driver.pollCalls).toBe(1)
  })

  it('reads a legacy unversioned PID handle without rewrite', async () => {
    // Legacy rows store the old shape; parseRemoteHandle normalizes them so the poller keeps polling.
    const job = makeJob({
      remote_handle: JSON.stringify({
        pid: 1234,
        exit_code_path: '~/.openscience/jobs/job-1/exit_code',
        stdout_path: '~/.openscience/jobs/job-1/stdout',
        stderr_path: '~/.openscience/jobs/job-1/stderr',
        workdir: '~/.openscience/jobs/job-1'
      })
    })
    const parsed = parseRemoteHandle(job.remote_handle)
    expect(parsed?.kind).toBe('legacy-direct')

    const update = vi.fn((_id: string, u: unknown) => Promise.resolve({ ...job, ...(u as object) }))
    const jobRepo = {
      findNonTerminal: vi.fn(() => Promise.resolve([job])),
      update
    } as unknown as ComputeJobRepository
    const hostRepo = { get: vi.fn(() => Promise.resolve(sampleHost())) } as unknown as ComputeHostRepository

    const { poller, driver } = makePollerWithFakeDriver(jobRepo, hostRepo)
    driver.observations.set('job-1', {
      alive: false,
      exitCode: 0,
      hasExitCode: true,
      stdoutTail: '',
      stderrTail: ''
    })

    await poller.tick()

    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ status: 'success' }))
  })
})
