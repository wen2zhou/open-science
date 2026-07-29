import type { StoredSpecialist } from '../settings/types'

// Per-session runtime Specialist identity. The registry stores only the *bound id*; main re-resolves
// it against the latest settings state before every execution so a stale hydration-time result can
// never expand capability. `unavailable` is assigned by the resolver (see resolve-session-specialist),
// not tracked here, so the registry never caches a "still unavailable" verdict that a settings change
// would invalidate.
export type SessionSpecialistBinding = { kind: 'none' } | { kind: 'bound'; specialistId: string }

// Tracks the persisted Specialist id bound to each running session. The main process owns this map
// and keeps it in sync with persisted sessions across creation, hydration, selection change, and
// deletion. Callers must resolve a bound id against current settings before relying on it.
export class SessionSpecialistRegistry {
  private readonly bindings = new Map<string, string>()

  get(sessionId: string): SessionSpecialistBinding {
    const specialistId = this.bindings.get(sessionId)
    return specialistId === undefined ? { kind: 'none' } : { kind: 'bound', specialistId }
  }

  set(sessionId: string, specialistId: string | undefined): void {
    if (specialistId === undefined) {
      this.bindings.delete(sessionId)
      return
    }
    this.bindings.set(sessionId, specialistId)
  }

  clear(sessionId: string): void {
    this.bindings.delete(sessionId)
  }
}

// Convenience for call sites that want the stored id (without the kind wrapper). Returns undefined
// when the session is unbound, mirroring the optional persisted field.
export const boundSpecialistId = (binding: SessionSpecialistBinding): string | undefined =>
  binding.kind === 'bound' ? binding.specialistId : undefined

// Re-exported so the registry module is the single import for the binding type family.
export type { StoredSpecialist }
