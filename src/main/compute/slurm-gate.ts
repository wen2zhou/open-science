// Gate decision for the real SSH + Slurm release gate (design.md §11, Issue 07).
//
// Pure decision layer: it takes an env-like record and returns whether the real-cluster suite runs,
// so the release-relevant branches are testable without a cluster. It NEVER reads `process.env`
// itself and never echoes credential-bearing values.

/** Env variables the gate reads. A plain record so tests can pass an isolated object. */
export type SlurmGateEnv = Record<string, string | undefined>

export interface SlurmGateDecision {
  /** True when the real-cluster suite should execute. */
  enabled: boolean
  /** Required variables that were absent or empty, in declaration order. */
  missing: string[]
  /** Non-null when the gate must hard-fail instead of skipping. */
  failure: string | null
  /** True when REQUIRE_SLURM_GATE opted in (release builds). */
  requireGate: boolean
}

const REQUIRED_VARS = ['SLURM_TEST_HOST', 'SLURM_TEST_PARTITION'] as const

// Only these opt-in spellings arm the hard failure. An exported-but-empty/`0`/`false` value (common in
// `.env` templates and CI matrices) must behave exactly like "unset" so a release build cannot be armed
// by accident, nor silently disarmed by a typo being read as truthy.
const REQUIRE_TRUTHY = new Set(['1', 'true', 'yes', 'on'])

export const resolveSlurmGate = (env: SlurmGateEnv): SlurmGateDecision => {
  const missing = REQUIRED_VARS.filter((name) => (env[name] ?? '') === '')
  const requireGate = REQUIRE_TRUTHY.has((env['REQUIRE_SLURM_GATE'] ?? '').trim().toLowerCase())
  const enabled = missing.length === 0
  const failure =
    !enabled && requireGate
      ? `REQUIRE_SLURM_GATE=1 demands the real SSH+Slurm gate, but it is not configured. ` +
        `Missing: ${missing.join(', ')}. Export ${missing
          .map((name) => `${name}=<value>`)
          .join(' ')} (see .env.example and docs/compute-release-checklist.md), ` +
        `or unset REQUIRE_SLURM_GATE for a non-release run.`
      : null
  return { enabled, missing, failure, requireGate }
}

// Single-line, machine-readable gate verdict. Release automation greps for `[slurm-e2e] GATE=` and
// asserts the status, so the shape is a stable contract: fixed key order, space separated `k=v`, no
// newlines. It deliberately reports only whether host/partition were SET (`<set>` / `<unset>`), never
// the values, so cluster hostnames stay out of CI logs.
export const formatSlurmGateLine = (decision: SlurmGateDecision): string => {
  const status = decision.enabled ? 'ENABLED' : decision.failure ? 'FAILED' : 'SKIPPED'
  const reason = decision.enabled ? 'configured' : 'missing-config'
  const present = (name: string): string => (decision.missing.includes(name) ? '<unset>' : '<set>')
  return (
    `[slurm-e2e] GATE=${status} reason=${reason} ` +
    `host=${present('SLURM_TEST_HOST')} partition=${present('SLURM_TEST_PARTITION')} ` +
    `required=${decision.requireGate ? '1' : '0'}`
  )
}
