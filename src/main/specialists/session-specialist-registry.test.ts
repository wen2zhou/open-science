import { describe, expect, it } from 'vitest'
import { SessionSpecialistRegistry } from './session-specialist-registry'

describe('SessionSpecialistRegistry', () => {
  it('reports none for a session that was never tracked', () => {
    const registry = new SessionSpecialistRegistry()

    expect(registry.get('session-1')).toEqual({ kind: 'none' })
  })

  it('reports bound after setting a specialist id', () => {
    const registry = new SessionSpecialistRegistry()
    registry.set('session-1', 'spec-uuid-1')

    expect(registry.get('session-1')).toEqual({ kind: 'bound', specialistId: 'spec-uuid-1' })
  })

  it('reports none after setting an explicit undefined id', () => {
    const registry = new SessionSpecialistRegistry()
    registry.set('session-1', 'spec-uuid-1')
    registry.set('session-1', undefined)

    expect(registry.get('session-1')).toEqual({ kind: 'none' })
  })

  it('tracks each session independently', () => {
    const registry = new SessionSpecialistRegistry()
    registry.set('session-1', 'spec-a')
    registry.set('session-2', 'spec-b')

    expect(registry.get('session-1')).toEqual({ kind: 'bound', specialistId: 'spec-a' })
    expect(registry.get('session-2')).toEqual({ kind: 'bound', specialistId: 'spec-b' })
  })

  it('switching a session to a new id overwrites the previous binding', () => {
    const registry = new SessionSpecialistRegistry()
    registry.set('session-1', 'spec-a')
    registry.set('session-1', 'spec-b')

    expect(registry.get('session-1')).toEqual({ kind: 'bound', specialistId: 'spec-b' })
  })

  it('clearing a bound session removes its entry', () => {
    const registry = new SessionSpecialistRegistry()
    registry.set('session-1', 'spec-a')
    registry.clear('session-1')

    expect(registry.get('session-1')).toEqual({ kind: 'none' })
  })

  it('clearing a session that was never tracked is a no-op', () => {
    const registry = new SessionSpecialistRegistry()

    expect(() => registry.clear('never-tracked')).not.toThrow()
    expect(registry.get('never-tracked')).toEqual({ kind: 'none' })
  })

  it('does not mutate other sessions when one is cleared', () => {
    const registry = new SessionSpecialistRegistry()
    registry.set('session-1', 'spec-a')
    registry.set('session-2', 'spec-b')
    registry.clear('session-1')

    expect(registry.get('session-1')).toEqual({ kind: 'none' })
    expect(registry.get('session-2')).toEqual({ kind: 'bound', specialistId: 'spec-b' })
  })
})
