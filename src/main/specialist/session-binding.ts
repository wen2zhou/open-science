// Per-session specialist binding store.
//
// Responsibilities:
//   • Record a mutable UUID binding for each app session (in memory).
//   • Resolve that binding against the live ProfileService catalog to produce a
//     SessionSpecialistResolution (main | bound | unavailable).
//   • Act as the named seam for the reconfigure barrier: the future SDK
//     host.agents.switch() will resolve name→UUID and call setBinding() here,
//     not a second switching path (see issues/deferred/08).
//
// Session persistence (UUID only, never a snapshot) is handled by the caller
// writing specialistId to the persisted session file; this service holds the
// live in-memory view and the resolution logic.

import { createLogger } from '../logger'
import type { ProfileService } from './service'
import type { SessionSpecialistResolution, SpecialistProfileView } from '../../shared/specialist'

const log = createLogger('specialist.session-binding')

export class SessionBindingService {
  // sessionId → specialist UUID (undefined = no binding = main agent)
  private readonly bindings = new Map<string, string | undefined>()

  constructor(private readonly profileService: ProfileService) {}

  // Records (or clears) the specialist UUID for one session. Persisting the
  // UUID to the session file is the caller's responsibility (IPC handler writes
  // it via the notebook registry or session persistence layer).
  setBinding(sessionId: string, specialistId: string | undefined): void {
    if (specialistId === undefined) {
      this.bindings.delete(sessionId)
    } else {
      this.bindings.set(sessionId, specialistId)
    }
    log.info('session specialist binding updated', { sessionId, specialistId })
  }

  // Reads the current in-memory binding for a session. Returns undefined when
  // no binding has been recorded (main agent).
  getBinding(sessionId: string): string | undefined {
    return this.bindings.get(sessionId)
  }

  // Resolves the current binding against the live catalog.
  // - 'main'        — no UUID binding present.
  // - 'bound'       — UUID found, profile enabled.
  // - 'unavailable' — UUID unknown, disabled, or corrupt.
  //
  // If `overrideSpecialistId` is provided, that UUID is resolved instead of the
  // stored binding (used by the IPC handler to validate a proposed new binding).
  async resolve(
    sessionId: string,
    overrideSpecialistId?: string
  ): Promise<SessionSpecialistResolution> {
    const specialistId = overrideSpecialistId ?? this.bindings.get(sessionId)
    if (!specialistId) return { kind: 'main' }

    let profile: SpecialistProfileView | undefined
    try {
      profile = await this.profileService.getById(specialistId)
    } catch {
      // Not found.
      return { kind: 'unavailable', reason: `Specialist ${specialistId} not found.` }
    }

    if (!profile.enabled) {
      return { kind: 'unavailable', reason: `Specialist "${profile.name}" is disabled.` }
    }

    return { kind: 'bound', profile }
  }

  // Removes all bindings for a session (called when a session is deleted).
  clearSession(sessionId: string): void {
    this.bindings.delete(sessionId)
  }
}
