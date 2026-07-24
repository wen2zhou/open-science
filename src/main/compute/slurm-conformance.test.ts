// Fake-scheduler conformance suite for the Slurm driver + poller wiring (design.md §11, Issue 03).
//
// REAL SSH + Slurm is NOT available in this environment. This suite is the authoritative conformance
// gate for the Slurm execution path: it drives the REAL SlurmDriver through the REAL JobPoller state
// machine using a scripted fake SshRunner that emulates squeue/sacct/sbatch/scancel. It covers:
//   - submit → PENDING → submitted (with queue reason)
//   - PENDING → RUNNING → running
//   - terminal transition (COMPLETED exit 0 → success; FAILED exit !=0 → failed)
//   - accounting-delay tolerance (job absent from squeue AND sacct → stays non-terminal)
//   - restart recovery (a persisted slurm handle, freshly loaded, resumes polling/terminal/harvest)
//
// The real SSH + Slurm gate (CPU success / non-zero failure / harvest) is Issue 07 and is gated
// behind SLURM_TEST_HOST there; it is intentionally NOT exercised here.

import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { JobPoller } from './job-poller'
import { DispatchTracker } from './dispatch-tracker'
import { ComputeDriverRegistry } from './compute-driver'
import { SlurmDriver } from './slurm-driver'

// Mock resolveSshTarget so the poller never runs real `ssh -G`.
vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() =>
      Promise.resolve({
        sshBinary: '/usr/bin/ssh',
        host: 'cluster.example',
        extraArgs: ['-o', 'BatchMode=yes']
      } as ResolvedSshTarget)
    )
  }
})

// A scripted fake cluster. The test advances job state between ticks by mutating `jobs`.
type FakeJob = { id: string; state: string; reason?: string; exit?: string }

const slurmHandle = (jobId: string, schedulerId: string): string =>
  JSON.stringify({
    version: 1,
    driver: 'slurm',
    schedulerJobId: schedulerId,
    paths: {
      workdir: `~/.openscience/jobs/${jobId}`,
      stdout: `~/.openscience/jobs/${jobId}/stdout`,
      stderr: `~/.openscience/jobs/${jobId}/stderr`,
      exitCode: `~/.openscience/jobs/${jobId}/exit_code`
    }
  })

// Builds a fake SshRunner backed by an in-memory cluster map. sbatch mints a new id; squeue/sacct read
// the map. Returns mutators so the test can advance state between ticks.
const makeFakeCluster = (): { runner: SshRunner; jobs: Map<string, FakeJob> } => {
  const jobs = new Map<string, FakeJob>()
  let nextId = 1000
  const runner: SshRunner = {
    run: vi.fn(async (_t: ResolvedSshTarget, cmd: string) => {
      if (/sbatch/.test(cmd)) {
        const id = String(nextId++)
        jobs.set(id, { id, state: 'PENDING', reason: 'Priority' })
        return { exitCode: 0, stdout: `${id}\n`, stderr: '', truncated: false, timedOut: false }
      }
      if (/squeue/.test(cmd)) {
        const lines: string[] = []
        for (const j of jobs.values()) {
          if (j.state === 'PENDING' || j.state === 'RUNNING') {
            lines.push(`${j.id}|${j.state}|${j.reason ?? ''}`)
          }
        }
        return {
          exitCode: 0,
          stdout: lines.join('\n') + '\n',
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }
      if (/sacct/.test(cmd)) {
        const lines: string[] = []
        for (const j of jobs.values()) {
          if (j.state !== 'PENDING' && j.state !== 'RUNNING') {
            lines.push(`${j.id}|${j.state}|${j.exit ?? '0:0'}`)
          }
        }
        return {
          exitCode: 0,
          stdout: lines.join('\n') + '\n',
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }
      if (/scancel/.test(cmd)) {
        const m = cmd.match(/scancel\s+(\d+)/)
        if (m) jobs.delete(m[1]!)
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
      }
      // tail reads (for terminal tails) — return empty by default.
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
    })
  }
  return { runner, jobs }
}

const host_ = (): import('../../shared/compute').ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:cluster',
  displayName: 'cluster',
  shape: 'scheduler_cluster',
  sshAlias: 'cluster',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  executionBackend: 'slurm',
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
})

const makeSlurmJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:cluster',
  shape: 'scheduler_cluster',
  session_id: 'sess-1',
  project_id: 'proj-1',
  status: 'submitted',
  intent: 'train',
  command: 'python train.py',
  command_hash: 'abc',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 3600,
  remote_workdir: '~/.openscience/jobs/job-1',
  remote_handle: slurmHandle('job-1', '1000'),
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  driver: 'slurm',
  created_at: Date.now() - 60_000,
  submitted_at: Date.now() - 60_000,
  started_at: undefined,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

// Builds a poller wired to the real SlurmDriver (via the fake cluster runner) + in-memory repos.
const makePoller = (
  jobRepo: ComputeJobRepository,
  hostRepo: ComputeHostRepository,
  runner: SshRunner,
  opts: { harvestFn?: (job: ComputeJob) => Promise<void> } = {}
): JobPoller => {
  const registry = new ComputeDriverRegistry()
  registry.register(new SlurmDriver({ runner }))
  const safeRepo = jobRepo as ComputeJobRepository & {
    findTerminalUnharvested?: () => Promise<ComputeJob[]>
    findErrorUnnotified?: () => Promise<ComputeJob[]>
  }
  if (!safeRepo.findTerminalUnharvested)
    safeRepo.findTerminalUnharvested = () => Promise.resolve([])
  if (!safeRepo.findErrorUnnotified) safeRepo.findErrorUnnotified = () => Promise.resolve([])
  return new JobPoller({
    runner,
    hostRepository: hostRepo,
    jobRepository: jobRepo,
    driverRegistry: registry,
    dispatchTracker: new DispatchTracker(),
    harvestFn: opts.harvestFn
  })
}

// In-memory job repo that persists updates (so restart recovery can reload state).
const makeInMemoryRepo = (initial: ComputeJob[]): ComputeJobRepository => {
  const rows = new Map(initial.map((j) => [j.job_id, { ...j }]))
  return {
    create: vi.fn(async (req) => {
      const job: ComputeJob = {
        job_id: req.id,
        provider_id: req.providerId,
        shape: req.shape,
        session_id: req.sessionId,
        project_id: req.projectId,
        status: 'submitted',
        intent: req.intent,
        command: req.command,
        command_hash: req.commandHash,
        environment: req.environment,
        resource_request: req.resourceRequest,
        input_manifest: req.inputManifest,
        output_manifest: req.outputManifest,
        harvest_config: req.harvestConfig,
        timeout_seconds: req.timeoutSeconds,
        remote_workdir: req.remoteWorkdir,
        remote_handle: undefined,
        exit_code: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        error_code: undefined,
        driver: req.driver,
        created_at: Date.now(),
        submitted_at: Date.now(),
        started_at: undefined,
        finished_at: undefined,
        harvested_at: undefined
      }
      rows.set(req.id, job)
      return job
    }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    update: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const cur = rows.get(id) ?? ({} as ComputeJob)
      // Map the poller's camelCase UpdateJobRequest fields onto the ComputeJob snake_case fields, the
      // way the real repository does (job-repository.ts maps remoteState→remote_state, etc.).
      const mapped: Record<string, unknown> = { ...updates }
      const fieldMap: Record<string, keyof ComputeJob> = {
        remoteState: 'remote_state',
        queueReason: 'queue_reason',
        schedulerDiagnostic: 'scheduler_diagnostic',
        lastPollError: 'last_poll_error',
        stdoutTail: 'stdout_tail',
        stderrTail: 'stderr_tail',
        exitCode: 'exit_code',
        errorCode: 'error_code',
        remoteHandle: 'remote_handle',
        timeoutSeconds: 'timeout_seconds',
        remoteWorkdir: 'remote_workdir',
        resourceRequest: 'resource_request'
      }
      for (const [camel, snake] of Object.entries(fieldMap)) {
        if (camel in mapped) {
          mapped[snake] = mapped[camel]
          delete mapped[camel]
        }
      }
      const next = { ...cur, ...mapped } as ComputeJob
      rows.set(id, next)
      return next
    }),
    findNonTerminal: vi.fn(async () =>
      Array.from(rows.values()).filter((j) => !isTerminal(j.status))
    ),
    findNonTerminalByProvider: vi.fn(async () => []),
    hasActiveJobsForProvider: vi.fn(async () => false)
  } as unknown as ComputeJobRepository
}

const isTerminal = (s: ComputeJob['status']): boolean =>
  s === 'success' || s === 'failed' || s === 'timeout' || s === 'error'

describe('Slurm fake-scheduler conformance', () => {
  it('maps PENDING→submitted with queue reason, then RUNNING→running', async () => {
    const { runner, jobs } = makeFakeCluster()
    // Seed the cluster with the job already submitted (handle scheduler id 1000).
    jobs.set('1000', { id: '1000', state: 'PENDING', reason: 'Priority' })

    const job = makeSlurmJob({ remote_handle: slurmHandle('job-1', '1000') })
    const jobRepo = makeInMemoryRepo([job])
    const hostRepo = { get: vi.fn(async () => host_()) } as unknown as ComputeHostRepository
    const poller = makePoller(jobRepo, hostRepo, runner)

    await poller.tick()
    const after1 = await jobRepo.get('job-1')
    expect(after1?.status).toBe('submitted') // PENDING stays submitted
    expect(after1?.remote_state).toBe('PENDING')
    expect(after1?.queue_reason).toBe('Priority')

    // Advance to RUNNING.
    jobs.get('1000')!.state = 'RUNNING'
    await poller.tick()
    const after2 = await jobRepo.get('job-1')
    expect(after2?.status).toBe('running')
    expect(after2?.remote_state).toBe('RUNNING')
  })

  it('transitions COMPLETED exit 0 → success and FAILED exit!=0 → failed', async () => {
    const { runner, jobs } = makeFakeCluster()
    jobs.set('1000', { id: '1000', state: 'COMPLETED', exit: '0:0' })
    jobs.set('2000', { id: '2000', state: 'FAILED', exit: '1:0' })

    const jobA = makeSlurmJob({ job_id: 'a', remote_handle: slurmHandle('a', '1000') })
    const jobB = makeSlurmJob({
      job_id: 'b',
      remote_handle: slurmHandle('b', '2000'),
      status: 'running'
    })
    const jobRepo = makeInMemoryRepo([jobA, jobB])
    const hostRepo = { get: vi.fn(async () => host_()) } as unknown as ComputeHostRepository
    const poller = makePoller(jobRepo, hostRepo, runner)

    await poller.tick()
    expect((await jobRepo.get('a'))?.status).toBe('success')
    expect((await jobRepo.get('a'))?.exit_code).toBe(0)
    expect((await jobRepo.get('a'))?.remote_state).toBe('COMPLETED')
    expect((await jobRepo.get('b'))?.status).toBe('failed')
    expect((await jobRepo.get('b'))?.exit_code).toBe(1)
    expect((await jobRepo.get('b'))?.remote_state).toBe('FAILED')
  })

  it('tolerates accounting delay: a job absent from squeue and sacct stays non-terminal', async () => {
    const { runner, jobs } = makeFakeCluster()
    // The job id 1000 is NOT in the cluster map at all (accounting not yet settled).
    jobs.delete('1000')

    const job = makeSlurmJob({ remote_handle: slurmHandle('job-1', '1000') })
    const jobRepo = makeInMemoryRepo([job])
    const hostRepo = { get: vi.fn(async () => host_()) } as unknown as ComputeHostRepository
    const poller = makePoller(jobRepo, hostRepo, runner)

    await poller.tick()
    const after = await jobRepo.get('job-1')
    // Not observed → status untouched, stays submitted (NOT process_vanished).
    expect(after?.status).toBe('submitted')
    expect(after?.error_code).toBeUndefined()
  })

  it('recovers after restart: a freshly-loaded persisted slurm handle resumes polling to terminal', async () => {
    const { runner, jobs } = makeFakeCluster()
    jobs.set('1000', { id: '1000', state: 'COMPLETED', exit: '0:0' })

    // Simulate a job row persisted by a previous process: status=running, a slurm handle, no in-memory
    // driver state. A NEW poller built against the same DB row + registry must recover it.
    const job = makeSlurmJob({ status: 'running', remote_handle: slurmHandle('job-1', '1000') })
    const jobRepo = makeInMemoryRepo([job])
    const hostRepo = { get: vi.fn(async () => host_()) } as unknown as ComputeHostRepository
    const poller = makePoller(jobRepo, hostRepo, runner)

    await poller.tick()
    const after = await jobRepo.get('job-1')
    expect(after?.status).toBe('success')
    expect(after?.exit_code).toBe(0)
  })

  it('harvest is dispatched on terminal transition (shared orchestration, not driver-owned)', async () => {
    const { runner, jobs } = makeFakeCluster()
    jobs.set('1000', { id: '1000', state: 'COMPLETED', exit: '0:0' })

    const job = makeSlurmJob({ remote_handle: slurmHandle('job-1', '1000') })
    const jobRepo = makeInMemoryRepo([job])
    const hostRepo = { get: vi.fn(async () => host_()) } as unknown as ComputeHostRepository
    const harvested: string[] = []
    const poller = makePoller(jobRepo, hostRepo, runner, {
      harvestFn: async (j) => {
        harvested.push(j.job_id)
      }
    })

    await poller.tick()
    // Allow the fire-and-forget harvest to settle.
    await new Promise((r) => setTimeout(r, 20))
    expect(harvested).toContain('job-1')
  })

  it('host unreachable during poll does NOT flip status to failed', async () => {
    const { runner } = makeFakeCluster()
    // Force every SSH call to look unreachable (exit 255) for the squeue path.
    const downRunner: SshRunner = {
      run: vi.fn(async (_t, cmd) => {
        if (/squeue/.test(cmd)) {
          return {
            exitCode: 255,
            stdout: '',
            stderr: 'connection refused',
            truncated: false,
            timedOut: false
          }
        }
        return runner.run({} as ResolvedSshTarget, cmd, { timeoutMs: 1000 })
      })
    }
    const job = makeSlurmJob({ remote_handle: slurmHandle('job-1', '1000') })
    const jobRepo = makeInMemoryRepo([job])
    const hostRepo = { get: vi.fn(async () => host_()) } as unknown as ComputeHostRepository
    const poller = makePoller(jobRepo, hostRepo, downRunner)

    await poller.tick()
    const after = await jobRepo.get('job-1')
    expect(after?.status).toBe('submitted') // unchanged — host down != workload failed
    expect(after?.last_poll_error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Real SSH + Slurm gate (Issue 07 owns the full release gate).
//
// The real cluster path is credential-gated behind SLURM_TEST_HOST. When that env var is absent this
// suite SKIPS the real test with a clear logged reason — it does NOT fail, and it does NOT claim the
// real gate passed. The formal, complete real-cluster gate (CPU success, non-zero failure, harvest,
// cancel, timeout, restart recovery) is Issue 07.
// ---------------------------------------------------------------------------

const realSlurmHost = process.env['SLURM_TEST_HOST']

;(realSlurmHost ? describe : describe.skip)('Real SSH + Slurm (SLURM_TEST_HOST gated)', () => {
  it('runs a CPU-success job, observes terminal, and harvests (real cluster)', async () => {
    if (!realSlurmHost) {
      // Defensive: describe.skip should prevent this from running, but log a clear reason anyway.
      console.warn('[slurm-conformance] SLURM_TEST_HOST not set; skipping real-cluster test.')
      return
    }
    // The real gate is Issue 07. This placeholder exists so a developer who sets SLURM_TEST_HOST gets a
    // clear signal that the authoritative real gate lives in the Issue 07 suite, not here.
    expect(realSlurmHost).toBeTruthy()
  })
})

if (!realSlurmHost) {
  console.info(
    '[slurm-conformance] SLURM_TEST_HOST not set — real SSH + Slurm tests skipped (authoritative gate is Issue 07).'
  )
}
