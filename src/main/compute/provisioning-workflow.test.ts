// Unit + state-machine conformance tests for the environment provisioning workflow
// (issue 06 / design.md §9).
//
// REAL SSH + Slurm is NOT available in this environment (mirrors the Issue 03 conformance suite: the
// real cluster gate is Issue 07, gated behind SLURM_TEST_HOST). These tests drive the REAL
// ProvisioningWorkflow through scripted fake SSH runners and a real in-memory SQLite environment
// registry, so the plan -> approval -> build -> validate -> ready | failed state machine is
// exercised against genuine registry transitions and a genuine approval operation.
//
// Cross-cutting invariant under test: provisioning is an operation DISTINCT from submit_job with its
// own approval scope, and a failed validation never marks the environment ready.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ComputeEnvironment,
  EnvironmentResolution,
  EnvironmentSpec,
  EnvironmentValidationEvidence
} from '../../shared/compute-environment'
import { ComputeEnvironmentRepository } from './environment-repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import type { SshRunner } from './ssh-runner'
import { ProvisioningWorkflow } from './provisioning-workflow'
import type { ProvisioningPlan } from './provisioning-workflow'

import type { ComputeApprovalRequest, ComputeApprovalDecision } from '../../shared/compute'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined
let repo: ComputeEnvironmentRepository

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-prov-'))
  const client = createProjectDbClient(storageRoot)
  disconnect = () => client.$disconnect()
  await ensureProjectSchema(client)
  repo = new ComputeEnvironmentRepository(() => Promise.resolve(client as PrismaClient))
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const CONDA: EnvironmentResolution = {
  kind: 'conda',
  envName: 'ml',
  activation: 'source activate ml'
}
const SPEC: EnvironmentSpec = {
  runtime: 'conda',
  packages: ['numpy'],
  variables: {},
  weights: [],
  cachePath: '/scratch/cache/ml',
  smokeChecks: [{ command: 'python -c "import numpy; print(numpy.__version__)"', kind: 'import' }]
}

// A fake SSH runner that records the commands it ran and returns a scripted result per command.
// The default is exit 0 / empty output so witnesses "pass".
const makeRunner = (
  outcomes: { match: RegExp; result: { exitCode: number; stdout: string; stderr: string } }[] = []
): { runner: SshRunner; commands: string[] } => {
  const commands: string[] = []
  const runner: SshRunner = {
    run: vi.fn(async (_target, command) => {
      commands.push(command)
      for (const o of outcomes) {
        if (o.match.test(command)) return { ...o.result, truncated: false, timedOut: false }
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
    })
  }
  return { runner, commands }
}

// An approving broker that records the request + operation and resolves 'once'. The broker object is
// cast to the ProvisioningApprovalBroker shape the workflow consumes; its requestWithContext is the raw
// vi.fn so tests can assert on it directly.
const makeBroker = (): {
  broker: import('./provisioning-workflow').ProvisioningApprovalBroker
  getLast: () => { info: ComputeApprovalRequest; operation: string } | undefined
} => {
  let last: { info: ComputeApprovalRequest; operation: string } | undefined
  const requestWithContext = vi.fn(
    async (
      info: ComputeApprovalRequest,
      ctx: { sessionId: string; projectId: string; operation: string }
    ): Promise<ComputeApprovalDecision> => {
      last = { info, operation: ctx.operation }
      return 'once'
    }
  )
  const broker = {
    requestWithContext
  } as unknown as import('./provisioning-workflow').ProvisioningApprovalBroker
  return { broker, getLast: () => last }
}

// Builds a Direct-SSH provisioning plan for the env.
const directPlan = (env: ComputeEnvironment): ProvisioningPlan => ({
  providerId: env.providerId,
  environmentId: env.id,
  environmentName: env.name,
  driver: 'direct',
  buildScriptSummary: 'conda env create -n ml -f env.yml',
  validationScriptSummary: env.spec?.smokeChecks?.[0]?.command ?? 'python -c "import numpy"',
  resources: { cpusPerTask: 4, memoryMib: 8192 },
  cachePath: env.spec?.cachePath,
  weightPaths: (env.spec?.weights ?? []).map((w) => w.name),
  egressDomains: ['conda.anaconda.org'],
  witnessShape: { kind: 'direct-import' }
})

describe('ProvisioningWorkflow — lifecycle state machine', () => {
  it('runs a Direct SSH provisioning to ready and records validation evidence', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner, commands } = makeRunner()
    const { broker, getLast } = makeBroker()

    const wf = new ProvisioningWorkflow(repo, runner, broker, () => new Date(0))
    const result = await wf.run(directPlan(env))

    expect(result.ok).toBe(true)
    // Witnesses ran on the host (activation preamble + smoke command).
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.join('\n')).toMatch(/import numpy/)

    // The environment transitioned draft -> building -> validating -> ready.
    const final = await repo.get(env.id)
    expect(final?.status).toBe('ready')
    expect(final?.validation).toBeDefined()
    const evidence = final!.validation as EnvironmentValidationEvidence
    expect(evidence.result).toBe('ready')
    expect(evidence.exitCode).toBe(0)
    expect(evidence.specHash).toBe(env.specHash)
    expect(evidence.driver).toBe('direct')
    expect(evidence.command).toMatch(/import numpy/)

    // Approval fired under the DISTINCT environment_provisioning operation.
    expect(getLast()?.operation).toBe('environment_provisioning')
  })

  it('rejects a concurrent build for the same provider/name and never runs SSH', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'building'
    })
    const { runner, commands } = makeRunner()
    const { broker } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker)

    const result = await wf.run(directPlan(env))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('concurrent')
      expect(result.message).toMatch(/already (building|in progress)/i)
    }
    // No approval, no SSH.
    expect(broker.requestWithContext).not.toHaveBeenCalled()
    expect(commands).toHaveLength(0)
    // Status unchanged.
    expect((await repo.get(env.id))?.status).toBe('building')
  })

  it('marks the environment failed when validation exits non-zero and preserves evidence', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    // The import witness fails.
    const { runner } = makeRunner([
      { match: /import numpy/, result: { exitCode: 1, stdout: '', stderr: 'ModuleNotFoundError' } }
    ])
    const { broker } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker)

    const result = await wf.run(directPlan(env))
    expect(result.ok).toBe(false)

    const final = await repo.get(env.id)
    expect(final?.status).toBe('failed')
    const evidence = final!.validation as EnvironmentValidationEvidence
    expect(evidence.result).toBe('failed')
    expect(evidence.exitCode).toBe(1)
    expect(evidence.stderrSummary).toMatch(/ModuleNotFoundError/)
  })

  it('a ready environment cannot be resolved by a normal submit (guard remains)', async () => {
    // Provision first to ready.
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner } = makeRunner()
    const { broker } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker)
    await wf.run(directPlan(env))

    // The ready env IS resolvable; a non-ready env is NOT.
    const ready = await repo.findReadyByName('ssh:biowulf', 'ml')
    expect(ready?.status).toBe('ready')

    // A failed env must NOT resolve.
    const failedEnv = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'broken',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner: r2 } = makeRunner([
      { match: /import numpy/, result: { exitCode: 1, stdout: '', stderr: 'boom' } }
    ])
    const { broker: b2 } = makeBroker()
    await new ProvisioningWorkflow(repo, r2, b2).run(directPlan({ ...failedEnv, name: 'broken' }))
    expect(await repo.findReadyByName('ssh:biowulf', 'broken')).toBeNull()
  })

  it('weight-bearing validation actually reads the configured cache path', async () => {
    const spec: EnvironmentSpec = {
      runtime: 'conda',
      packages: ['torch'],
      variables: {},
      weights: [{ name: 'resnet50', uri: 'hf:resnet50' }],
      cachePath: '/scratch/cache/torch',
      smokeChecks: [
        { command: 'python -c "import torch; print(torch.cuda.is_available())"', kind: 'gpu' }
      ]
    }
    const env = await repo.create({
      providerId: 'ssh:gpu',
      name: 'torch',
      spec,
      resolution: { kind: 'conda', envName: 'torch', activation: 'conda activate torch' },
      initialStatus: 'draft'
    })
    // The cache-path witness must read /scratch/cache/torch; we assert the runner received a command
    // that references the cache path.
    const { runner, commands } = makeRunner()
    const { broker } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker)
    const result = await wf.run({
      providerId: env.providerId,
      environmentId: env.id,
      environmentName: env.name,
      driver: 'direct',
      buildScriptSummary: 'conda env create -n torch',
      validationScriptSummary: spec.smokeChecks![0]!.command,
      resources: { gpus: 1, gpuType: 'a100' },
      cachePath: spec.cachePath,
      weightPaths: ['resnet50'],
      egressDomains: ['huggingface.co'],
      witnessShape: { kind: 'direct-gpu' }
    })
    expect(result.ok).toBe(true)
    const allCommands = commands.join('\n')
    expect(allCommands).toContain('/scratch/cache/torch')
    const evidence = (await repo.get(env.id))!.validation as EnvironmentValidationEvidence
    expect(evidence.resourceShape).toMatchObject({ gpus: 1, gpuType: 'a100' })
  })

  it('Slurm GPU provisioning dispatches a compute-node GPU witness', async () => {
    const spec: EnvironmentSpec = {
      runtime: 'module',
      packages: [],
      variables: {},
      weights: [],
      cachePath: undefined,
      smokeChecks: [{ command: 'nvidia-smi', kind: 'gpu' }]
    }
    const env = await repo.create({
      providerId: 'ssh:gpu',
      name: 'cuda',
      spec,
      resolution: { kind: 'module', modules: ['cuda/12'] },
      initialStatus: 'draft'
    })
    // The Slurm witness is submitted through an injected submitJob callback that records the script.
    const submitted: { intent: string; command: string; resources: unknown }[] = []
    const { runner, commands } = makeRunner()
    const { broker } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker, () => new Date(0), {
      submitSlurmWitness: async (plan, witnessCommand) => {
        submitted.push({
          intent: plan.environmentName,
          command: witnessCommand,
          resources: plan.resources
        })
        return { exitCode: 0, stdout: 'GPU OK', stderr: '' }
      }
    })
    const result = await wf.run({
      providerId: env.providerId,
      environmentId: env.id,
      environmentName: env.name,
      driver: 'slurm',
      buildScriptSummary: 'module load cuda/12',
      validationScriptSummary: 'nvidia-smi',
      resources: { gpus: 1, partition: 'gpu' },
      cachePath: undefined,
      weightPaths: [],
      egressDomains: [],
      witnessShape: { kind: 'slurm-gpu' }
    })
    expect(result.ok).toBe(true)
    // The Slurm witness was dispatched (not run on the login node via SSH).
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.command).toBe('nvidia-smi')
    // Direct SSH runner was NOT used for the GPU witness.
    expect(commands.join('\n')).not.toContain('nvidia-smi')
    const final = await repo.get(env.id)
    expect(final?.status).toBe('ready')
    const evidence = final!.validation as EnvironmentValidationEvidence
    expect(evidence.driver).toBe('slurm')
  })

  it('records spec hash, command, driver, resource, exit code, output summary, time in evidence', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner } = makeRunner([
      {
        match: /import numpy/,
        result: { exitCode: 0, stdout: '1.26.0', stderr: 'warn' }
      }
    ])
    const { broker } = makeBroker()
    const fixedNow = new Date('2026-07-27T03:00:00.000Z')
    const wf = new ProvisioningWorkflow(repo, runner, broker, () => fixedNow)
    await wf.run(directPlan(env))
    const evidence = (await repo.get(env.id))!.validation as EnvironmentValidationEvidence
    expect(evidence.specHash).toBe(env.specHash)
    expect(evidence.command).toMatch(/import numpy/)
    expect(evidence.driver).toBe('direct')
    expect(evidence.exitCode).toBe(0)
    expect(evidence.stdoutSummary).toContain('1.26.0')
    expect(evidence.resourceShape).toMatchObject({ cpusPerTask: 4 })
    expect(evidence.validatedAt).toBe(fixedNow.toISOString())
  })

  it('the provisioning plan carries egress domains and cache/weight paths into the approval card', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner } = makeRunner()
    const { broker, getLast } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker)
    await wf.run(directPlan(env))
    const info = getLast()!.info as ComputeApprovalRequest & Record<string, unknown>
    expect(info.operation).toBe('environment_provisioning')
    expect(info.egress_domains).toEqual(['conda.anaconda.org'])
    expect(info.cache_path).toBe('/scratch/cache/ml')
    expect(info.build_script_summary).toMatch(/conda env create/)
    expect(info.validation_script_summary).toMatch(/import numpy/)
  })

  it('denied provisioning approval never touches the registry beyond a failed transition', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner, commands } = makeRunner()
    const deny = vi.fn(async () => 'deny' as ComputeApprovalDecision)
    const broker = {
      requestWithContext:
        deny as unknown as import('./provisioning-workflow').ProvisioningApprovalBroker['requestWithContext']
    }
    const wf = new ProvisioningWorkflow(repo, runner, broker)
    const result = await wf.run(directPlan(env))
    expect(result.ok).toBe(false)
    expect(commands).toHaveLength(0)
    // Registry stays in its pre-approval state (draft); no SSH, no ready.
    expect((await repo.get(env.id))?.status).toBe('draft')
    expect(await repo.findReadyByName('ssh:biowulf', 'ml')).toBeNull()
  })

  it('re-provisioning a ready env whose spec changed re-validates and flips stale back to ready', async () => {
    const env = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC,
      resolution: CONDA,
      initialStatus: 'draft'
    })
    const { runner } = makeRunner()
    const { broker } = makeBroker()
    const wf = new ProvisioningWorkflow(repo, runner, broker)
    await wf.run(directPlan(env))
    // Change the spec -> registry auto-stales a ready row.
    const updated = await repo.update(env.id, {
      spec: { ...SPEC, packages: ['numpy', 'scipy'] }
    })
    expect(updated.status).toBe('stale')
    // Re-provision flips it back to ready with fresh evidence.
    const refreshed = await repo.get(env.id)
    const result = await wf.run(directPlan(refreshed!))
    expect(result.ok).toBe(true)
    expect((await repo.get(env.id))?.status).toBe('ready')
  })
})
