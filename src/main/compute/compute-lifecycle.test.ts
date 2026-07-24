import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import type { ComputeHost, ComputeJob } from '../../shared/compute'
import { ComputeService } from './compute-service'
import type { ComputeHostRepository } from './repository'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'
import type { ComputeJobRepository } from './job-repository'
import {
  sharedComputeDriverRegistry,
  type ComputeDriver,
  type DriverContext,
  type DriverHandle,
  type PollManyResult
} from './compute-driver'

// Bypass the real ssh -G resolution (same pattern as compute-service.test.ts).
const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}
vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
  return { ...original, resolveSshTarget: vi.fn(() => Promise.resolve(fakeTarget)) }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
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
  updatedAt: 1,
  ...overrides
})

const directHandle = (workdir: string, pid = 4321, pgid = 4321): string =>
  JSON.stringify({
    version: 1,
    driver: 'direct',
    pid,
    pgid,
    paths: {
      workdir,
      stdout: `${workdir}/stdout`,
      stderr: `${workdir}/stderr`,
      exitCode: `${workdir}/exit_code`
    }
  })

const slurmHandle = (workdir: string, schedulerJobId = '999'): string =>
  JSON.stringify({
    version: 1,
    driver: 'slurm',
    schedulerJobId,
    paths: {
      workdir,
      stdout: `${workdir}/stdout`,
      stderr: `${workdir}/stderr`,
      exitCode: `${workdir}/exit_code`
    }
  })

const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => {
  const workdir = overrides.remote_workdir ?? '/home/u/.openscience/jobs/job-1'
  return {
    job_id: 'job-1',
    provider_id: 'ssh:biowulf',
    shape: 'direct_ssh',
    session_id: 'sess-1',
    project_id: 'proj-1',
    status: 'running',
    intent: 'long job',
    command: 'sleep 999',
    command_hash: 'h',
    environment: undefined,
    resource_request: undefined,
    input_manifest: undefined,
    output_manifest: undefined,
    harvest_config: undefined,
    timeout_seconds: 3600,
    remote_workdir: workdir,
    remote_handle: directHandle(workdir),
    driver: 'direct',
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
  }
}

// A fake driver that records the cancel target so we can assert delegation (process-group vs scancel
// is exercised in direct-driver.test.ts / slurm-driver.test.ts; here we assert the SERVICE delegates
// to the snapshotted driver rather than re-deriving the target from mutable host config).
class RecordingDriver implements ComputeDriver {
  cancelCalls: Array<{ context: DriverContext; handle: DriverHandle }> = []
  constructor(readonly kind: 'direct' | 'slurm') {}
  dispatch(): Promise<DriverHandle> {
    return Promise.reject(new Error('not used'))
  }
  pollMany(): Promise<PollManyResult> {
    return Promise.resolve({ kind: 'ok', observations: new Map() })
  }
  async cancel(context: DriverContext, handle: DriverHandle): Promise<void> {
    this.cancelCalls.push({ context, handle })
  }
}

const makeJobRepo = (
  job: ComputeJob | null
): {
  repo: ComputeJobRepository
  updateCalls: ReturnType<typeof vi.fn>
  current: () => ComputeJob | null
} => {
  let state = job
  const updateCalls = vi.fn(async (_id: string, updates: unknown) => {
    state = { ...(state as ComputeJob), ...(updates as object) }
    return state
  })
  return {
    repo: {
      get: vi.fn(async () => state),
      update: updateCalls
    } as unknown as ComputeJobRepository,
    updateCalls,
    current: () => state
  }
}

const makeHostRepo = (host: ComputeHost | null = sampleHost()): ComputeHostRepository =>
  ({ get: vi.fn(async () => host) }) as unknown as ComputeHostRepository

const okRunner = (): SshRunner => ({
  run: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  }))
})

// Register fresh fake drivers on the shared registry before each test; the registry is a process-wide
// Map so re-registering the same kind overwrites the previous one (no unregister API needed).
let directDriver: RecordingDriver
let slurmDriver: RecordingDriver
beforeEach(() => {
  directDriver = new RecordingDriver('direct')
  slurmDriver = new RecordingDriver('slurm')
  sharedComputeDriverRegistry.register(directDriver)
  sharedComputeDriverRegistry.register(slurmDriver)
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// cancelJob
// ---------------------------------------------------------------------------

describe('ComputeService.cancelJob', () => {
  it('delegates to the Direct driver and transitions to cancelled + user_cancelled', async () => {
    const job = makeJob({ status: 'running', driver: 'direct' })
    const { repo: jobRepo, updateCalls, current } = makeJobRepo(job)
    const onJobUpdated = vi.fn()
    const service = new ComputeService(
      okRunner(),
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      onJobUpdated
    )

    const harvestFn = vi.fn(async () => {})
    await service.cancelJob('job-1', { harvestFn })

    // Delegated to the snapshotted Direct driver (not the Slurm one).
    expect(directDriver.cancelCalls).toHaveLength(1)
    expect(slurmDriver.cancelCalls).toHaveLength(0)
    // Cancel context uses the job's snapshotted workdir (design.md §6 — snapshot, not mutable config).
    expect(directDriver.cancelCalls[0].context.workdir).toBe('/home/u/.openscience/jobs/job-1')
    // Status transition + marker.
    expect(updateCalls).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'cancelled', errorCode: 'user_cancelled' })
    )
    expect(current()?.status).toBe('cancelled')
    expect(onJobUpdated).toHaveBeenCalled()
    // Harvest-after-cancel (design.md §4.4 — all terminal states harvest).
    expect(harvestFn).toHaveBeenCalledOnce()
  })

  it('delegates to the Slurm driver (scancel path) for a slurm-snapshotted job', async () => {
    const job = makeJob({
      status: 'running',
      driver: 'slurm',
      remote_handle: slurmHandle('/home/u/.openscience/jobs/job-1')
    })
    const { repo: jobRepo } = makeJobRepo(job)
    const service = new ComputeService(
      okRunner(),
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await service.cancelJob('job-1')

    // The slurm driver (which runs scancel) is used — NOT the direct process-group path.
    expect(slurmDriver.cancelCalls).toHaveLength(1)
    expect(directDriver.cancelCalls).toHaveLength(0)
    expect(slurmDriver.cancelCalls[0].handle).toMatchObject({
      driver: 'slurm',
      schedulerJobId: '999'
    })
  })

  it('is a no-op for terminal jobs (does not re-cancel a finished job)', async () => {
    const job = makeJob({ status: 'success' })
    const { repo: jobRepo, updateCalls } = makeJobRepo(job)
    const service = new ComputeService(
      okRunner(),
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await service.cancelJob('job-1')

    expect(directDriver.cancelCalls).toHaveLength(0)
    expect(updateCalls).not.toHaveBeenCalled()
  })

  it('still transitions to cancelled when the driver cancel throws (best-effort kill)', async () => {
    const job = makeJob({ status: 'running', driver: 'direct' })
    const { repo: jobRepo, current } = makeJobRepo(job)
    // Driver.cancel throws (host down) — must not block the status transition.
    directDriver.cancel = vi.fn(async () => {
      throw new Error('ssh: connect timeout')
    })
    const service = new ComputeService(
      okRunner(),
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await expect(service.cancelJob('job-1')).resolves.toBeUndefined()
    expect(current()?.status).toBe('cancelled')
  })

  it('throws when the job does not exist', async () => {
    const { repo: jobRepo } = makeJobRepo(null)
    const service = new ComputeService(
      okRunner(),
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )
    await expect(service.cancelJob('missing')).rejects.toThrow(/No compute job/)
  })
})

// ---------------------------------------------------------------------------
// cleanupJob
// ---------------------------------------------------------------------------

describe('ComputeService.cleanupJob', () => {
  // A runner that records the commands it runs so we can assert only `rm -rf <workdir>` is issued.
  const recordingRunner = (): { runner: SshRunner; commands: string[] } => {
    const commands: string[] = []
    const runner: SshRunner = {
      run: vi.fn(async (_t, cmd: string) => {
        commands.push(cmd)
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
      })
    }
    return { runner, commands }
  }

  it('deletes ONLY the job workdir for a terminal + harvested job', async () => {
    const workdir = '/home/u/.openscience/jobs/job-1'
    const job = makeJob({ status: 'success', harvested_at: Date.now(), remote_workdir: workdir })
    const { repo: jobRepo } = makeJobRepo(job)
    const { runner, commands } = recordingRunner()
    const service = new ComputeService(
      runner,
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await service.cleanupJob('job-1')

    expect(commands).toHaveLength(1)
    // The single command must be an rm -rf targeting exactly the job workdir (single-quoted).
    expect(commands[0]).toMatch(/^rm -rf '\/home\/u\/\.openscience\/jobs\/job-1'$/)
  })

  it('refuses to clean up a running (non-terminal) job', async () => {
    const job = makeJob({ status: 'running', harvested_at: undefined })
    const { repo: jobRepo } = makeJobRepo(job)
    const { runner, commands } = recordingRunner()
    const service = new ComputeService(
      runner,
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await expect(service.cleanupJob('job-1')).rejects.toThrow(/not in a terminal state/)
    // No deletion attempted — refuses BEFORE touching the remote.
    expect(commands).toHaveLength(0)
  })

  it('refuses to clean up a terminal but un-harvested job (would lose outputs)', async () => {
    const job = makeJob({ status: 'failed', harvested_at: undefined })
    const { repo: jobRepo } = makeJobRepo(job)
    const { runner, commands } = recordingRunner()
    const service = new ComputeService(
      runner,
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await expect(service.cleanupJob('job-1')).rejects.toThrow(/harvest has not completed/)
    expect(commands).toHaveLength(0)
  })

  it('refuses when the workdir does not embed the job id (image/weight/cache path guard)', async () => {
    // A workdir that does NOT contain the job id — e.g. a shared image/cache path. Must be refused
    // so cleanup can never delete image, weight, or cache directories (design.md §6, issue 04).
    const job = makeJob({
      status: 'success',
      harvested_at: Date.now(),
      remote_workdir: '/shared/images/pytorch-cuda'
    })
    const { repo: jobRepo } = makeJobRepo(job)
    const { runner, commands } = recordingRunner()
    const service = new ComputeService(
      runner,
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await expect(service.cleanupJob('job-1')).rejects.toThrow(/does not contain the job id/)
    expect(commands).toHaveLength(0)
  })

  it('refuses a relative / non-absolute workdir', async () => {
    const job = makeJob({
      status: 'success',
      harvested_at: Date.now(),
      remote_workdir: 'jobs/job-1'
    })
    const { repo: jobRepo } = makeJobRepo(job)
    const { runner, commands } = recordingRunner()
    const service = new ComputeService(
      runner,
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await expect(service.cleanupJob('job-1')).rejects.toThrow(/not an absolute or home-relative/)
    expect(commands).toHaveLength(0)
  })

  it('throws (and does not delete) when the remote rm fails', async () => {
    const job = makeJob({
      status: 'success',
      harvested_at: Date.now(),
      remote_workdir: '/home/u/.openscience/jobs/job-1'
    })
    const { repo: jobRepo } = makeJobRepo(job)
    const runner: SshRunner = {
      run: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'rm: permission denied',
        truncated: false,
        timedOut: false
      }))
    }
    const service = new ComputeService(
      runner,
      makeHostRepo(),
      undefined,
      undefined,
      undefined,
      jobRepo,
      vi.fn()
    )

    await expect(service.cleanupJob('job-1')).rejects.toThrow(/permission denied/)
  })
})
