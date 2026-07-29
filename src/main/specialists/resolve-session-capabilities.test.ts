import { describe, it, expect } from 'vitest'
import {
  resolveSessionCapabilities,
  toEffectiveCapabilityBinding
} from './resolve-session-capabilities'
import type { StoredSpecialist } from '../settings/types'
import type { GlobalConnectorEntry, GlobalSkillEntry } from '../../shared/specialists/effective-capabilities'

// Integration-style tests for the runtime-side capability adapter. The ConnectorService specialist
// gate (src/main/connectors/service.ts) and the ACP runtime skill-whitelist builder both feed their
// binding + catalogs through resolveSessionCapabilities, so the connector allowlist the gate sees is
// exactly the whitelist a Claude Code session receives. These tests pin that single-calculation
// contract against realistic bundled + custom connector ids.

const skill = (id: string, frameworkName: string, enabled = true): GlobalSkillEntry => ({
  id,
  frameworkName,
  enabled
})
const connector = (id: string, enabled = true): GlobalConnectorEntry => ({ id, enabled })

const storedSpecialist = (overrides: Partial<StoredSpecialist> = {}): StoredSpecialist => ({
  id: 'spec-1',
  agentId: 'spec-1',
  name: 'Spec',
  description: '',
  instructions: '',
  colorKey: 'blue',
  iconKey: 'flask',
  skillIds: [],
  connectorIds: [],
  enabled: true,
  revision: 1,
  ...overrides
})

describe('resolveSessionCapabilities — single source for gate + whitelist', () => {
  const catalogs = {
    skills: [skill('s1', 'RNA-seq'), skill('s2', 'Proteomics'), skill('s3', 'Disabled', false)],
    connectors: [
      connector('chemistry'),
      connector('pubmed'),
      connector('uuid-custom-1'),
      connector('disabled-bundled', false)
    ]
  }

  it('none binding returns no connector restriction and no whitelist', () => {
    const caps = resolveSessionCapabilities(undefined, { custom: [], builtins: [] }, catalogs)
    expect(caps.kind).toBe('none')
    expect(caps.skillWhitelist).toBeUndefined()
  })

  it('bound specialist intersects skills and connectors with global enablement', () => {
    const specialist = storedSpecialist({
      skillIds: ['s1', 's2', 's3', 'missing'],
      connectorIds: ['chemistry', 'pubmed', 'disabled-bundled', 'uuid-custom-1', 'gone']
    })
    const caps = resolveSessionCapabilities(
      'spec-1',
      { custom: [specialist], builtins: [] },
      catalogs
    )
    expect(caps.kind).toBe('bound')
    if (caps.kind !== 'bound') return
    // RNA-seq + Proteomics are effective; s3 is globally disabled; missing is unresolved.
    expect(caps.skillNames).toEqual(['RNA-seq', 'Proteomics'])
    // Allowed connectors: chemistry + pubmed + uuid-custom-1 (effective); disabled-bundled is off;
    // gone is unresolved.
    expect(caps.connectorIds).toEqual(['chemistry', 'pubmed', 'uuid-custom-1'])
    // The whitelist the gate and the Claude setup both consume.
    expect(caps.skillWhitelist).toEqual(['RNA-seq', 'Proteomics'])
  })

  it('bound zero-skill specialist yields an explicit empty whitelist and empty connectors', () => {
    const specialist = storedSpecialist({ skillIds: [], connectorIds: [] })
    const caps = resolveSessionCapabilities(
      'spec-1',
      { custom: [specialist], builtins: [] },
      catalogs
    )
    expect(caps.kind).toBe('bound')
    if (caps.kind !== 'bound') return
    expect(caps.skillWhitelist).toEqual([])
    expect(caps.connectorIds).toEqual([])
  })

  it('unavailable binding (deleted/disabled specialist) is fail-closed: no skills, no connectors', () => {
    // Specialist is disabled in settings -> resolves unavailable.
    const specialist = storedSpecialist({ enabled: false })
    const caps = resolveSessionCapabilities(
      'spec-1',
      { custom: [specialist], builtins: [] },
      catalogs
    )
    expect(caps.kind).toBe('unavailable')
    if (caps.kind !== 'unavailable') return
    expect(caps.skillWhitelist).toEqual([])
    expect(caps.connectorIds).toEqual([])
  })

  it('unavailable binding resolves when the bound id is missing from the catalog', () => {
    const caps = resolveSessionCapabilities('ghost', { custom: [], builtins: [] }, catalogs)
    expect(caps.kind).toBe('unavailable')
  })

  it('toEffectiveCapabilityBinding maps none/bound/unavailable', () => {
    expect(toEffectiveCapabilityBinding(undefined, [], [])).toEqual({ kind: 'none' })
    expect(toEffectiveCapabilityBinding('ghost', [], [])).toEqual({
      kind: 'unavailable',
      specialistId: 'ghost'
    })
    const specialist = storedSpecialist({ skillIds: ['s1'], connectorIds: ['chemistry'] })
    const binding = toEffectiveCapabilityBinding('spec-1', [specialist], [])
    expect(binding.kind).toBe('bound')
    if (binding.kind !== 'bound') return
    expect(binding.specialist).toBe(specialist)
  })
})
