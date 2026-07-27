// Submit-time environment resolution (design.md §8.2 / §8.3, cross-cutting requirement).
//
// This is the single authoritative seam the submit path consults BEFORE approval and BEFORE any SSH.
// It:
//   1. Returns `undefined` when no environment is named — a plain command job, unchanged behavior.
//   2. Resolves a ready environment into a deterministic `preamble` + an audit `snapshot` that the
//      approval card, the job row, and both drivers (Direct SSH + Slurm) consume IDENTICALLY.
//   3. Fails with a structured, human-readable error for unknown / building / failed / stale
//      environments — never resolving to a usable preamble and never triggering SSH.
//
// It performs NO SSH and NO validation execution (issue 06 owns validation). It only reads the
// registry and renders the already-validated resolution into a preamble.
//
// Cross-cutting requirement: the submit path must keep Direct SSH and Slurm indifferent consumers of
// ONE resolved preamble. This module produces that preamble; the drivers render it verbatim.

import type {
  ComputeEnvironment,
  ComputeEnvironmentStatus,
  EnvironmentResolution
} from '../../shared/compute-environment'
import { renderEnvironmentPreamble } from '../../shared/compute-environment'
import type { ComputeEnvironmentRepository } from './environment-repository'

// The precise reason an environment was rejected. `unknown` = no such name registered; the others
// mirror the non-ready statuses a registered row can carry.
export type EnvironmentRejectionStatus = Exclude<ComputeEnvironmentStatus, 'ready'> | 'unknown'

export type EnvironmentResolutionError = {
  error_code: 'environment_not_ready'
  message: string
  environment_name: string
  environment_status: EnvironmentRejectionStatus
  // retry_after_user_action=true: the user must fix the environment (register/validate/repair) before
  // this job can be submitted. The system will NOT retry automatically.
  retry_after_user_action: boolean
}

// The audit snapshot persisted on the job row + shown in the approval card. It carries the chosen
// environment name, the spec hash (so a later spec change is detectable against this snapshot), and the
// resolution snapshot (design.md §8.3 — "approval and job audit save the selected environment / spec
// hash / resolution snapshot"). No secrets.
export type EnvironmentSnapshot = {
  id: string
  name: string
  providerId: string
  specHash: string
  resolution: EnvironmentResolution
  validatedAt: number | undefined
}

export type ResolvedEnvironment = {
  ok: true
  preamble: string
  snapshot: EnvironmentSnapshot
}

export type EnvironmentResolutionResult =
  ResolvedEnvironment | { ok: false; error: EnvironmentResolutionError }

// Human-readable message for each rejection status. Pure so it is unit-testable.
const rejectionMessage = (name: string, status: EnvironmentRejectionStatus): string => {
  switch (status) {
    case 'unknown':
      return `Environment "${name}" is not registered on this provider. Register or validate it before submitting.`
    case 'building':
      return `Environment "${name}" is still building. Wait for it to reach Ready before submitting.`
    case 'validating':
      return `Environment "${name}" is still validating. Wait for it to reach Ready before submitting.`
    case 'failed':
      return `Environment "${name}" failed validation. Repair and re-validate it before submitting.`
    case 'stale':
      return `Environment "${name}" is stale (its spec or resolution changed). Re-validate it before submitting.`
    case 'draft':
      return `Environment "${name}" is a draft and has not been validated yet. Validate it before submitting.`
  }
}

// Resolves the environment named by a submit_job call. `undefined` name → undefined result (plain job).
// A ready env → { preamble, snapshot }. Any other registered status, or an unknown name → a structured
// error carrying the precise status so the caller can surface a readable message WITHOUT triggering SSH.
export const resolveEnvironmentForSubmit = async (
  repository: ComputeEnvironmentRepository,
  providerId: string,
  name: string | undefined
): Promise<EnvironmentResolutionResult | undefined> => {
  if (name === undefined || name === '') return undefined

  // The registry's ready-check is the authority (design.md §8.3). Only a ready row resolves.
  const ready = await repository.findReadyByName(providerId, name)
  if (ready) {
    if (!ready.resolution) {
      // A ready row must have a resolution; a corrupt/seeded row degrades here rather than producing a
      // usable preamble. Report as stale so the user re-validates.
      return {
        ok: false,
        error: {
          error_code: 'environment_not_ready',
          message: rejectionMessage(name, 'stale'),
          environment_name: name,
          environment_status: 'stale',
          retry_after_user_action: true
        }
      }
    }
    return {
      ok: true,
      preamble: renderEnvironmentPreamble(ready.resolution),
      snapshot: {
        id: ready.id,
        name: ready.name,
        providerId: ready.providerId,
        specHash: ready.specHash,
        resolution: ready.resolution,
        validatedAt: ready.validatedAt
      }
    }
  }

  // Not ready — discover the precise status so the error is actionable. List this provider's
  // environments and find the one with the requested name; if none matches, it is unknown. We have
  // already established the row is not `ready` (findReadyByName only returns ready rows), so any
  // matched status here is a non-ready value.
  const all = await repository.listByProvider(providerId)
  const match = all.find((e) => e.name === name)
  const status: EnvironmentRejectionStatus = match
    ? match.status === 'ready'
      ? 'unknown'
      : (match.status as EnvironmentRejectionStatus)
    : 'unknown'

  return {
    ok: false,
    error: {
      error_code: 'environment_not_ready',
      message: rejectionMessage(name, status),
      environment_name: name,
      environment_status: status,
      retry_after_user_action: true
    }
  }
}

// Re-exports for callers that build approval payloads from a snapshot.
export type { ComputeEnvironment, EnvironmentResolution }
