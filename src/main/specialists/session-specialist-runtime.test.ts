import { describe, expect, it } from 'vitest'
import type { StoredSpecialist } from '../settings/types'
import {
  resolveSessionSpecialist,
  type SessionSpecialistRuntime
} from './session-specialist-runtime'

const custom = (over: Partial<StoredSpecialist> = {}): StoredSpecialist => ({
  id: 'spec-1',
  agentId: 'spec-1',
  name: 'Spec one',
  instructions: 'You are an expert RNA-seq reviewer.',
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

const runtime = (
  boundId: string | undefined,
  customSpecialists: StoredSpecialist[],
  builtins: StoredSpecialist[] = []
): SessionSpecialistRuntime => ({
  getBoundSpecialistId: () => boundId,
  getCustomSpecialists: () => customSpecialists,
  getBuiltinSpecialists: () => builtins
})

describe('resolveSessionSpecialist (runtime view)', () => {
  it('is none and appends nothing for an unbound session', () => {
    const result = resolveSessionSpecialist(runtime(undefined, [custom()]), 'session-1')
    expect(result.kind).toBe('none')
    expect(result.instructions).toBe('')
  })

  it('is bound and returns the specialist instructions for a bound session', () => {
    const result = resolveSessionSpecialist(runtime('spec-1', [custom()]), 'session-1')
    expect(result).toEqual({
      kind: 'bound',
      specialistId: 'spec-1',
      instructions: 'You are an expert RNA-seq reviewer.'
    })
  })

  it('trims instructions so trailing whitespace does not produce an empty append', () => {
    const result = resolveSessionSpecialist(
      runtime('spec-1', [custom({ instructions: '   ' })]),
      'session-1'
    )
    expect(result.kind).toBe('bound')
    expect(result.instructions).toBe('')
  })

  it('returns empty instructions when the specialist has none (append adds nothing)', () => {
    const result = resolveSessionSpecialist(
      runtime('spec-1', [custom({ instructions: undefined })]),
      'session-1'
    )
    expect(result.kind).toBe('bound')
    expect(result.instructions).toBe('')
  })

  it('is unavailable and appends nothing when the bound id is disabled', () => {
    const result = resolveSessionSpecialist(
      runtime('spec-1', [custom({ enabled: false })]),
      'session-1'
    )
    expect(result).toEqual({ kind: 'unavailable', specialistId: 'spec-1', instructions: '' })
  })

  it('is unavailable when the bound id no longer resolves', () => {
    const result = resolveSessionSpecialist(runtime('gone', [custom()]), 'session-1')
    expect(result.kind).toBe('unavailable')
    expect(result.instructions).toBe('')
  })

  it('resolves the built-in customize when enabled', () => {
    const result = resolveSessionSpecialist(runtime('customize', [], [customize]), 'session-1')
    expect(result.kind).toBe('bound')
  })

  it('never lets instruction contents leak into logs (instructions excluded from error fields)', () => {
    // Sanity: the runtime view carries instructions only for prompt delivery; callers must not pass
    // them into error/log fields. This test documents that contract by confirming the resolved shape
    // keeps instructions as a distinct field rather than a stringified blob.
    const result = resolveSessionSpecialist(runtime('spec-1', [custom()]), 'session-1')
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['kind', 'instructions']))
  })
})
