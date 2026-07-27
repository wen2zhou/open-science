// Integration-style tests for ComputeService.provisionEnvironment (issue 06).
//
// Drives the REAL ComputeService against a real in-memory SQLite environment registry + a scripted
// fake SSH runner + an approving fake broker. Asserts the service-level provisioning contract: a
// ready environment is produced with recorded evidence, a failed witness marks the env failed, and the
// operation is `environment_provisioning` (distinct from submit_job).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import type { EnvironmentResolution, EnvironmentSpec } from '../../shared/compute-environment'
import { ComputeService } from './compute-service'
import { ComputeEnvironmentRepository } from './environment-repository'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner } from './ssh-runner'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined
let envRepo: ComputeEnvironmentRepository

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

const okRunner = (
  outcomes: { match: RegExp; result: { exitCode: number; stdout: string; stderr: string } }[] = []
): SshRunner => ({
  run: vi.fn(async (_target, command) => {
    for (const o of outcomes) {
      if (o.match.test(command)) return { ...o.result, truncated: false, timedOut: false }
    }
    return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
  })
})

const approvingBroker = (): ComputeApprovalBroker => {
  const d = vi.fn(() => Promise.resolve('once' as const))
  return { request: d, requestWithContext: d, respond: vi.fn() } as unknown as ComputeApprovalBroker
}

const hostRepo = (host: ComputeHost): ComputeHostRepository =>
  ({
    get: vi.fn(async () => host),
    list: vi.fn(async () => [])
  }) as unknown as ComputeHostRepository

const noJobRepo = (): ComputeJobRepository => ({}) as unknown as ComputeJobRepository

const CONDA: EnvironmentResolution = {
  kind: 'conda',
  envName: 'ml',
  activation: 'conda activate ml'
}
const SPEC: EnvironmentSpec = {
  runtime: 'conda',
  packages: ['numpy'],
  variables: {},
  weights: [],
  cachePath: '/scratch/cache/ml',
  smokeChecks: [{ command: 'python -c "import numpy"', kind: 'import' }]
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-prov-svc-'))
  const client = createProjectDbClient(storageRoot)
  disconnect = () => client.$disconnect()
  await ensureProjectSchema(client)
  envRepo = new ComputeEnvironmentRepository(() => Promise.resolve(client as PrismaClient))
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('ComputeService.provisionEnvironment', () => {
  it('provisions a Direct SSH environment to ready with recorded evidence', async () => {
    const env = await envRepo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    const broker = approvingBroker()
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      broker,
      undefined,
      undefined,
      noJobRepo(),
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const result = await service.provisionEnvironment({
      providerId: 'ssh:biowulf',
      environmentId: env.id,
      environmentName: 'ml',
      driver: 'direct',
      buildScriptSummary: 'conda env create -n ml',
      validationScriptSummary: 'python -c "import numpy"',
      resources: { cpusPerTask: 4 },
      cachePath: SPEC.cachePath,
      weightPaths: [],
      egressDomains: ['conda.anaconda.org'],
      witnessShape: { kind: 'direct-import' }
    })
    expect(result.ok).toBe(true)
    const final = await envRepo.get(env.id)
    expect(final?.status).toBe('ready')
    expect(
      (broker.requestWithContext as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    ).toMatchObject({ operation: 'environment_provisioning' })
  })

  it('marks the environment failed when the witness exits non-zero', async () => {
    const env = await envRepo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    const service = new ComputeService(
      okRunner([{ match: /import numpy/, result: { exitCode: 1, stdout: '', stderr: 'boom' } }]),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      noJobRepo(),
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const result = await service.provisionEnvironment({
      providerId: 'ssh:biowulf',
      environmentId: env.id,
      environmentName: 'ml',
      driver: 'direct',
      buildScriptSummary: 'conda env create -n ml',
      validationScriptSummary: 'python -c "import numpy"',
      resources: {},
      cachePath: undefined,
      weightPaths: [],
      egressDomains: [],
      witnessShape: { kind: 'direct-import' }
    })
    expect(result.ok).toBe(false)
    expect((await envRepo.get(env.id))?.status).toBe('failed')
  })

  it('a ready environment is now resolvable by the normal submit path', async () => {
    const env = await envRepo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      noJobRepo(),
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    await service.provisionEnvironment({
      providerId: 'ssh:biowulf',
      environmentId: env.id,
      environmentName: 'ml',
      driver: 'direct',
      buildScriptSummary: 'conda env create -n ml',
      validationScriptSummary: 'python -c "import numpy"',
      resources: {},
      cachePath: undefined,
      weightPaths: [],
      egressDomains: [],
      witnessShape: { kind: 'direct-import' }
    })
    const ready = await envRepo.findReadyByName('ssh:biowulf', 'ml')
    expect(ready?.status).toBe('ready')
  })
})

describe('ComputeService.provisionEnvironmentFromPayload (REPL entry)', () => {
  it('registers a draft row and provisions it to ready from a raw payload', async () => {
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      noJobRepo(),
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const result = await service.provisionEnvironmentFromPayload({
      provider_id: 'ssh:biowulf',
      name: 'ml',
      driver: 'direct',
      spec: SPEC,
      resolution: CONDA,
      build_script_summary: 'conda env create -n ml',
      validation_script_summary: 'python -c "import numpy"',
      resources: { cpusPerTask: 4 },
      egress_domains: ['conda.anaconda.org']
    })
    expect(result.ok).toBe(true)
    expect(result.environment_id).toBeDefined()
    expect(result.status).toBe('ready')
    const ready = await envRepo.findReadyByName('ssh:biowulf', 'ml')
    expect(ready?.status).toBe('ready')
  })

  it('rejects an invalid spec at the REPL boundary before any approval or SSH', async () => {
    const broker = approvingBroker()
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      broker,
      undefined,
      undefined,
      noJobRepo(),
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const err = await service
      .provisionEnvironmentFromPayload({
        provider_id: 'ssh:biowulf',
        name: 'bad',
        driver: 'direct',
        // conda resolution without activation is invalid.
        spec: { runtime: 'conda', packages: [] },
        resolution: { kind: 'conda', envName: 'x' }
      })
      .catch((e) => e)
    expect(err.computeCallError?.error_code).toBe('invalid_resources')
    expect(broker.requestWithContext as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(await envRepo.findReadyByName('ssh:biowulf', 'bad')).toBeNull()
  })

  it('reuses an existing row by name and re-validates after a spec change', async () => {
    await envRepo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'ready'
    })
    const service = new ComputeService(
      okRunner(),
      hostRepo(sampleHost()),
      approvingBroker(),
      undefined,
      undefined,
      noJobRepo(),
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    // Same name, changed spec -> re-provision flips stale back to ready.
    const result = await service.provisionEnvironmentFromPayload({
      provider_id: 'ssh:biowulf',
      name: 'ml',
      driver: 'direct',
      spec: { ...SPEC, packages: ['numpy', 'scipy'] },
      resolution: CONDA,
      validation_script_summary: 'python -c "import numpy"'
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ready')
  })
})
