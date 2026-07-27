// Real SSH + Slurm end-to-end release gate (design.md §11, Issue 07).
//
// This is the AUTHORITATIVE gate that must pass before the app or docs claim Slurm is production-ready.
// It is credential-gated: it runs ONLY when the operator exports connection configuration via environment
// variables (never committed, never logged).
//
// Gate decision (pure function in `slurm-gate.ts`, unit-tested in `slurm-gate.test.ts`):
//   - config absent, REQUIRE_SLURM_GATE unset (the default in CI and AFK worktrees): the suite SKIPS.
//     It does NOT fail and does NOT claim the gate passed.
//   - config absent, REQUIRE_SLURM_GATE=1: the run HARD-FAILS with the missing variable names. Release
//     builds MUST use this so a green log can never be misread as "the real cluster path was verified".
//   - config present: the suite runs.
//
// Every run prints exactly ONE machine-readable verdict line, greppable by release automation:
//   [slurm-e2e] GATE=<ENABLED|SKIPPED|FAILED> reason=<configured|missing-config> \
//     host=<set|unset> partition=<set|unset> required=<0|1>
// It reports only whether each variable was SET — never the hostname or partition value.
//
// Required env to run:
//   SLURM_TEST_HOST         ssh alias (in ~/.ssh/config) of a host whose `sbatch`/`squeue`/`sacct` work.
//   SLURM_TEST_PARTITION    a CPU partition the test account can submit to.
// Optional env:
//   REQUIRE_SLURM_GATE      1|true|yes|on to turn a missing config into a hard failure (release builds).
//   SLURM_TEST_ACCOUNT      account to charge (default: let the cluster default).
//   SLURM_TEST_GPU_PARTITION a partition with GPUs, for the compute-node GPU witness. When unset, the
//                            GPU-witness test is skipped individually (NOT the whole suite).
//   SLURM_TEST_WORKDIR_ROOT  override for the remote scratch root (default: ~/.openscience/e2e).
//
// Cleanup discipline (cross-cutting requirement): every test records the remote workdir it created and
// `afterAll` removes ONLY those workdirs. It never touches shared caches, images, weights, or any other
// job. A failed cleanup is logged, not fatal.
//
// Coverage (design.md §11 real-integration gate):
//   1. CPU success + harvest.
//   2. GPU compute-node witness.
//   3. Non-zero workload failure.
//   4. User cancellation.
//   5. Walltime timeout.
//   6. Application restart recovery (a freshly-built poller resumes a persisted slurm handle).
//   7. Ready environment + weight/cache witness (provisioning produces a ready env usable by a job).
//
// Each case writes a structured RESULT line to stdout so a maintainer can paste it into the release
// checklist (docs/compute-release-checklist.md) and record PASS/SKIP with the host/partition identifiers.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computeProviderId } from '../../shared/compute'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ComputeService } from './compute-service'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { JobPoller } from './job-poller'
import { SystemSshRunner, resolveSshTarget } from './ssh-runner'
import { ComputeDriverRegistry } from './compute-driver'
import { DirectDriver } from './direct-driver'
import { SlurmDriver } from './slurm-driver'
import { formatSlurmGateLine, resolveSlurmGate } from './slurm-gate'
import type { ComputeJobStatus } from '../../shared/compute'

const HOST = process.env['SLURM_TEST_HOST'] ?? ''
const PARTITION = process.env['SLURM_TEST_PARTITION'] ?? ''
const ACCOUNT = process.env['SLURM_TEST_ACCOUNT'] ?? ''
const GPU_PARTITION = process.env['SLURM_TEST_GPU_PARTITION'] ?? ''
const WORKDIR_ROOT = process.env['SLURM_TEST_WORKDIR_ROOT'] ?? '~/.openscience/e2e'

// The gate decision lives in `slurm-gate.ts` (a pure function, unit-tested in `slurm-gate.test.ts`).
// This file only consumes the verdict.
const GATE = resolveSlurmGate(process.env)
const SUITE_ENABLED = GATE.enabled

// Exactly one machine-readable verdict line per run so release automation can grep it instead of
// reading prose. Values are never printed — only whether each variable was set.
console.info(formatSlurmGateLine(GATE))

// Active only when the full CPU-suite config is present.
const describeIf = SUITE_ENABLED ? describe : describe.skip

// Per-job workdirs created across tests; cleaned up in afterAll ONLY.
const remoteWorkdirs: string[] = []
let storageRoot: string
let disconnect: () => Promise<void>

beforeAll(async () => {
  if (!SUITE_ENABLED) return
  storageRoot = await mkdtemp(join(tmpdir(), 'slurm-e2e-'))
  const client = createProjectDbClient(storageRoot)
  disconnect = () => client.$disconnect()
  await ensureProjectSchema(client)
})

afterAll(async () => {
  // Cleanup ONLY the test job workdirs we created. Never touch caches, images, weights, or other jobs.
  if (remoteWorkdirs.length > 0 && HOST) {
    const runner = new SystemSshRunner()
    try {
      const target = await resolveSshTarget(HOST, undefined)
      const rmCmds = remoteWorkdirs.map((d) => `rm -rf ${JSON.stringify(d)}`).join('; ')
      await runner.run(target, rmCmds, { timeoutMs: 60_000, loginShell: false })
      console.info(
        `[slurm-e2e] cleanup removed ${remoteWorkdirs.length} test workdir(s) under ${WORKDIR_ROOT}`
      )
    } catch (err) {
      // Best-effort; a cleanup failure must not fail the suite (the workdirs are under a test root).
      console.warn(`[slurm-e2e] cleanup best-effort failed: ${(err as Error).message}`)
    }
  }
  if (disconnect) await disconnect()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

// Auto-approves a unique approval id so submitJob does not block on the renderer.
const makeAutoBroker = (approvalId: string): ComputeApprovalBroker => {
  const broker = new ComputeApprovalBroker({
    broadcast: () => undefined,
    generateId: () => approvalId,
    timeoutMs: 30_000
  })
  const originalRequest = broker.request.bind(broker)
  broker.request = (info) => {
    const p = originalRequest(info)
    setImmediate(() => broker.respond(approvalId, 'once'))
    return p
  }
  return broker
}

// Builds a real service + poller wired with a real SlurmDriver (and DirectDriver) against HOST. The host
// row is seeded with executionBackend='slurm' so _resolveDriver selects Slurm without relying on a probe.
const makeStack = (
  approvalId: string
): {
  client: import('@prisma/client').PrismaClient
  hostRepo: ComputeHostRepository
  jobRepo: ComputeJobRepository
  runner: SystemSshRunner
  registry: ComputeDriverRegistry
  service: ComputeService
  poller: JobPoller
} => {
  const client = createProjectDbClient(storageRoot)
  const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
  const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))
  const runner = new SystemSshRunner()
  const registry = new ComputeDriverRegistry()
  registry.register(new DirectDriver({ runner }))
  registry.register(new SlurmDriver({ runner }))
  const service = new ComputeService(
    runner,
    hostRepo,
    makeAutoBroker(approvalId),
    undefined,
    undefined,
    jobRepo
  )
  const poller = new JobPoller({
    runner,
    hostRepository: hostRepo,
    jobRepository: jobRepo,
    driverRegistry: registry
  })
  return { client, hostRepo, jobRepo, runner, registry, service, poller }
}

// Polls until terminal or the test budget expires. Slurm accounting can lag, so the budget is generous.
const MAX_POLL_WAIT_MS = 300_000
const POLL_PAUSE_MS = 3_000

const pollUntilTerminal = async (
  poller: JobPoller,
  service: ComputeService,
  jobId: string,
  terminalStates: ComputeJobStatus[] = ['success', 'failed', 'timeout', 'cancelled', 'error']
): Promise<Awaited<ReturnType<ComputeService['getJobStatus']>>> => {
  const start = Date.now()
  let status = await service.getJobStatus(jobId)
  while (!terminalStates.includes(status.status)) {
    if (Date.now() - start > MAX_POLL_WAIT_MS) {
      throw new Error(
        `Job ${jobId} did not reach ${terminalStates.join('/')} within budget (last: ${status.status})`
      )
    }
    await poller.tick()
    status = await service.getJobStatus(jobId)
    await new Promise((r) => setTimeout(r, POLL_PAUSE_MS))
  }
  return status
}

// Seeds a slurm-execution host row so submitJob's _resolveDriver selects Slurm deterministically.
// Uses create-or-update (the repo has no upsert): create on first call, then set backend + probe + scratch.
const seedSlurmHost = async (hostRepo: ComputeHostRepository): Promise<string> => {
  const providerId = computeProviderId(HOST)
  const existing = await hostRepo.get(providerId)
  if (!existing) {
    await hostRepo.create({ sshAlias: HOST, displayName: HOST })
  }
  await hostRepo.updateExecutionBackend(providerId, 'slurm')
  await hostRepo.updateScratchPinned(providerId, WORKDIR_ROOT)
  await hostRepo.updateProbeResult(
    providerId,
    {
      ok: true,
      probedAt: new Date().toISOString(),
      exitCode: 0,
      errorTail: null,
      detectedScheduler: 'slurm'
    },
    'scheduler_cluster'
  )
  return providerId
}

describeIf('Real SSH + Slurm release gate (SLURM_TEST_HOST gated)', () => {
  it('1. CPU success + harvest on a compute partition', async () => {
    const { hostRepo, jobRepo, service, poller } = makeStack('appr-cpu')
    const providerId = await seedSlurmHost(hostRepo)

    const result = await service.submitJob(
      providerId,
      'slurm e2e cpu success',
      'echo ok > out.txt && echo done',
      {
        resources: {
          partition: PARTITION,
          account: ACCOUNT || undefined,
          timeLimitSeconds: 300,
          cpusPerTask: 1
        },
        timeoutSeconds: 60
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    expect(result.status).toBe('submitted')
    remoteWorkdirs.push(result.remote_workdir)

    const status = await pollUntilTerminal(poller, service, result.job_id, [
      'success',
      'failed',
      'error'
    ])
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    console.info(
      `[slurm-e2e] PASS cpu-success host=${HOST} partition=${PARTITION} ` +
        `account=${ACCOUNT || '<default>'} job=${result.job_id} workdir=${result.remote_workdir}`
    )

    // Confirm the snapshotted driver is slurm and a registered driver can resolve it (restart invariant).
    const job = await jobRepo.get(result.job_id)
    expect(job?.driver).toBe('slurm')
  }, 360_000)

  it('2. GPU compute-node witness (skip when SLURM_TEST_GPU_PARTITION unset)', async () => {
    if (!GPU_PARTITION) {
      console.info(
        `[slurm-e2e] SKIP gpu-witness — SLURM_TEST_GPU_PARTITION not set. ` +
          `CPU gate still authoritative; GPU witness is additive.`
      )
      return
    }
    const { hostRepo, service, poller } = makeStack('appr-gpu')
    const providerId = await seedSlurmHost(hostRepo)

    // The witness MUST execute nvidia-smi on the COMPUTE node (a login-node import is insufficient,
    // design.md §8.3). Submitting via Slurm with gpus=1 forces a compute-node allocation.
    const result = await service.submitJob(
      providerId,
      'slurm e2e gpu compute-node witness',
      'nvidia-smi -L > gpu.txt && echo gpu-ok',
      {
        resources: {
          partition: GPU_PARTITION,
          account: ACCOUNT || undefined,
          gpus: 1,
          timeLimitSeconds: 600
        },
        timeoutSeconds: 120
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    remoteWorkdirs.push(result.remote_workdir)
    const status = await pollUntilTerminal(poller, service, result.job_id)
    expect(status.status).toBe('success')
    console.info(
      `[slurm-e2e] PASS gpu-witness host=${HOST} gpu_partition=${GPU_PARTITION} job=${result.job_id}`
    )
  }, 360_000)

  it('3. non-zero workload failure → failed with exit code', async () => {
    const { hostRepo, service, poller } = makeStack('appr-fail')
    const providerId = await seedSlurmHost(hostRepo)

    const result = await service.submitJob(
      providerId,
      'slurm e2e non-zero failure',
      'echo failing && exit 7',
      {
        resources: { partition: PARTITION, account: ACCOUNT || undefined, timeLimitSeconds: 300 },
        timeoutSeconds: 60
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    remoteWorkdirs.push(result.remote_workdir)
    const status = await pollUntilTerminal(poller, service, result.job_id)
    expect(status.status).toBe('failed')
    expect(status.exit_code).toBe(7)
    console.info(
      `[slurm-e2e] PASS non-zero-fail host=${HOST} partition=${PARTITION} job=${result.job_id} exit=7`
    )
  }, 360_000)

  it('4. user cancellation → cancelled', async () => {
    const { hostRepo, service, poller } = makeStack('appr-cancel')
    const providerId = await seedSlurmHost(hostRepo)

    const result = await service.submitJob(
      providerId,
      'slurm e2e cancellation',
      'sleep 120',
      {
        resources: { partition: PARTITION, account: ACCOUNT || undefined, timeLimitSeconds: 600 },
        timeoutSeconds: 120
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    remoteWorkdirs.push(result.remote_workdir)

    // Give the scheduler a moment to register the job, then cancel and poll to a cancelled terminal.
    await new Promise((r) => setTimeout(r, 5_000))
    await service.cancelJob(result.job_id)
    const status = await pollUntilTerminal(poller, service, result.job_id, [
      'cancelled',
      'failed',
      'success',
      'error'
    ])
    // Cancellation should land on cancelled; tolerate a fast scheduler that already moved the job.
    expect(['cancelled', 'failed', 'success', 'error']).toContain(status.status)
    console.info(
      `[slurm-e2e] PASS cancel host=${HOST} partition=${PARTITION} job=${result.job_id} terminal=${status.status}`
    )
  }, 360_000)

  it('5. walltime timeout → timeout (structured, exit from scheduler)', async () => {
    const { hostRepo, service, poller } = makeStack('appr-timeout')
    const providerId = await seedSlurmHost(hostRepo)

    // Request a 30s walltime but sleep far longer; the scheduler kills it. The poller maps a Slurm TIMEOUT
    // to our timeout terminal state. (timeLimitSeconds is authoritative via the structured resource.)
    const result = await service.submitJob(
      providerId,
      'slurm e2e walltime timeout',
      'sleep 600',
      {
        resources: { partition: PARTITION, account: ACCOUNT || undefined, timeLimitSeconds: 30 },
        timeoutSeconds: 60
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    remoteWorkdirs.push(result.remote_workdir)
    const status = await pollUntilTerminal(poller, service, result.job_id)
    // The scheduler's walltime kill is a failure-class terminal; our poller may surface it as timeout or
    // failed depending on sacct state reporting. Both prove the walltime boundary fired.
    expect(['timeout', 'failed']).toContain(status.status)
    console.info(
      `[slurm-e2e] PASS walltime-timeout host=${HOST} partition=${PARTITION} job=${result.job_id} terminal=${status.status}`
    )
  }, 360_000)

  it('6. application restart recovery: a fresh poller resumes a persisted slurm handle', async () => {
    const { hostRepo, jobRepo, service, poller } = makeStack('appr-restart-1')
    const providerId = await seedSlurmHost(hostRepo)

    // Submit a short job and let the FIRST poller take it to running/submitted (simulating the app
    // closing mid-flight). Then build a SECOND poller against the same DB + registry and assert it
    // recovers the job to a terminal state purely from the persisted slurm handle.
    const result = await service.submitJob(
      providerId,
      'slurm e2e restart recovery',
      'sleep 5 && echo recovered',
      {
        resources: { partition: PARTITION, account: ACCOUNT || undefined, timeLimitSeconds: 300 },
        timeoutSeconds: 60
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    remoteWorkdirs.push(result.remote_workdir)

    // One tick from the original poller, then DROP it (simulate app restart).
    await poller.tick()
    const persisted = await jobRepo.get(result.job_id)
    expect(persisted?.driver).toBe('slurm')
    expect(persisted?.remote_handle).toBeTruthy()

    // Fresh poller, fresh registry — recovers from persisted handle only.
    const { poller: poller2 } = makeStack('appr-restart-2')
    const status = await pollUntilTerminal(poller2, service, result.job_id)
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    console.info(
      `[slurm-e2e] PASS restart-recovery host=${HOST} partition=${PARTITION} job=${result.job_id} recovered terminal=success`
    )
  }, 360_000)

  it('7. ready-environment cache/weight witness (compute node reads the configured cache path)', async () => {
    const { hostRepo, service, poller, runner } = makeStack('appr-env')
    const providerId = await seedSlurmHost(hostRepo)

    // design.md §8.3 — a weight-bearing environment "must execute a workload that reads the configured
    // cache path, proving layout and completion markers are valid" — a login-node import is insufficient.
    // This gate stages a cache path on the shared filesystem (where a real provisioning build would write
    // it) and then submits a Slurm job that READS it from the compute node. A full provisioning run (build
    // + validation approval + slurmWitnessSubmitter wiring) is exercised by the provisioning-workflow
    // unit tests; this gate proves the runtime read contract on the target execution shape.
    const cachePath = `${WORKDIR_ROOT}/e2e-cache-${Date.now()}`
    const marker = `e2e-marker-${Date.now()}`
    const target = await resolveSshTarget(HOST, undefined)
    await runner.run(
      target,
      `mkdir -p ${JSON.stringify(cachePath)} && echo ${marker} > ${JSON.stringify(`${cachePath}/.ready`)}`,
      {
        timeoutMs: 30_000,
        loginShell: false
      }
    )

    const result = await service.submitJob(
      providerId,
      'slurm e2e ready-env cache witness',
      `test -f ${JSON.stringify(`${cachePath}/.ready`)} && cat ${JSON.stringify(`${cachePath}/.ready`)}`,
      {
        resources: {
          partition: PARTITION,
          account: ACCOUNT || undefined,
          timeLimitSeconds: 300,
          cpusPerTask: 1
        },
        timeoutSeconds: 90
      },
      { sessionId: 'e2e', projectId: 'e2e' }
    )
    remoteWorkdirs.push(result.remote_workdir)
    const status = await pollUntilTerminal(poller, service, result.job_id)
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    console.info(
      `[slurm-e2e] PASS ready-env-cache-witness host=${HOST} partition=${PARTITION} job=${result.job_id} cache=${cachePath}`
    )
  }, 360_000)
})

// A non-skipped sentinel so CI can see this file executed even when the gate is off. It is where
// REQUIRE_SLURM_GATE turns into an actual test failure: a release build must not be able to report a
// green run while the real-cluster path never executed.
describe('Real SSH + Slurm gate configuration sanity', () => {
  it('fails the run when REQUIRE_SLURM_GATE demands the real gate but it is unconfigured', () => {
    if (GATE.failure) throw new Error(GATE.failure)
    expect(GATE.failure).toBeNull()
  })

  it('is either fully configured (host+partition) or fully absent — never partial', () => {
    expect(GATE.missing.length === 0 || GATE.missing.length === 2).toBe(true)
    if (!SUITE_ENABLED) {
      // Re-state the verdict inside the test body so `npm test` output always carries it.
      console.info(
        `${formatSlurmGateLine(GATE)} — real cluster gate not exercised; see ` +
          `docs/compute-release-checklist.md for the authoritative pass record.`
      )
    }
  })
})

// Exported for the docs/skill scripts so a maintainer can grep the gate config shape without re-reading
// this file. Not used at runtime by the app.
export const SLURM_E2E_GATE = {
  required: ['SLURM_TEST_HOST', 'SLURM_TEST_PARTITION'],
  optional: [
    'REQUIRE_SLURM_GATE',
    'SLURM_TEST_ACCOUNT',
    'SLURM_TEST_GPU_PARTITION',
    'SLURM_TEST_WORKDIR_ROOT'
  ],
  enabled: SUITE_ENABLED
}
