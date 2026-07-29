// The single source of truth for the effective Specialist capability projection lives in
// `src/shared/specialists/effective-capabilities.ts` so the runtime gate (main) and the composer
// projection (renderer) import the SAME function — the displayed capability set can never drift from
// the runtime gate. This file re-exports the shared module under the original main path so existing
// main callers (and the concurrent runtime-wiring work) keep importing from here unchanged.
import type { StoredSpecialist } from '../settings/types'

export {
  resolveEffectiveCapabilities,
  validateForcedSkill,
  frameworkEnforcementStrength
} from '../../shared/specialists/effective-capabilities'
export type {
  EffectiveCapabilities,
  EffectiveCapabilityBinding,
  ForcedSkillValidationResult,
  FrameworkEnforcementStrength,
  GlobalConnectorEntry,
  GlobalSkillEntry
} from '../../shared/specialists/effective-capabilities'

import type { EffectiveCapabilityBinding as SharedBinding } from '../../shared/specialists/effective-capabilities'

// Compile-time proof that StoredSpecialist satisfies the resolver's capability-bearing contract.
// This keeps the main path concretely typed for StoredSpecialist while delegating to one algorithm.
export type MainSpecialistBinding = SharedBinding<StoredSpecialist>
