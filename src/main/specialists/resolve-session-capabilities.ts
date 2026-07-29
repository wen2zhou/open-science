// Runtime-side adapter that feeds a session's fail-closed Specialist binding plus the CURRENT
// global skill/connector catalogs into the SINGLE shared resolver
// (`src/shared/specialists/effective-capabilities`). Both the ACP runtime skill-whitelist build and
// the ConnectorService specialist gate resolve through here, so the whitelist a Claude Code session
// receives is exactly the set of connector ids the gate allows — no second calculation.
//
// This module is framework-agnostic and main-only (it depends on StoredSpecialist / catalog types,
// not on the renderer). It deliberately never caches: every call reads the latest catalogs and
// re-resolves, so a Specialist or connector mutation takes effect on the next execution rather than
// from a stale hydration-time verdict.

import type { StoredSpecialist } from '../settings/types'
import {
  resolveEffectiveCapabilities,
  type EffectiveCapabilities,
  type EffectiveCapabilityBinding,
  type GlobalConnectorEntry,
  type GlobalSkillEntry
} from '../../shared/specialists/effective-capabilities'
import { resolveSessionSpecialistBinding } from './resolve-session-specialist'

// The global catalogs this adapter needs. Built fresh on every call from the latest settings so the
// intersection reflects current enablement, never a connect-time snapshot.
export type GlobalCapabilityCatalogs = {
  skills: GlobalSkillEntry[]
  connectors: GlobalConnectorEntry[]
}

// Builds the resolver binding from the registry id + latest Specialist catalog. `none` and
// `unavailable` map directly; `bound` carries the StoredSpecialist (which satisfies the resolver's
// capability-bearing contract). Re-uses the same fail-closed resolver the prompt-append path uses so
// a binding can never disagree about availability between the two code paths.
export const toEffectiveCapabilityBinding = (
  specialistId: string | undefined,
  customSpecialists: StoredSpecialist[],
  builtinSpecialists: StoredSpecialist[]
): EffectiveCapabilityBinding<StoredSpecialist> => {
  const resolution = resolveSessionSpecialistBinding(
    specialistId,
    customSpecialists,
    builtinSpecialists
  )
  if (resolution.kind === 'none') return { kind: 'none' }
  if (resolution.kind === 'unavailable') {
    return { kind: 'unavailable', specialistId: resolution.specialistId }
  }
  const match =
    customSpecialists.find((item) => item.id === resolution.specialistId) ??
    builtinSpecialists.find((item) => item.id === resolution.specialistId)
  // resolveSessionSpecialistBinding only returns `bound` when the Specialist is present and enabled,
  // so `match` is guaranteed. Defend anyway so a hostile catalog never throws here.
  if (!match) return { kind: 'unavailable', specialistId: resolution.specialistId }
  return { kind: 'bound', specialistId: resolution.specialistId, specialist: match }
}

// Resolves the effective capabilities for a session by delegating to the shared resolver. Reads no
// settings directly — callers pass the freshest catalogs and bound id — so this stays pure and is the
// single point both the runtime whitelist builder and the connector gate call.
export const resolveSessionCapabilities = (
  specialistId: string | undefined,
  specialists: { custom: StoredSpecialist[]; builtins: StoredSpecialist[] },
  catalogs: GlobalCapabilityCatalogs
): EffectiveCapabilities => {
  const binding = toEffectiveCapabilityBinding(
    specialistId,
    specialists.custom,
    specialists.builtins
  )
  return resolveEffectiveCapabilities(binding, catalogs.skills, catalogs.connectors)
}
