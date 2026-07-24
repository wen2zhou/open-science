import { describe, expect, it } from 'vitest'

import {
  ResourceRequestSchema,
  validateResourceRequest,
  serializeResourceRequest
} from './compute-resources'

describe('ResourceRequestSchema', () => {
  it('accepts an empty object', () => {
    expect(ResourceRequestSchema.safeParse({}).success).toBe(true)
  })
  it('accepts a fully-populated valid request', () => {
    const parsed = ResourceRequestSchema.safeParse({
      partition: 'gpu',
      account: 'ac',
      qos: 'high',
      nodes: 1,
      tasks: 4,
      cpusPerTask: 8,
      memoryMib: 16384,
      gpus: 2,
      gpuType: 'a100',
      timeLimitSeconds: 3600
    })
    expect(parsed.success).toBe(true)
  })
  it('rejects unknown fields (strict)', () => {
    const parsed = ResourceRequestSchema.safeParse({ partiton: 'gpu' })
    expect(parsed.success).toBe(false)
  })
  it('rejects a negative number', () => {
    const parsed = ResourceRequestSchema.safeParse({ gpus: -1 })
    expect(parsed.success).toBe(false)
  })
  it('rejects a non-integer', () => {
    const parsed = ResourceRequestSchema.safeParse({ nodes: 1.5 })
    expect(parsed.success).toBe(false)
  })
  it('rejects NaN / Infinity', () => {
    expect(ResourceRequestSchema.safeParse({ gpus: NaN }).success).toBe(false)
    expect(ResourceRequestSchema.safeParse({ gpus: Infinity }).success).toBe(false)
  })
  it('rejects a scheduler token with a newline (unsafe for directives)', () => {
    expect(ResourceRequestSchema.safeParse({ partition: 'a\nb' }).success).toBe(false)
  })
  it('rejects an empty/whitespace token', () => {
    expect(ResourceRequestSchema.safeParse({ partition: '   ' }).success).toBe(false)
  })
})

describe('validateResourceRequest', () => {
  it('accepts undefined as an empty request', () => {
    const r = validateResourceRequest(undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.request).toEqual({})
  })
  it('accepts null as an empty request', () => {
    expect(validateResourceRequest(null).ok).toBe(true)
  })
  it('returns the parsed request on success', () => {
    const r = validateResourceRequest({ gpus: 2 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.request.gpus).toBe(2)
  })
  it('returns a structured error with a field path on bad value', () => {
    const r = validateResourceRequest({ gpus: -3 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.error_code).toBe('invalid_resources')
      expect(r.error.retry_after_user_action).toBe(false)
      expect(r.error.field).toBe('gpus')
      expect(r.error.message).toContain('gpus')
    }
  })
  it('returns a structured error naming the unknown key on strict rejection', () => {
    const r = validateResourceRequest({ bogus: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('bogus')
    }
  })
  it('never throws on garbage input', () => {
    expect(() => validateResourceRequest('nope')).not.toThrow()
    expect(() => validateResourceRequest(123)).not.toThrow()
    expect(() => validateResourceRequest([1, 2])).not.toThrow()
  })
})

describe('serializeResourceRequest', () => {
  it('omits undefined fields for a stable snapshot', () => {
    const s = serializeResourceRequest({ gpus: 1 })
    expect(JSON.parse(s)).toEqual({ gpus: 1 })
  })
  it('serializes an empty request to "{}"', () => {
    expect(serializeResourceRequest({})).toBe('{}')
  })
})
