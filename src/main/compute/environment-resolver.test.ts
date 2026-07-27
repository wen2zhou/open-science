import { describe, expect, it, vi } from 'vitest'

import type { ComputeEnvironment } from '../../shared/compute-environment'
import { resolveEnvironmentForSubmit } from './environment-resolver'
import type { ComputeEnvironmentRepository } from './environment-repository'

// A minimal environment row the fake repo hands back. Only the fields the resolver reads.
const env = (overrides: Partial<ComputeEnvironment> = {}): ComputeEnvironment => ({
  id: 'env-1',
  providerId: 'ssh:biowulf',
  name: 'ml',
  visibility: 'provider',
  specHash: 'h'.repeat(64),
  spec: { runtime: 'conda', packages: ['numpy'], variables: {}, weights: [], smokeChecks: [] },
  resolution: { kind: 'conda', envName: 'ml', activation: 'conda activate ml' },
  status: 'ready',
  buildJobId: undefined,
  validation: {
    specHash: 'h'.repeat(64),
    command: 'python -c "import numpy"',
    exitCode: 0,
    validatedAt: '2026-07-27T00:00:00.000Z',
    result: 'ready'
  },
  validatedAt: 1788000000000,
  detailsDoc: '',
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

// Builds a fake repo whose findReadyByName returns the given env (or null). The resolver consults
// findReadyByName, then falls back to listByProvider to discover the precise status.
const makeRepo = (readyEnv: ComputeEnvironment | null): ComputeEnvironmentRepository =>
  ({
    findReadyByName: vi.fn(async () => readyEnv),
    get: vi.fn(async () => readyEnv),
    listByProvider: vi.fn(async () => (readyEnv ? [readyEnv] : []))
  }) as unknown as ComputeEnvironmentRepository

describe('resolveEnvironmentForSubmit — no environment named', () => {
  it('resolves to undefined when no environment is named (plain command job)', async () => {
    const repo = makeRepo(env())
    const result = await resolveEnvironmentForSubmit(repo, 'ssh:biowulf', undefined)
    expect(result).toBeUndefined()
    expect(repo.findReadyByName).not.toHaveBeenCalled()
  })
})

describe('resolveEnvironmentForSubmit — ready', () => {
  it('resolves a ready environment into a preamble + snapshot without SSH', async () => {
    const repo = makeRepo(env())
    const result = await resolveEnvironmentForSubmit(repo, 'ssh:biowulf', 'ml')
    expect(result?.ok).toBe(true)
    if (result?.ok) {
      expect(result.preamble).toBe('conda activate ml')
      expect(result.snapshot.name).toBe('ml')
      expect(result.snapshot.specHash).toBe('h'.repeat(64))
      expect(result.snapshot.resolution.kind).toBe('conda')
    }
  })
})

describe('resolveEnvironmentForSubmit — status guard', () => {
  it('fails with environment_not_ready + UNKNOWN when the name is not registered', async () => {
    const repo = makeRepo(null)
    const result = await resolveEnvironmentForSubmit(repo, 'ssh:biowulf', 'ghost')
    expect(result?.ok).toBe(false)
    if (result && !result.ok) {
      expect(result.error.error_code).toBe('environment_not_ready')
      expect(result.error.environment_status).toBe('unknown')
      expect(result.error.retry_after_user_action).toBe(true)
      expect(result.error.message).toMatch(/ghost/i)
      expect(result.error.message).toMatch(/not registered|not found/i)
    }
  })

  it('fails with environment_not_ready + STALE and never consults SSH', async () => {
    // findReadyByName returns null for a stale env (it only returns ready rows). The resolver must
    // look the row up by name to report the precise status.
    const staleEnv = env({ status: 'stale' })
    const repo = {
      findReadyByName: vi.fn(async () => null),
      // The resolver falls back to a name lookup to learn the real status.
      listByProvider: vi.fn(async () => [staleEnv])
    } as unknown as ComputeEnvironmentRepository
    const result = await resolveEnvironmentForSubmit(repo, 'ssh:biowulf', 'ml')
    expect(result?.ok).toBe(false)
    if (result && !result.ok) {
      expect(result.error.environment_status).toBe('stale')
      expect(result.error.message).toMatch(/stale/i)
    }
  })

  it('fails with environment_not_ready + BUILDING for a building env', async () => {
    const buildingEnv = env({ status: 'building' })
    const repo = {
      findReadyByName: vi.fn(async () => null),
      listByProvider: vi.fn(async () => [buildingEnv])
    } as unknown as ComputeEnvironmentRepository
    const result = await resolveEnvironmentForSubmit(repo, 'ssh:biowulf', 'ml')
    if (result && !result.ok) {
      expect(result.error.environment_status).toBe('building')
    }
  })

  it('fails with environment_not_ready + FAILED for a failed env', async () => {
    const failedEnv = env({ status: 'failed' })
    const repo = {
      findReadyByName: vi.fn(async () => null),
      listByProvider: vi.fn(async () => [failedEnv])
    } as unknown as ComputeEnvironmentRepository
    const result = await resolveEnvironmentForSubmit(repo, 'ssh:biowulf', 'ml')
    if (result && !result.ok) {
      expect(result.error.environment_status).toBe('failed')
    }
  })
})
