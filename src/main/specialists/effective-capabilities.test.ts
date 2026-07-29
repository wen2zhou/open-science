import { describe, it, expect } from 'vitest'
import {
  resolveEffectiveCapabilities,
  validateForcedSkill,
  frameworkEnforcementStrength,
  type GlobalSkillEntry,
  type GlobalConnectorEntry
} from './effective-capabilities'
import type { StoredSpecialist } from '../settings/types'

const makeSpecialist = (
  overrides: Partial<StoredSpecialist> = {}
): StoredSpecialist => ({
  id: 'sp-1',
  agentId: 'test-specialist',
  name: 'Test',
  skillIds: [],
  connectorIds: [],
  enabled: true,
  revision: 1,
  ...overrides
})

const skill = (id: string, name: string, enabled = true): GlobalSkillEntry => ({
  id,
  frameworkName: name,
  enabled
})

const connector = (id: string, enabled = true): GlobalConnectorEntry => ({
  id,
  enabled
})

describe('resolveEffectiveCapabilities', () => {
  describe('none binding', () => {
    it('returns no whitelist and all connectors unrestricted', () => {
      const result = resolveEffectiveCapabilities(
        { kind: 'none' },
        [skill('rna', 'RNA-seq'), skill('stat', 'Statistics')],
        [connector('pubmed'), connector('chembl')]
      )
      expect(result.kind).toBe('none')
      if (result.kind !== 'none') return
      expect(result.skillWhitelist).toBeUndefined()
      expect(result.connectorAllowlist).toBeUndefined()
    })
  })

  describe('unavailable binding', () => {
    it('returns empty skills and connectors with unavailable kind', () => {
      const result = resolveEffectiveCapabilities(
        { kind: 'unavailable', specialistId: 'sp-1' },
        [skill('rna', 'RNA-seq')],
        [connector('pubmed')]
      )
      expect(result.kind).toBe('unavailable')
      if (result.kind !== 'unavailable') return
      expect(result.skillIds).toEqual([])
      expect(result.skillNames).toEqual([])
      expect(result.connectorIds).toEqual([])
    })
  })

  describe('bound specialist', () => {
    it('intersects specialist skillIds with globally enabled skills', () => {
      const sp = makeSpecialist({ skillIds: ['rna', 'chem', 'unknown'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [skill('rna', 'RNA-seq'), skill('chem', 'Chemistry'), skill('stat', 'Statistics')],
        []
      )
      expect(result.kind).toBe('bound')
      if (result.kind !== 'bound') return
      expect(result.skillIds).toEqual(['rna', 'chem'])
      expect(result.skillNames).toEqual(['RNA-seq', 'Chemistry'])
    })

    it('preserves order from specialist.skillIds', () => {
      const sp = makeSpecialist({ skillIds: ['chem', 'rna'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [skill('rna', 'RNA-seq'), skill('chem', 'Chemistry')],
        []
      )
      if (result.kind !== 'bound') return
      expect(result.skillIds).toEqual(['chem', 'rna'])
      expect(result.skillNames).toEqual(['Chemistry', 'RNA-seq'])
    })

    it('excludes globally disabled skills', () => {
      const sp = makeSpecialist({ skillIds: ['rna', 'chem'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [skill('rna', 'RNA-seq', true), skill('chem', 'Chemistry', false)],
        []
      )
      if (result.kind !== 'bound') return
      expect(result.skillIds).toEqual(['rna'])
      expect(result.skillNames).toEqual(['RNA-seq'])
    })

    it('returns missing references for unresolvable skillIds', () => {
      const sp = makeSpecialist({ skillIds: ['rna', 'missing-skill'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [skill('rna', 'RNA-seq')],
        []
      )
      if (result.kind !== 'bound') return
      expect(result.missingSkillIds).toContain('missing-skill')
      expect(result.skillIds).not.toContain('missing-skill')
    })

    it('returns unavailable references for globally-disabled skillIds', () => {
      const sp = makeSpecialist({ skillIds: ['rna', 'chem'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [skill('rna', 'RNA-seq', true), skill('chem', 'Chemistry', false)],
        []
      )
      if (result.kind !== 'bound') return
      expect(result.unavailableSkillIds).toContain('chem')
    })

    it('intersects specialist connectorIds with globally enabled connectors', () => {
      const sp = makeSpecialist({ connectorIds: ['pubmed', 'chembl', 'unknown-conn'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [],
        [connector('pubmed'), connector('chembl'), connector('ensembl')]
      )
      if (result.kind !== 'bound') return
      expect(result.connectorIds).toEqual(['pubmed', 'chembl'])
    })

    it('preserves order from specialist.connectorIds', () => {
      const sp = makeSpecialist({ connectorIds: ['chembl', 'pubmed'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [],
        [connector('pubmed'), connector('chembl')]
      )
      if (result.kind !== 'bound') return
      expect(result.connectorIds).toEqual(['chembl', 'pubmed'])
    })

    it('excludes globally disabled connectors', () => {
      const sp = makeSpecialist({ connectorIds: ['pubmed', 'chembl'] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [],
        [connector('pubmed', true), connector('chembl', false)]
      )
      if (result.kind !== 'bound') return
      expect(result.connectorIds).toEqual(['pubmed'])
    })

    it('zero-skill specialist returns empty array (not undefined) skillNames', () => {
      const sp = makeSpecialist({ skillIds: [] })
      const result = resolveEffectiveCapabilities(
        { kind: 'bound', specialistId: 'sp-1', specialist: sp },
        [skill('rna', 'RNA-seq')],
        []
      )
      if (result.kind !== 'bound') return
      expect(result.skillIds).toEqual([])
      expect(result.skillNames).toEqual([])
      // skillWhitelist should be [] not undefined for bound specialist
      expect(result.skillWhitelist).toEqual([])
    })

    it('skillWhitelist is undefined for none binding', () => {
      const result = resolveEffectiveCapabilities({ kind: 'none' }, [], [])
      if (result.kind !== 'none') return
      expect(result.skillWhitelist).toBeUndefined()
    })
  })
})

describe('validateForcedSkill', () => {
  it('allows skills in the effective allowlist', () => {
    const sp = makeSpecialist({ skillIds: ['rna', 'chem'] })
    const capabilities = resolveEffectiveCapabilities(
      { kind: 'bound', specialistId: 'sp-1', specialist: sp },
      [skill('rna', 'RNA-seq'), skill('chem', 'Chemistry')],
      []
    )
    const result = validateForcedSkill('rna', capabilities)
    expect(result.allowed).toBe(true)
  })

  it('rejects skills outside the effective allowlist', () => {
    const sp = makeSpecialist({ skillIds: ['rna'] })
    const capabilities = resolveEffectiveCapabilities(
      { kind: 'bound', specialistId: 'sp-1', specialist: sp },
      [skill('rna', 'RNA-seq'), skill('chem', 'Chemistry')],
      []
    )
    const result = validateForcedSkill('chem', capabilities)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/not allowed|specialist/)
  })

  it('rejects all skills when binding is unavailable', () => {
    const capabilities = resolveEffectiveCapabilities(
      { kind: 'unavailable', specialistId: 'sp-1' },
      [skill('rna', 'RNA-seq')],
      []
    )
    const result = validateForcedSkill('rna', capabilities)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/unavailable|specialist/)
  })

  it('allows any skill when binding is none', () => {
    const capabilities = resolveEffectiveCapabilities({ kind: 'none' }, [], [])
    const result = validateForcedSkill('any-skill', capabilities)
    expect(result.allowed).toBe(true)
  })
})

describe('frameworkEnforcementStrength', () => {
  it('returns Hard enforced for claude-code', () => {
    const result = frameworkEnforcementStrength('claude-code')
    expect(result.label).toBe('Hard enforced')
    expect(result.isNative).toBe(true)
  })

  it('returns Guidance only for codex', () => {
    const result = frameworkEnforcementStrength('codex')
    expect(result.label).toBe('Guidance only')
    expect(result.isNative).toBe(false)
  })

  it('returns Guidance only for opencode', () => {
    const result = frameworkEnforcementStrength('opencode')
    expect(result.label).toBe('Guidance only')
    expect(result.isNative).toBe(false)
  })

  it('generates allowed-skill guidance text for non-native frameworks', () => {
    const result = frameworkEnforcementStrength('codex', ['RNA-seq', 'Chemistry'])
    expect(result.isNative).toBe(false)
    expect(result.guidanceText).toBeTruthy()
    expect(result.guidanceText).toContain('RNA-seq')
    expect(result.guidanceText).toContain('Chemistry')
    expect(result.guidanceText).not.toContain('enforcement')
  })
})
