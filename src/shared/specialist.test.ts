import { describe, expect, it } from 'vitest'
import {
  deriveSpecialistName,
  validateSpecialistName,
  validateDisplayName,
  validateCreateSpecialistInput,
  emptyFullAccessConfig,
  emptySelectedConfig
} from './specialist'

describe('deriveSpecialistName', () => {
  it('converts display name to UPPER_SNAKE', () => {
    expect(deriveSpecialistName('RNA-seq Reviewer')).toBe('RNA_SEQ_REVIEWER')
  })

  it('collapses multiple separators', () => {
    expect(deriveSpecialistName('My  Cool  Specialist')).toBe('MY_COOL_SPECIALIST')
  })

  it('strips leading/trailing underscores', () => {
    expect(deriveSpecialistName('---foo---')).toBe('FOO')
  })

  it('falls back to SPECIALIST for empty/symbol-only input', () => {
    expect(deriveSpecialistName('---')).toBe('SPECIALIST')
    expect(deriveSpecialistName('')).toBe('SPECIALIST')
  })

  it('handles numeric characters', () => {
    expect(deriveSpecialistName('Agent 007')).toBe('AGENT_007')
  })
})

describe('validateSpecialistName', () => {
  it('accepts valid names', () => {
    expect(validateSpecialistName('RNA_SEQ_REVIEWER', [])).toBeUndefined()
    expect(validateSpecialistName('AB', [])).toBeUndefined()
    expect(validateSpecialistName('A_1_B', [])).toBeUndefined()
  })

  it('rejects empty name', () => {
    expect(validateSpecialistName('', [])).toBeTruthy()
  })

  it('rejects lowercase', () => {
    expect(validateSpecialistName('lowercase', [])).toBeTruthy()
  })

  it('rejects too-short name (1 char)', () => {
    expect(validateSpecialistName('A', [])).toBeTruthy()
  })

  it('rejects too-long name (33 chars)', () => {
    expect(validateSpecialistName('A'.repeat(33), [])).toBeTruthy()
  })

  it('accepts 32-char name', () => {
    expect(validateSpecialistName('A'.repeat(32), [])).toBeUndefined()
  })

  it('rejects reserved names', () => {
    expect(validateSpecialistName('REVIEWER', [])).toBeTruthy()
    expect(validateSpecialistName('NONE', [])).toBeTruthy()
    expect(validateSpecialistName('MAIN', [])).toBeTruthy()
  })

  it('rejects duplicate name via existingNames fallback', () => {
    expect(validateSpecialistName('MYBOT', ['MYBOT'])).toBeTruthy()
  })

  it('rejects duplicate name via existingIds map', () => {
    const map = new Map([['MYBOT', 'id-1']])
    expect(validateSpecialistName('MYBOT', [], undefined, map)).toBeTruthy()
  })

  it('allows same name for self when editing (currentId matches)', () => {
    const map = new Map([['MYBOT', 'id-1']])
    expect(validateSpecialistName('MYBOT', [], 'id-1', map)).toBeUndefined()
  })
})

describe('validateDisplayName', () => {
  it('accepts normal display names', () => {
    expect(validateDisplayName('RNA-seq Reviewer')).toBeUndefined()
  })

  it('rejects empty', () => {
    expect(validateDisplayName('')).toBeTruthy()
    expect(validateDisplayName('   ')).toBeTruthy()
  })

  it('rejects names over 80 chars', () => {
    expect(validateDisplayName('A'.repeat(81))).toBeTruthy()
  })

  it('accepts exactly 80 chars', () => {
    expect(validateDisplayName('A'.repeat(80))).toBeUndefined()
  })
})

describe('validateCreateSpecialistInput', () => {
  it('returns empty array for valid input', () => {
    expect(
      validateCreateSpecialistInput({ displayName: 'RNA Reviewer' }, [])
    ).toHaveLength(0)
  })

  it('returns displayName error when empty', () => {
    const errors = validateCreateSpecialistInput({ displayName: '' }, [])
    expect(errors.some((e) => e.field === 'displayName')).toBe(true)
  })

  it('returns name error when derived name is reserved', () => {
    const errors = validateCreateSpecialistInput(
      { displayName: 'Reviewer' },
      [],
      new Map([['REVIEWER', 'some-id']])
    )
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('returns name error when explicit name is duplicate', () => {
    const map = new Map([['MYBOT', 'id-1']])
    const errors = validateCreateSpecialistInput(
      { displayName: 'My Bot', name: 'MYBOT' },
      [],
      map
    )
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
