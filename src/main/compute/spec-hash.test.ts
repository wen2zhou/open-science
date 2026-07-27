import { describe, expect, it } from 'vitest'

import { computeSpecHash } from './spec-hash'

describe('computeSpecHash', () => {
  it('is deterministic for the same spec', () => {
    const spec = { runtime: 'conda' as const, packages: ['numpy', 'scipy'] }
    expect(computeSpecHash(spec)).toBe(computeSpecHash(spec))
  })

  it('changes when the package order changes', () => {
    const a = computeSpecHash({ runtime: 'conda' as const, packages: ['numpy', 'scipy'] })
    const b = computeSpecHash({ runtime: 'conda' as const, packages: ['scipy', 'numpy'] })
    expect(a).not.toBe(b)
  })

  it('changes when a weight or cachePath changes', () => {
    const base = { runtime: 'conda' as const, packages: ['torch'] }
    const a = computeSpecHash(base)
    const b = computeSpecHash({ ...base, cachePath: '/data/cache' })
    expect(a).not.toBe(b)
  })

  it('is a 64-char hex sha256', () => {
    expect(computeSpecHash({ runtime: 'conda' })).toMatch(/^[0-9a-f]{64}$/)
  })
})
