import { describe, it, expect, vi } from 'vitest'
import { SessionBindingService } from './session-binding'
import type { ProfileService } from './service'
import type { SpecialistProfileView } from '../../shared/specialist'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeProfile = (overrides: Partial<SpecialistProfileView> = {}): SpecialistProfileView => ({
  id: 'uuid-sp1',
  name: 'DEBUGGER',
  displayName: 'Debugger',
  description: 'A debugging specialist.',
  systemPrompt: 'You are a debugger.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: emptySelectedConfig(),
  revision: 1,
  ...overrides
})

const makeService = (profiles: Map<string, SpecialistProfileView> = new Map()): ProfileService => {
  return {
    getById: vi.fn(async (id: string) => {
      const p = profiles.get(id)
      if (!p) throw new Error(`Specialist ${id} not found.`)
      return p
    })
  } as unknown as ProfileService
}

// ---------------------------------------------------------------------------
// Tests: setBinding / getBinding
// ---------------------------------------------------------------------------

describe('SessionBindingService.setBinding', () => {
  it('stores a specialist UUID for a session', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    expect(svc.getBinding('session-a')).toBe('uuid-sp1')
  })

  it('clears a binding when undefined is passed', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', undefined)
    expect(svc.getBinding('session-a')).toBeUndefined()
  })

  it('does not affect other sessions', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')
    expect(svc.getBinding('session-a')).toBe('uuid-sp1')
    expect(svc.getBinding('session-b')).toBe('uuid-sp2')
  })

  it('last-write-wins when switching multiple times', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', 'uuid-sp2')
    svc.setBinding('session-a', 'uuid-sp3')
    expect(svc.getBinding('session-a')).toBe('uuid-sp3')
  })
})

// ---------------------------------------------------------------------------
// Tests: resolve — main / bound / unavailable
// ---------------------------------------------------------------------------

describe('SessionBindingService.resolve', () => {
  it("returns 'main' when no binding is recorded", async () => {
    const svc = new SessionBindingService(makeService())
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })

  it("returns 'main' after binding is cleared", async () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', undefined)
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })

  it("returns 'bound' with the profile when UUID is found and enabled", async () => {
    const profile = makeProfile()
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.id).toBe('uuid-sp1')
      expect(result.profile.name).toBe('DEBUGGER')
    }
  })

  it("returns 'unavailable' when UUID is not found in catalog", async () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-deleted')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('uuid-deleted')
    }
  })

  it("returns 'unavailable' when profile is disabled", async () => {
    const profile = makeProfile({ enabled: false })
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('disabled')
    }
  })

  it('resolves an override UUID instead of the stored binding', async () => {
    const profile2 = makeProfile({ id: 'uuid-sp2', name: 'RESEARCHER' })
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp2', profile2]])))
    svc.setBinding('session-a', 'uuid-sp1') // stored binding
    const result = await svc.resolve('session-a', 'uuid-sp2') // override
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.id).toBe('uuid-sp2')
    }
  })

  it('isolates sessions — resolve for one does not affect another', async () => {
    const profile1 = makeProfile({ id: 'uuid-sp1', name: 'DEBUGGER' })
    const profile2 = makeProfile({ id: 'uuid-sp2', name: 'RESEARCHER' })
    const svc = new SessionBindingService(
      makeService(
        new Map([
          ['uuid-sp1', profile1],
          ['uuid-sp2', profile2]
        ])
      )
    )
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')

    const [ra, rb] = await Promise.all([svc.resolve('session-a'), svc.resolve('session-b')])
    expect(ra.kind).toBe('bound')
    expect(rb.kind).toBe('bound')
    if (ra.kind === 'bound') expect(ra.profile.id).toBe('uuid-sp1')
    if (rb.kind === 'bound') expect(rb.profile.id).toBe('uuid-sp2')
  })
})

// ---------------------------------------------------------------------------
// Tests: clearSession
// ---------------------------------------------------------------------------

describe('SessionBindingService.clearSession', () => {
  it('removes the binding for the session', async () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.clearSession('session-a')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })

  it('does not affect other sessions when clearing', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')
    svc.clearSession('session-a')
    expect(svc.getBinding('session-a')).toBeUndefined()
    expect(svc.getBinding('session-b')).toBe('uuid-sp2')
  })
})

// ---------------------------------------------------------------------------
// Tests: None clears binding (clears and returns main)
// ---------------------------------------------------------------------------

describe('SessionBindingService — None clears binding', () => {
  it('binding cleared to undefined resolves to main (no separate Main profile)', async () => {
    const profile = makeProfile()
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', undefined) // None
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })
})

// ---------------------------------------------------------------------------
// Tests: Lazy reconfigure — profile update reads latest revision
// ---------------------------------------------------------------------------

describe('SessionBindingService — lazy profile update', () => {
  it('reads the latest profile on each resolve (not a cached snapshot)', async () => {
    const profile = makeProfile({ revision: 1, systemPrompt: 'v1' })
    const catalog = new Map<string, SpecialistProfileView>([['uuid-sp1', profile]])
    const svc = new SessionBindingService(makeService(catalog))
    svc.setBinding('session-a', 'uuid-sp1')

    // First resolve returns revision 1.
    let result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') expect(result.profile.revision).toBe(1)

    // Simulate profile update (e.g. user edited identity).
    catalog.set('uuid-sp1', { ...profile, revision: 2, systemPrompt: 'v2' })

    // Second resolve returns the new revision — not a stale snapshot.
    result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.revision).toBe(2)
      expect(result.profile.systemPrompt).toBe('v2')
    }
  })

  it('catalog-change event does not auto-resume sessions (lazy, not eager)', () => {
    // The binding service has no resumeSessions method — it only resolves on demand.
    const svc = new SessionBindingService(makeService())
    expect((svc as unknown as Record<string, unknown>).resumeSessions).toBeUndefined()
    expect((svc as unknown as Record<string, unknown>).bulkResume).toBeUndefined()
  })
})
