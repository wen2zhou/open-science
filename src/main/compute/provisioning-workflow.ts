// Environment provisioning workflow (issue 06 / design.md §9).
//
// Environment build, weight hydration and validation are ONE operation — `environment_provisioning` —
// that is DISTINCT from an ordinary scientific `submit_job` (design.md §3 invariant 6, §9). It:
//   1. Builds a `ProvisioningPlan` that the approval card shows: provider, env name, build/validation
//      script summaries, resource request, cache/weight paths, and known egress domains.
//   2. Reserves the build: rejects a concurrent build for the same (providerId, name) and records the
//      registry lifecycle `draft -> building -> validating -> ready | failed` (design.md §8.3).
//   3. Requests ONE approval under operation `environment_provisioning` — a separate grant scope from
//      `submit_job`. A skill cannot disguise provisioning as a normal job to avoid this approval.
//   4. Executes witnesses appropriate to the driver:
//        - Direct SSH: activation preamble + CLI/import smoke witness.
//        - Slurm: a GPU witness that runs on a COMPUTE NODE (login-node import is insufficient).
//      Weight-bearing specs additionally run a witness that READS the configured cache path.
//   5. Records `EnvironmentValidationEvidence` (command, driver, resource shape, exit code, output
//      summary, timestamp, spec hash) and flips the registry to `ready` or `failed`.
//
// INVARIANTS (design.md §3 / §8.3 / §9):
//   - No secrets ever land in the plan or evidence (egress domains are hostnames, not credential URLs).
//   - A failed validation NEVER marks the environment ready; diagnostics are preserved.
//   - A successful validation flips the row to ready so the normal submit path can name it immediately.
//   - Slurm compute nodes are no-egress by default; downloads/hydration location is recorded in the
//     evidence (resourceShape / output summary) so reviewers know where data moved.
//
// REAL SSH + Slurm is NOT exercised here by the unit suite (mirrors Issue 03): the real cluster gate is
// Issue 07, gated behind SLURM_TEST_HOST. The SshRunner and submitSlurmWitness are injectable so the
// state machine is exercised against a real in-memory registry with scripted remotes.

import type { ComputeApprovalRequest, ComputeApprovalDecision } from '../../shared/compute'
import type { EnvironmentValidationEvidence } from '../../shared/compute-environment'
import { renderEnvironmentPreamble } from '../../shared/compute-environment'
import type { ResourceRequest } from '../../shared/compute-resources'
import type { ComputeEnvironmentRepository } from './environment-repository'
import { quoteRemotePath } from './job-dispatcher'
import type { SshRunner } from './ssh-runner'

// The driver a provisioning plan targets. Slurm witnesses run on a compute node; Direct witnesses run
// on the login/host shell.
export type ProvisioningDriver = 'direct' | 'slurm'

// Which witness shape the plan runs. Drives the witness command selection (design.md §8.3):
//   - direct-import: activation + CLI/import smoke (Direct SSH minimum)
//   - direct-gpu:    activation + a workload that reads the cache path (weight-bearing Direct)
//   - slurm-gpu:     a GPU witness submitted to run on a compute node (Slurm minimum for GPU envs)
export type WitnessShape =
  { kind: 'direct-import' } | { kind: 'direct-gpu' } | { kind: 'slurm-gpu' }

// The plan the approval card renders. All fields are plain data; no secrets. `egressDomains` are bare
// hostnames the build/validation is known to contact (conda.anaconda.org, huggingface.co, ...); they
// are documentation for the reviewer, never credential-bearing URLs.
export type ProvisioningPlan = {
  providerId: string
  environmentId: string
  environmentName: string
  driver: ProvisioningDriver
  buildScriptSummary: string
  validationScriptSummary: string
  resources: Partial<ResourceRequest>
  cachePath?: string
  weightPaths: string[]
  egressDomains: string[]
  witnessShape: WitnessShape
}

// The minimal broker surface this workflow needs. Mirrors ComputeApprovalBroker so the real broker can
// be passed directly while tests substitute a fake. `requestWithContext` is the grant-aware path: the
// provisioning operation gets its OWN conversation/project grant key, distinct from submit_job.
export type ProvisioningApprovalBroker = {
  requestWithContext: (
    info: Omit<ComputeApprovalRequest, 'id'>,
    ctx: { sessionId: string; projectId: string; operation: string }
  ) => Promise<ComputeApprovalDecision>
}

// Slurm witness injection point. The real wiring submits a one-shot job to a compute node (the GPU
// witness must run where the GPU is, not on the login node — design.md §8.3). Returns the remote
// exit/stdout/stderr so the workflow records the same evidence shape as the Direct path.
export type SlurmWitnessSubmitter = (
  plan: ProvisioningPlan,
  witnessCommand: string
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>

export type ProvisioningResult =
  | { ok: true; evidence: EnvironmentValidationEvidence }
  | { ok: false; reason: 'denied' | 'failed' | 'concurrent'; message: string }

// A witness execution result normalized across drivers.
type WitnessOutcome = {
  exitCode: number | null
  stdout: string
  stderr: string
  command: string
  driver: 'direct' | 'slurm'
}

const SUMMARY_MAX = 4096

// Trims a captured stream to a bounded summary for evidence storage (keeps the tail, which carries the
// actionable error). Bounded so a runaway log cannot bloat the registry row.
const summarize = (s: string): string => (s.length > SUMMARY_MAX ? `…${s.slice(-SUMMARY_MAX)}` : s)

export class ProvisioningWorkflow {
  constructor(
    private readonly repository: ComputeEnvironmentRepository,
    private readonly runner: SshRunner,
    private readonly broker: ProvisioningApprovalBroker,
    private readonly now: () => Date = () => new Date(),
    private readonly deps?: { submitSlurmWitness?: SlurmWitnessSubmitter }
  ) {}

  // Runs the full plan -> approval -> witness -> evidence flow. Never throws for an expected
  // provisioning outcome (denial, validation failure, concurrent build): those return a structured
  // `ok: false`. Only infrastructure errors throw.
  async run(plan: ProvisioningPlan): Promise<ProvisioningResult> {
    // ── RESERVE: atomically reject a concurrent build for the same (providerId, name) ──────────
    // Capture the pre-reservation state first (it drives the denial revert and the evidence specHash),
    // then reserve with a single conditional updateMany. That update IS the lock — there is no read-
    // then-write window, so two concurrent run() calls cannot both pass the guard and cross-run their
    // witnesses (design.md §8.3 — concurrent builds for the same provider/name are rejected or safely
    // serialized). Reserve flips the row to `building`, replacing the separate BUILDING update.
    const current = await this.repository.get(plan.environmentId)
    const reserved = await this.repository.reserveForProvisioning(plan.environmentId)
    if (!reserved) {
      return {
        ok: false,
        reason: 'concurrent',
        message: `Environment "${plan.environmentName}" is already building or validating; wait for it to reach a terminal state before re-provisioning.`
      }
    }

    // ── APPROVAL: the distinct environment_provisioning operation ──────────────────
    // The plan detail is carried in the approval info so the card can render provider, env name,
    // script summaries, resources, cache/weight paths and egress domains. Grant memory for this
    // operation is keyed separately from submit_job, so a provisioning grant never authorizes an
    // ordinary job and vice versa.
    const decision = await this.broker.requestWithContext(
      {
        provider_id: plan.providerId,
        provider_name: plan.providerId,
        shape: '',
        intent: `Provision environment "${plan.environmentName}"`,
        // Provisioning-plan fields (design.md §9). All plain data; no secrets.
        operation: 'environment_provisioning',
        build_script_summary: plan.buildScriptSummary,
        validation_script_summary: plan.validationScriptSummary,
        resources: JSON.stringify(plan.resources),
        cache_path: plan.cachePath,
        weight_paths: plan.weightPaths,
        egress_domains: plan.egressDomains,
        driver: plan.driver
      },
      {
        // A provisioning approval is session+project scoped like the other compute operations, but
        // under its own operation key.
        sessionId: 'provisioning',
        projectId: plan.providerId,
        operation: 'environment_provisioning'
      }
    )

    if (decision === 'deny') {
      // Revert to the prior terminal-ish state (draft/failed/stale). We do not mark failed here: a
      // denial is a user choice, not a validation failure. Keep diagnostics intact.
      const revertTo = current?.status === 'ready' ? 'stale' : (current?.status ?? 'draft')
      await this.repository.update(plan.environmentId, { status: revertTo as never })
      return {
        ok: false,
        reason: 'denied',
        message: `Provisioning approval was denied for environment "${plan.environmentName}".`
      }
    }

    // ── VALIDATING ────────────────────────────────────────────────────────────────
    await this.repository.update(plan.environmentId, { status: 'validating' })

    let outcome: WitnessOutcome
    try {
      outcome = await this.runWitness(plan)
    } catch (err) {
      // An infrastructure failure (SSH unreachable) is a failed validation, not a thrown error: the
      // registry must record the failure and stay diagnosable.
      const message = err instanceof Error ? err.message : String(err)
      const evidence: EnvironmentValidationEvidence = {
        specHash: current?.specHash ?? '',
        driver: plan.driver,
        resourceShape: plan.resources,
        command: plan.validationScriptSummary,
        exitCode: null,
        stdoutSummary: '',
        stderrSummary: summarize(message),
        validatedAt: this.now().toISOString(),
        result: 'failed'
      }
      await this.repository.recordValidation(plan.environmentId, evidence)
      return { ok: false, reason: 'failed', message }
    }

    const result: 'ready' | 'failed' = outcome.exitCode === 0 ? 'ready' : 'failed'
    const evidence: EnvironmentValidationEvidence = {
      specHash: current?.specHash ?? '',
      driver: outcome.driver,
      resourceShape: plan.resources,
      command: outcome.command,
      exitCode: outcome.exitCode,
      stdoutSummary: summarize(outcome.stdout),
      stderrSummary: summarize(outcome.stderr),
      validatedAt: this.now().toISOString(),
      result
    }

    await this.repository.recordValidation(plan.environmentId, evidence)
    return result === 'ready'
      ? { ok: true, evidence }
      : { ok: false, reason: 'failed', message: `Validation exited ${outcome.exitCode}.` }
  }

  // Executes the witness appropriate to the plan's driver/shape. The Direct path runs the activation
  // preamble followed by the smoke command on the host shell; the Slurm path submits a compute-node
  // job. Weight-bearing plans append a cache-path read so the witness proves the layout is usable.
  private async runWitness(plan: ProvisioningPlan): Promise<WitnessOutcome> {
    const validationCommand = plan.validationScriptSummary
    // A weight-bearing witness reads the configured cache path, proving layout + completion markers
    // are valid (design.md §8.3). Appended to the smoke command so the same witness proves both.
    // The path is shell-quoted: cachePath comes from the spec and must never be bare-interpolated, or
    // a value like `/x; rm -rf ~` would inject a second command into the approved witness.
    const cacheRead = plan.cachePath
      ? ` && test -d ${quoteRemotePath(plan.cachePath)} && ls ${quoteRemotePath(plan.cachePath)}`
      : ''

    if (plan.driver === 'slurm') {
      if (!this.deps?.submitSlurmWitness) {
        throw new Error('A Slurm provisioning plan requires a submitSlurmWitness dependency.')
      }
      const command = `${validationCommand}${cacheRead}`
      const res = await this.deps.submitSlurmWitness(plan, command)
      return { ...res, command, driver: 'slurm' }
    }

    // Direct SSH: activate the environment, then run the smoke (+ cache read) witness.
    const env = await this.repository.get(plan.environmentId)
    const preamble = env?.resolution ? renderEnvironmentPreamble(env.resolution) : ''
    const command = [preamble, `${validationCommand}${cacheRead}`].filter(Boolean).join('\n')
    const res = await this.runner.run(
      // The Direct driver resolves the SSH target from the host alias at dispatch time; this workflow
      // receives an already-bound runner whose target is supplied by the caller. Tests pass a fake
      // runner that ignores the target.
      { sshBinary: '', host: plan.providerId, extraArgs: [] },
      command,
      { timeoutMs: 5 * 60_000, loginShell: true }
    )
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      command,
      driver: 'direct'
    }
  }
}
