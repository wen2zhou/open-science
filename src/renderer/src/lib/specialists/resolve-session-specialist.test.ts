// @vitest-environment node
// Pins the renderer-side fail-closed binding resolver that the composer + send gate use to derive
// `none | bound | unavailable` from a persisted specialistId and the live SpecialistView catalog.
// This mirrors the main-process resolver (`resolveSessionSpecialistBinding`) so the renderer's
// Send-disable decision matches the runtime's instruction/allowlist decision for the same inputs.
import { describe, expect, it } from 'vitest'

import type { SpecialistView } from '../../../../shared/settings'

import { resolveSessionSpecialistView } from './resolve-session-specialist'

const custom = (
  id: string,
  overrides: Partial<SpecialistView> = {}
): SpecialistView => ({
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

const builtin = (id: string, overrides: Partial<SpecialistView> = {}): SpecialistView =>
  custom(id, { kind: id === 'reviewer' ? 'builtin-reviewer' : 'builtin-customize', ...overrides })

describe('resolveSessionSpecialistView', () => {
  it('resolves to none when the specialistId is missing or blank', () => {
    expect(resolveSessionSpecialistView(undefined, [])).toEqual({ kind: 'none' })
    expect(resolveSessionSpecialistView('', [])).toEqual({ kind: 'none' })
  })

  it('resolves an enabled, resolvable Specialist to bound', () => {
    const specialists = [custom('sp-1')]
    expect(resolveSessionSpecialistView('sp-1', specialists)).toEqual({
      kind: 'bound',
      specialist: specialists[0]
    })
  })

  it('resolves an enabled built-in customize to bound', () => {
    const specialists = [builtin('customize')]
    expect(resolveSessionSpecialistView('customize', specialists)).toEqual({
      kind: 'bound',
      specialist: specialists[0]
    })
  })

  it('resolves a disabled Specialist to unavailable (fail closed)', () => {
    const specialists = [custom('sp-1', { enabled: false })]
    expect(resolveSessionSpecialistView('sp-1', specialists)).toEqual({
      kind: 'unavailable',
      specialistId: 'sp-1'
    })
  })

  it('resolves a deleted/unknown id to unavailable rather than None', () => {
    expect(resolveSessionSpecialistView('ghost', [])).toEqual({
      kind: 'unavailable',
      specialistId: 'ghost'
    })
  })

  it('never binds the Reviewer built-in even when present in the catalog', () => {
    const specialists = [builtin('reviewer', { enabled: true })]
    expect(resolveSessionSpecialistView('reviewer', specialists)).toEqual({
      kind: 'unavailable',
      specialistId: 'reviewer'
    })
  })
})
