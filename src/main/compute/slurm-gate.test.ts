// Gate-decision tests for the real SSH + Slurm release gate (design.md §11, Issue 07).
//
// The decision layer is a pure function so the three release-relevant branches (skip, hard-fail,
// run) are testable WITHOUT a cluster. `slurm-e2e.test.ts` consumes the same function at module
// scope; these tests are the only place the branch logic is exercised.

import { describe, expect, it } from 'vitest'

import { formatSlurmGateLine, resolveSlurmGate } from './slurm-gate'

describe('resolveSlurmGate', () => {
  it('enables the suite when host and partition are both configured', () => {
    const decision = resolveSlurmGate({
      SLURM_TEST_HOST: 'test-cluster',
      SLURM_TEST_PARTITION: 'quick'
    })

    expect(decision.enabled).toBe(true)
    expect(decision.missing).toEqual([])
    expect(decision.failure).toBeNull()
  })

  it('skips (does not fail) when config is absent and the gate is not required', () => {
    const decision = resolveSlurmGate({})

    expect(decision.enabled).toBe(false)
    expect(decision.failure).toBeNull()
    expect(decision.missing).toEqual(['SLURM_TEST_HOST', 'SLURM_TEST_PARTITION'])
  })

  it('hard-fails with actionable text when REQUIRE_SLURM_GATE=1 but config is missing', () => {
    const decision = resolveSlurmGate({
      REQUIRE_SLURM_GATE: '1',
      SLURM_TEST_HOST: 'test-cluster'
    })

    expect(decision.enabled).toBe(false)
    expect(decision.missing).toEqual(['SLURM_TEST_PARTITION'])
    expect(decision.failure).toContain('SLURM_TEST_PARTITION')
    expect(decision.failure).toContain('REQUIRE_SLURM_GATE=1')
  })

  it('treats REQUIRE_SLURM_GATE=0 as off so an exported-but-disabled value still skips', () => {
    const decision = resolveSlurmGate({ REQUIRE_SLURM_GATE: '0' })

    expect(decision.enabled).toBe(false)
    expect(decision.failure).toBeNull()
  })

  it('reads only the passed env, ignoring process.env, so runs cannot bleed into each other', () => {
    process.env['SLURM_TEST_HOST'] = 'leaked-cluster'
    process.env['SLURM_TEST_PARTITION'] = 'leaked-partition'
    try {
      expect(resolveSlurmGate({}).enabled).toBe(false)
    } finally {
      delete process.env['SLURM_TEST_HOST']
      delete process.env['SLURM_TEST_PARTITION']
    }
  })
})

describe('formatSlurmGateLine', () => {
  it('emits one greppable SKIPPED line when config is absent', () => {
    const line = formatSlurmGateLine(resolveSlurmGate({}))

    expect(line).toBe(
      '[slurm-e2e] GATE=SKIPPED reason=missing-config host=<unset> partition=<unset> required=0'
    )
    expect(line).not.toContain('\n')
  })

  it('reports ENABLED without leaking the configured host or partition values', () => {
    const line = formatSlurmGateLine(
      resolveSlurmGate({
        REQUIRE_SLURM_GATE: '1',
        SLURM_TEST_HOST: 'secret-login.internal',
        SLURM_TEST_PARTITION: 'quick'
      })
    )

    expect(line).toBe(
      '[slurm-e2e] GATE=ENABLED reason=configured host=<set> partition=<set> required=1'
    )
    expect(line).not.toContain('secret-login.internal')
    expect(line).not.toContain('quick')
  })

  it('marks the required-but-unconfigured case as FAILED so a green log cannot be misread', () => {
    const line = formatSlurmGateLine(
      resolveSlurmGate({ REQUIRE_SLURM_GATE: '1', SLURM_TEST_PARTITION: 'quick' })
    )

    expect(line).toBe(
      '[slurm-e2e] GATE=FAILED reason=missing-config host=<unset> partition=<set> required=1'
    )
  })
})
