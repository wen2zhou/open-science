import { describe, expect, it } from 'vitest'
import { resolveSessionSpecialistBinding } from './resolve-session-specialist'
import type { StoredSpecialist } from '../settings/types'

const custom = (over: Partial<StoredSpecialist> = {}): StoredSpecialist => ({
  id: 'spec-1',
  agentId: 'spec-1',
  name: 'Spec one',
  skillIds: [],
  connectorIds: [],
  enabled: true,
  revision: 1,
  ...over
})

const customize: StoredSpecialist = {
  id: 'customize',
  agentId: 'customize',
  name: 'Customize',
  skillIds: ['customize'],
  connectorIds: [],
  enabled: true,
  revision: 1
}

describe('resolveSessionSpecialistBinding', () => {
  it('resolves a missing id to none', () => {
    expect(resolveSessionSpecialistBinding(undefined, [custom()], [])).toEqual({ kind: 'none' })
  })

  it('resolves an empty string id to none', () => {
    expect(resolveSessionSpecialistBinding('', [custom()], [])).toEqual({ kind: 'none' })
  })

  it('resolves an enabled custom specialist to bound', () => {
    const result = resolveSessionSpecialistBinding('spec-1', [custom()], [])
    expect(result).toEqual({ kind: 'bound', specialistId: 'spec-1' })
  })

  it('resolves the enabled built-in customize to bound', () => {
    expect(resolveSessionSpecialistBinding('customize', [], [customize])).toEqual({
      kind: 'bound',
      specialistId: 'customize'
    })
  })

  it('resolves a disabled custom specialist to unavailable', () => {
    const result = resolveSessionSpecialistBinding('spec-1', [custom({ enabled: false })], [])
    expect(result).toEqual({ kind: 'unavailable', specialistId: 'spec-1' })
  })

  it('resolves the disabled built-in customize to unavailable', () => {
    expect(
      resolveSessionSpecialistBinding('customize', [], [{ ...customize, enabled: false }])
    ).toEqual({ kind: 'unavailable', specialistId: 'customize' })
  })

  it('resolves a deleted specialist id to unavailable (fail closed)', () => {
    expect(resolveSessionSpecialistBinding('gone', [custom()], [])).toEqual({
      kind: 'unavailable',
      specialistId: 'gone'
    })
  })

  it('never resolves the reviewer built-in as a session binding', () => {
    const reviewer: StoredSpecialist = {
      id: 'reviewer',
      agentId: 'reviewer',
      name: 'Reviewer',
      skillIds: [],
      connectorIds: [],
      enabled: true,
      revision: 1
    }
    expect(resolveSessionSpecialistBinding('reviewer', [], [reviewer])).toEqual({
      kind: 'unavailable',
      specialistId: 'reviewer'
    })
  })
})
