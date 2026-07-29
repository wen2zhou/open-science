import type { StoredSpecialist } from '../settings/types'

// The complete fail-closed binding a session resolves to against CURRENT settings state. The runtime
// computes this before every execution rather than caching the hydration-time result, so a freshly
// disabled/deleted Specialist takes effect immediately. `unavailable` is fail-closed: no instructions,
// empty capability allowlists, and Send disabled.
export type SessionSpecialistResolution =
  | { kind: 'none' }
  | { kind: 'bound'; specialistId: string }
  | { kind: 'unavailable'; specialistId: string }

// Ids that are selectable session built-ins. Reviewer is intentionally excluded: it backs the
// Auto-review workflow and must never become an ordinary session identity. A persisted `reviewer`
// binding therefore resolves unavailable rather than granting the isolated-evidence role.
const UNSELECTABLE_BUILTIN_IDS = new Set(['reviewer'])

// Implements the fail-closed state machine described in the PRD:
//   missing id        -> none
//   enabled resolvable -> bound
//   present but disabled / deleted / reviewer / malformed -> unavailable
// `customSpecialists` are the user's StoredSpecialist[]; `builtinSpecialists` are the runtime-projected
// built-ins (customize/reviewer). Read against the freshest settings snapshot at every call.
export const resolveSessionSpecialistBinding = (
  specialistId: string | undefined,
  customSpecialists: StoredSpecialist[],
  builtinSpecialists: StoredSpecialist[]
): SessionSpecialistResolution => {
  if (!specialistId) return { kind: 'none' }

  const match =
    customSpecialists.find((item) => item.id === specialistId) ??
    builtinSpecialists.find((item) => item.id === specialistId)

  if (!match) return { kind: 'unavailable', specialistId }

  // Reviewer is never a valid session binding even when "enabled": it backs Auto-review only.
  if (UNSELECTABLE_BUILTIN_IDS.has(match.id)) {
    return { kind: 'unavailable', specialistId }
  }

  return match.enabled ? { kind: 'bound', specialistId } : { kind: 'unavailable', specialistId }
}
