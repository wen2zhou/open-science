// Provider-neutral resource request contract (design.md §5).
//
// `resources` was previously stored as inert JSON on the ComputeJob row. This module promotes it to a
// typed, Zod-validated contract that is checked at the RPC boundary (before approval / SSH) and
// serialized verbatim into the job audit snapshot. The schema is additive: unknown fields are rejected
// so the renderer/agent never silently drop a misspelled directive, but an empty/undefined request is
// always valid (Direct SSH needs no scheduler resources).
//
// IMPORTANT: this is the frozen baseline shape that Issue 02/03 (Slurm renderer) will consume. Field
// names and semantics must stay faithful to design.md §5.

import { z } from 'zod'

// Integer fields must be finite, non-negative integers. We allow the renderer to send null/undefined
// (optional) but reject NaN, Infinity, negatives, and non-integers so a bad value can never reach the
// renderer/approval card (design.md §5 — "validated at the RPC boundary").
const nonNegInt = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .refine((n) => Number.isSafeInteger(n), { message: 'must be a safe integer' })

// String fields are trimmed and length-capped so a stray 100 KB partition name cannot bloat the audit
// snapshot. Empty strings are rejected (use undefined instead). No control characters / newlines are
// permitted — these become scheduler directive arguments and must stay single-token-safe.
const schedulerToken = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[\x20-\x7E]+$/, { message: 'must be printable ASCII with no newlines' })

// Reserved scheduler directive keys a structured request must never carry directly. The user controls
// these via the dedicated structured fields (or the runner owns them). Rejecting them here prevents an
// advanced-directives escape hatch from overriding job name / stdout / workdir (design.md §4.5).
export const RESERVED_SCHEDULER_KEYS = new Set([
  'job-name',
  'jobname',
  'output',
  'error',
  'chdir',
  'workdir',
  'array',
  'wrap',
  'wait'
])

// The frozen ResourceRequest contract (design.md §5). `.strict()` rejects unknown keys so a typo'd
// field name surfaces as a structured error instead of being silently dropped.
export const ResourceRequestSchema = z
  .object({
    partition: schedulerToken.optional(),
    account: schedulerToken.optional(),
    qos: schedulerToken.optional(),
    nodes: nonNegInt.max(1_000_000).optional(),
    tasks: nonNegInt.max(1_000_000).optional(),
    cpusPerTask: nonNegInt.max(1_000_000).optional(),
    memoryMib: nonNegInt.max(8_388_608).optional(), // up to ~8 TiB
    gpus: nonNegInt.max(1_000_000).optional(),
    gpuType: schedulerToken.optional(),
    timeLimitSeconds: nonNegInt.max(7 * 24 * 3600).optional()
  })
  .strict()

// The TS type derived from the schema. This is the authoritative cross-process shape.
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>

// The backend selection persisted on ComputeHost (design.md §4.1).
//   auto    — resolve from the latest successful probe (slurm when detected, else direct).
//   direct  — always use the Direct SSH detached-process driver.
//   slurm   — always use the Slurm driver (requires explicit enablement; never auto-selected).
export type ExecutionBackendPreference = 'auto' | 'direct' | 'slurm'

export const EXECUTION_BACKEND_VALUES: readonly ExecutionBackendPreference[] = [
  'auto',
  'direct',
  'slurm'
] as const

export const ExecutionBackendPreferenceSchema = z.enum(['auto', 'direct', 'slurm'])

// The resolved driver snapshotted onto a job at submit time (design.md §4.1). Once written, a job's
// driver never changes even if the host is re-probed or its preference edited.
export type ResolvedDriver = 'direct' | 'slurm'

// A structured resource-validation error returned across the RPC boundary. Extends ComputeCallError
// with an optional `field` (the first failing field path, e.g. "gpus") for UI/agent debugging.
export type ResourceValidationError = {
  error_code: 'invalid_resources'
  message: string
  field?: string
  retry_after_user_action: boolean
}

// Parses + validates an unknown input (e.g. params.resources from the RPC boundary) into a
// ResourceRequest, or returns a structured error. Never throws.
export type ResourceValidation =
  { ok: true; request: ResourceRequest } | { ok: false; error: ResourceValidationError }

const fieldFromIssue = (path: PropertyKey[] | undefined): string | undefined => {
  if (!path || path.length === 0) return undefined
  return path.map(String).join('.')
}

// Validates a resource request. Accepts undefined / null (no resources requested) as a valid empty
// request. Rejects unknown fields, invalid numbers, and unsafe scheduler tokens with a structured error
// carrying the first offending field. Used by both the notebook RPC boundary and ComputeService so the
// contract is enforced exactly once, identically, at the security boundary (design.md §5).
export const validateResourceRequest = (input: unknown): ResourceValidation => {
  if (input === undefined || input === null) {
    return { ok: true, request: {} }
  }
  const parsed = ResourceRequestSchema.safeParse(input)
  if (parsed.success) {
    return { ok: true, request: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const field = fieldFromIssue(issue?.path)
  const reason =
    issue?.code === 'unrecognized_keys'
      ? `unknown field${(issue.keys ?? []).length ? `: ${(issue.keys ?? []).join(', ')}` : ''}`
      : (issue?.message ?? 'invalid value')
  const message = field ? `Invalid resources.${field}: ${reason}` : `Invalid resources: ${reason}`
  return {
    ok: false,
    error: {
      error_code: 'invalid_resources',
      message,
      field,
      retry_after_user_action: false
    }
  }
}

// Serializes a validated request to the compact JSON string stored in the job audit snapshot. Always
// omits undefined fields so the snapshot is stable/deterministic.
export const serializeResourceRequest = (request: ResourceRequest): string =>
  JSON.stringify(request)
