import type { SpecialistView } from '../../../../shared/settings'

// Renderer-side projection of the fail-closed Specialist binding for one session, derived from the
// persisted `specialistId` and the live SpecialistView catalog (fetched via settings.listSpecialists).
// Mirrors the main-process `resolveSessionSpecialistBinding` so the renderer's Send-disable decision
// and badge match what the runtime will actually append/restrict on the next turn.
export type SessionSpecialistResolution =
  | { kind: 'none' }
  | { kind: 'bound'; specialist: SpecialistView }
  | { kind: 'unavailable'; specialistId: string }

// Reviewer backs the Auto-review workflow and must never become an ordinary session identity even if
// it appears in the catalog.
const UNSELECTABLE_BUILTIN_IDS = new Set(['reviewer'])

export const resolveSessionSpecialistView = (
  specialistId: string | undefined,
  specialists: SpecialistView[]
): SessionSpecialistResolution => {
  if (!specialistId) return { kind: 'none' }

  const match = specialists.find((item) => item.id === specialistId)
  if (!match) return { kind: 'unavailable', specialistId }
  if (UNSELECTABLE_BUILTIN_IDS.has(match.id)) {
    return { kind: 'unavailable', specialistId }
  }

  return match.enabled ? { kind: 'bound', specialist: match } : { kind: 'unavailable', specialistId }
}
