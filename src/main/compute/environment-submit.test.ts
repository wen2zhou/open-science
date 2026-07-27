import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import type { EnvironmentResolution, EnvironmentSpec } from '../../shared/compute-environment'
import { ComputeService } from './compute-service'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeEnvironmentRepository } from './environment-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner } from './ssh-runner'
import type { ComputeJob } from '../../shared/compute'

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

const okRunner = (): SshRunner => ({
  run: vi.fn(() =>
    Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
  )
})

const SPEC: EnvironmentSpec = {
  runtime: 'conda',
  packages: ['numpy'],
  variables: {},
  weights: [],
  smokeChecks: []
}
const CONDA: EnvironmentResolution = {
  kind: 'conda',
  envName: 'ml',
  activation: 'conda activate ml'
}

// A fake environment repo. `findReadyByName` returns the env when it is ready (matches the real
// repo's contract: only ready rows resolve). `listByProvider` returns whatever the test seeds.
const makeEnvRepo = (
  readyEnv: import('../../shared/compute-environment').ComputeEnvironment | null,
  allByProvider: import('../../shared/compute-environment').ComputeEnvironment[] = []
): ComputeEnvironmentRepository =>
  ({
    findReadyByName: vi.fn(async () => readyEnv),
    listByProvider: vi.fn(async () => allByProvider),
    get: vi.fn(async () => readyEnv),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    recordValidation: vi.fn()
  }) as unknown as ComputeEnvironmentRepository

const hostRepo = (host: ComputeHost): ComputeHostRepository =>
  ({
    get: vi.fn(async () => host),
    list: vi.fn(async () => [])
  }) as unknown as ComputeHostRepository

// A job repo double that records the create request so we can assert the persisted snapshot. Returns
// a `getCreated` closure (not a getter) so the assertion reads the value AFTER submitJob runs.
const jobRepoDouble = (): {
  repo: ComputeJobRepository
  getCreated: () => import('./job-repository').CreateJobRequest | undefined
} => {
  let created: import('./job-repository').CreateJobRequest | undefined
  const repo: ComputeJobRepository = {
    create: vi.fn(async (req: import('./job-repository').CreateJobRequest) => {
      created = req
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
        output_manifest: undefined,
        harvest_config: undefined,
        timeout_seconds: undefined,
        remote_workdir: undefined,
        remote_handle: undefined,
        exit_code: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        error_code: undefined,
        created_at: Date.now(),
        submitted_at: Date.now(),
        started_at: undefined,
        finished_at: undefined,
        harvested_at: undefined
      }
      return job
    }),
    get: vi.fn(async () => null),
    update: vi.fn(async () => ({}) as ComputeJob),
    findNonTerminal: vi.fn(async () => []),
    findNonTerminalByProvider: vi.fn(async () => []),
    hasActiveJobsForProvider: vi.fn(async () => false)
  } as unknown as ComputeJobRepository
  return { repo, getCreated: () => created }
}

const approvingBroker = (): ComputeApprovalBroker => {
  const d = vi.fn(() => Promise.resolve('once' as const))
  return { request: d, requestWithContext: d, respond: vi.fn() } as unknown as ComputeApprovalBroker
}

describe('ComputeService.submitJob — environment resolution + guard', () => {
  it('submits a plain command job (no environment) unchanged — no env repo consulted', async () => {
    const { repo: jobRepo } = jobRepoDouble()
    const envRepo = makeEnvRepo(null)
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const result = await service.submitJob(
      'ssh:biowulf',
      't',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )
    expect(result.status).toBe('submitted')
    expect(envRepo.findReadyByName).not.toHaveBeenCalled()
  })

  it('resolves a ready environment and persists the snapshot on the job row', async () => {
    const { repo: jobRepo, getCreated } = jobRepoDouble()
    const readyEnv = {
      id: 'env-1',
      providerId: 'ssh:biowulf',
      name: 'ml',
      visibility: 'provider' as const,
      specHash: 'h'.repeat(64),
      spec: SPEC,
      resolution: CONDA,
      status: 'ready' as const,
      buildJobId: undefined,
      validation: undefined,
      validatedAt: 1788000000000,
      detailsDoc: '',
      createdAt: 1,
      updatedAt: 2
    }
    const envRepo = makeEnvRepo(readyEnv)
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    await service.submitJob(
      'ssh:biowulf',
      't',
      'python train.py',
      { environment: 'ml' },
      { sessionId: 's1', projectId: 'p1' }
    )
    expect(envRepo.findReadyByName).toHaveBeenCalledWith('ssh:biowulf', 'ml')
    const created = getCreated()
    expect(created?.environment).toBe('ml')
    expect(created?.environmentSnapshot).toBeDefined()
    const snapshot = JSON.parse(created!.environmentSnapshot!)
    expect(snapshot.name).toBe('ml')
    expect(snapshot.specHash).toBe('h'.repeat(64))
    expect(snapshot.resolution.kind).toBe('conda')
  })

  it('rejects a stale environment BEFORE approval and never creates a row', async () => {
    const { repo: jobRepo, getCreated } = jobRepoDouble()
    const staleEnv = {
      ...{
        id: 'env-1',
        providerId: 'ssh:biowulf',
        name: 'ml',
        visibility: 'provider' as const,
        specHash: 'h'.repeat(64),
        spec: SPEC,
        resolution: CONDA,
        status: 'stale' as const,
        buildJobId: undefined,
        validation: undefined,
        validatedAt: undefined,
        detailsDoc: '',
        createdAt: 1,
        updatedAt: 2
      }
    }
    const envRepo = makeEnvRepo(null, [staleEnv])
    const broker = approvingBroker()
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      broker,
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const err = await service
      .submitJob(
        'ssh:biowulf',
        't',
        'python train.py',
        { environment: 'ml' },
        { sessionId: 's1', projectId: 'p1' }
      )
      .catch((e) => e)
    expect(err.computeCallError?.error_code).toBe('environment_not_ready')
    expect(err.computeCallError?.message).toMatch(/stale/i)
    // No approval fired, no SSH, no row.
    expect(broker.requestWithContext).not.toHaveBeenCalled()
    expect(getCreated()).toBeUndefined()
  })

  it('rejects an unknown environment name with a readable not-registered error', async () => {
    const { repo: jobRepo, getCreated } = jobRepoDouble()
    const envRepo = makeEnvRepo(null, [])
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const err = await service
      .submitJob(
        'ssh:biowulf',
        't',
        'python train.py',
        { environment: 'ghost' },
        { sessionId: 's1', projectId: 'p1' }
      )
      .catch((e) => e)
    expect(err.computeCallError?.error_code).toBe('environment_not_ready')
    expect(err.computeCallError?.message).toMatch(/ghost/i)
    expect(err.computeCallError?.message).toMatch(/not registered/i)
    expect(getCreated()).toBeUndefined()
  })

  it('rejects a building environment before approval', async () => {
    const { repo: jobRepo, getCreated } = jobRepoDouble()
    const buildingEnv = {
      id: 'env-1',
      providerId: 'ssh:biowulf',
      name: 'ml',
      visibility: 'provider' as const,
      specHash: 'h'.repeat(64),
      spec: SPEC,
      resolution: CONDA,
      status: 'building' as const,
      buildJobId: undefined,
      validation: undefined,
      validatedAt: undefined,
      detailsDoc: '',
      createdAt: 1,
      updatedAt: 2
    }
    const envRepo = makeEnvRepo(null, [buildingEnv])
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const err = await service
      .submitJob(
        'ssh:biowulf',
        't',
        'python train.py',
        { environment: 'ml' },
        { sessionId: 's1', projectId: 'p1' }
      )
      .catch((e) => e)
    expect(err.computeCallError?.error_code).toBe('environment_not_ready')
    expect(err.computeCallError?.message).toMatch(/building/i)
    expect(getCreated()).toBeUndefined()
  })

  it('passes the environment summary into the approval request', async () => {
    const { repo: jobRepo } = jobRepoDouble()
    const readyEnv = {
      id: 'env-1',
      providerId: 'ssh:biowulf',
      name: 'ml',
      visibility: 'provider' as const,
      specHash: 'h'.repeat(64),
      spec: SPEC,
      resolution: CONDA,
      status: 'ready' as const,
      buildJobId: undefined,
      validation: undefined,
      validatedAt: 1788000000000,
      detailsDoc: '',
      createdAt: 1,
      updatedAt: 2
    }
    const envRepo = makeEnvRepo(readyEnv)
    const broker = approvingBroker()
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      broker,
      undefined,
      undefined,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    await service.submitJob(
      'ssh:biowulf',
      't',
      'python train.py',
      { environment: 'ml' },
      { sessionId: 's1', projectId: 'p1' }
    )
    const info = (broker.requestWithContext as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0]
    expect(info.environment).toBe('ml (conda)')
  })
})
