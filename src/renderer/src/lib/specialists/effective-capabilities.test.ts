// @vitest-environment node
// Pins the renderer-side effective-capability projection. The renderer must NOT re-implement the
// intersection: it delegates to the single shared resolver used by the runtime gate. These tests
// lock picker filtering per binding state, stale-chip send rejection, and the framework labels.
import { describe, expect, it } from 'vitest'

import type { SkillView, SpecialistView } from '../../../../shared/settings'

import {
  resolvePickerSkills,
  validateForcedSkillChips,
  resolveFrameworkStrengthLabel
} from './effective-capabilities'
import type { SessionSpecialistResolution } from './resolve-session-specialist'

const skill = (id: string, overrides: Partial<SkillView> = {}): SkillView => ({
  id,
  name: id,
  description: '',
  source: 'personal',
  updatedAt: '',
  enabled: true,
  ...overrides
})

const specialist = (id: string, overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id,
  agentId: id,
  name: id,
  skillIds: [],
  connectorIds: [],
  enabled: true,
  revision: 1,
  kind: 'custom',
  effectiveSkillCount: 0,
  effectiveConnectorCount: 0,
  ...overrides
})

const bound = (sp: SpecialistView): SessionSpecialistResolution => ({
  kind: 'bound',
  specialist: sp
})
const none = (): SessionSpecialistResolution => ({ kind: 'none' })
const unavailable = (id: string): SessionSpecialistResolution => ({
  kind: 'unavailable',
  specialistId: id
})

describe('resolvePickerSkills', () => {
  it('is unfiltered when the binding is None (today behaviour)', () => {
    const skills = [skill('a'), skill('b')]
    const result = resolvePickerSkills({ resolution: none(), skills })
    expect(result.filtered).toBe(false)
    expect(result.skills).toEqual(skills)
  })

  it('offers only globally-enabled skills the bound specialist allows, in resolver order', () => {
    const skills = [
      skill('a'),
      skill('b', { enabled: false }),
      skill('c'),
      skill('d') // globally enabled but not in the specialist allowlist
    ]
    const sp = specialist('sp', { skillIds: ['c', 'a', 'b'] }) // b globally disabled, d not listed
    const result = resolvePickerSkills({ resolution: bound(sp), skills })
    expect(result.filtered).toBe(true)
    expect(result.skills.map((s) => s.id)).toEqual(['c', 'a'])
  })

  it('offers no skills when the binding is unavailable (empty picker)', () => {
    const result = resolvePickerSkills({ resolution: unavailable('ghost'), skills: [skill('a')] })
    expect(result.filtered).toBe(true)
    expect(result.skills).toEqual([])
  })

  it('offers no skills when a bound specialist has an empty allowlist', () => {
    const sp = specialist('sp', { skillIds: [] })
    const result = resolvePickerSkills({ resolution: bound(sp), skills: [skill('a')] })
    expect(result.filtered).toBe(true)
    expect(result.skills).toEqual([])
  })
})

describe('validateForcedSkillChips (send-time rejection)', () => {
  it('allows any chip when the binding is None', () => {
    const result = validateForcedSkillChips(['anything'], { resolution: none(), skills: [] })
    expect(result.allowed).toBe(true)
  })

  it('rejects an explicit chip outside the effective allowlist with a stable reason', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    const result = validateForcedSkillChips(['b'], {
      resolution: bound(sp),
      skills: [skill('a'), skill('b')]
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.skillId).toBe('b')
      expect(result.reason).toContain('"b"')
      expect(result.reason.toLowerCase()).toContain('not allowed')
    }
  })

  it('rejects a stale chip that was valid before a Settings edit shrank the allowlist', () => {
    // The specialist originally allowed a + b; Settings edit removed b from the allowlist.
    const sp = specialist('sp', { skillIds: ['a'] })
    const result = validateForcedSkillChips(['a', 'b'], {
      resolution: bound(sp),
      skills: [skill('a'), skill('b')]
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.skillId).toBe('b')
  })

  it('rejects every chip when the binding is unavailable', () => {
    const result = validateForcedSkillChips(['a'], {
      resolution: unavailable('ghost'),
      skills: [skill('a')]
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain('unavailable')
  })

  it('allows chips that are all within the effective allowlist', () => {
    const sp = specialist('sp', { skillIds: ['a', 'b'] })
    const result = validateForcedSkillChips(['b', 'a'], {
      resolution: bound(sp),
      skills: [skill('a'), skill('b')]
    })
    expect(result.allowed).toBe(true)
  })
})

describe('resolveFrameworkStrengthLabel', () => {
  it('returns Hard enforced for Claude Code when bound', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    const result = resolveFrameworkStrengthLabel('claude-code', {
      resolution: bound(sp),
      skills: [skill('a')]
    })
    expect(result).toEqual({ label: 'Hard enforced', isNative: true })
  })

  it('returns Guidance only for Codex when bound', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    const result = resolveFrameworkStrengthLabel('codex', {
      resolution: bound(sp),
      skills: [skill('a')]
    })
    expect(result).toEqual({ label: 'Guidance only', isNative: false })
  })

  it('returns Guidance only for OpenCode when bound', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    const result = resolveFrameworkStrengthLabel('opencode', {
      resolution: bound(sp),
      skills: [skill('a')]
    })
    expect(result).toEqual({ label: 'Guidance only', isNative: false })
  })

  it('returns null when the binding is None (no specialist to label)', () => {
    expect(resolveFrameworkStrengthLabel('claude-code', { resolution: none(), skills: [] })).toBeNull()
  })

  it('returns null when the binding is unavailable', () => {
    expect(
      resolveFrameworkStrengthLabel('codex', { resolution: unavailable('ghost'), skills: [] })
    ).toBeNull()
  })
})
