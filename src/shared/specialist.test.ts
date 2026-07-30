import { describe, expect, it } from 'vitest'
import {
  validateSpecialistName,
  validateCreateSpecialistInput,
  emptyFullAccessConfig,
  emptySelectedConfig
} from './specialist'

describe('validateSpecialistName', () => {
  it('accepts normal names', () => {
    expect(validateSpecialistName('RNA-seq Reviewer', [])).toBeUndefined()
    expect(validateSpecialistName('AB', [])).toBeUndefined()
    expect(validateSpecialistName('My Bot 2', [])).toBeUndefined()
  })

  it('rejects empty / whitespace-only name', () => {
    expect(validateSpecialistName('', [])).toBeTruthy()
    expect(validateSpecialistName('   ', [])).toBeTruthy()
  })

  it('rejects names over 80 chars', () => {
    expect(validateSpecialistName('A'.repeat(81), [])).toBeTruthy()
  })

  it('accepts exactly 80 chars', () => {
    expect(validateSpecialistName('A'.repeat(80), [])).toBeUndefined()
  })

  it('allows lowercase and spaces (human-readable)', () => {
    expect(validateSpecialistName('rna-seq reviewer', [])).toBeUndefined()
  })

  it('rejects duplicate name via existingNames fallback', () => {
    expect(validateSpecialistName('My Bot', ['My Bot'])).toBeTruthy()
  })

  it('rejects duplicate name via existingIds map', () => {
    const map = new Map([['My Bot', 'id-1']])
    expect(validateSpecialistName('My Bot', [], undefined, map)).toBeTruthy()
  })

  it('allows same name for self when editing (currentId matches)', () => {
    const map = new Map([['My Bot', 'id-1']])
    expect(validateSpecialistName('My Bot', [], 'id-1', map)).toBeUndefined()
  })
})

describe('validateCreateSpecialistInput', () => {
  it('returns empty array for valid input', () => {
    expect(validateCreateSpecialistInput({ name: 'RNA Reviewer' }, [])).toHaveLength(0)
  })

  it('returns name error when empty', () => {
    const errors = validateCreateSpecialistInput({ name: '' }, [])
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('returns name error when name is duplicate', () => {
    const map = new Map([['My Bot', 'id-1']])
    const errors = validateCreateSpecialistInput({ name: 'My Bot' }, [], map)
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })
})

describe('empty config helpers', () => {
  it('emptyFullAccessConfig returns correct shape', () => {
    const cfg = emptyFullAccessConfig()
    expect(cfg.excludedSkillIds).toEqual([])
    expect(cfg.excludedConnectorIds).toEqual([])
    expect(cfg.connectorTools).toEqual([])
  })

  it('emptySelectedConfig returns correct shape', () => {
    const cfg = emptySelectedConfig()
    expect(cfg.skillIds).toEqual([])
    expect(cfg.connectorIds).toEqual([])
    expect(cfg.connectorTools).toEqual([])
  })
})
