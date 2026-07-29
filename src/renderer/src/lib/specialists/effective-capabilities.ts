// Renderer-side projection of a session's effective Specialist capabilities.
//
// This adapts renderer-only types (SpecialistView / SkillView / SessionSpecialistResolution)
// into the inputs of the SINGLE shared resolver (`src/shared/specialists/effective-capabilities`)
// used by the main runtime gate. There is no second capability calculation here: the picker
// filter, the send-time forced-skill rejection, and the framework label all delegate to that one
// resolver so the displayed set always matches what the runtime enforces.

import type { SkillView, SpecialistView } from '../../../../shared/settings'
import {
  resolveEffectiveCapabilities,
  validateForcedSkill,
  frameworkEnforcementStrength,
  type EffectiveCapabilities,
  type EffectiveCapabilityBinding,
  type GlobalConnectorEntry,
  type GlobalSkillEntry
} from '../../../../shared/specialists/effective-capabilities'
import type { AgentFrameworkId } from '../../../../shared/settings'
import type { SessionSpecialistResolution } from './resolve-session-specialist'

// The skill catalog maps 1:1 onto the resolver's GlobalSkillEntry: id + enabled come from SkillView,
// and the framework name is the skill's display name (Claude Code skill tool accepts the SKILL name).
const toGlobalSkillEntry = (skill: SkillView): GlobalSkillEntry => ({
  id: skill.id,
  frameworkName: skill.name,
  enabled: skill.enabled
})

// The connector catalog is renderer-projected separately (specialist-only connector views are not in
// this issue's scope), so callers pass the live enabled-connector ids and we synthesize entries.
const toGlobalConnectorEntries = (connectorIds: string[]): GlobalConnectorEntry[] =>
  connectorIds.map((id) => ({ id, enabled: true }))

// Adapts the renderer's fail-closed binding resolution into the resolver's binding input.
// `none` and `unavailable` map directly; `bound` carries the SpecialistView (which satisfies the
// resolver's capability-bearing contract).
const toBinding = (
  resolution: SessionSpecialistResolution,
  globalConnectors: GlobalConnectorEntry[]
): EffectiveCapabilityBinding<SpecialistView> => {
  if (resolution.kind === 'none') return { kind: 'none' }
  if (resolution.kind === 'unavailable') {
    return { kind: 'unavailable', specialistId: resolution.specialistId }
  }
  return { kind: 'bound', specialistId: resolution.specialist.id, specialist: resolution.specialist }
}

export type ResolveRendererCapabilitiesInput = {
  resolution: SessionSpecialistResolution
  skills: SkillView[]
  // Currently enabled connector ids for the global catalog; used so bound specialists that reference
  // disabled connectors surface as unavailable (matches the runtime intersection). Defaults to none.
  enabledConnectorIds?: string[]
}

// Resolves the effective capabilities for a session by delegating to the shared resolver.
// The renderer never re-implements the intersection — it only translates its catalog types.
export const resolveRendererCapabilities = (
  input: ResolveRendererCapabilitiesInput
): EffectiveCapabilities => {
  const globalSkills = input.skills.map(toGlobalSkillEntry)
  const globalConnectors = toGlobalConnectorEntries(input.enabledConnectorIds ?? [])
  const binding = toBinding(input.resolution, globalConnectors)
  return resolveEffectiveCapabilities(binding, globalSkills, globalConnectors)
}

// Returns the picker skill set for the current binding. `none` is unfiltered (today's behaviour);
// `unavailable` offers nothing; `bound` offers only the globally-enabled skills the specialist allows,
// in the resolver's effective order so the picker matches the runtime gate exactly.
export const resolvePickerSkills = (
  input: ResolveRendererCapabilitiesInput
): { filtered: boolean; skills: SkillView[] } => {
  const capabilities = resolveRendererCapabilities(input)

  if (capabilities.kind === 'none') {
    return { filtered: false, skills: input.skills }
  }
  if (capabilities.kind === 'unavailable') {
    return { filtered: true, skills: [] }
  }

  // bound: keep only the effective skills, ordered by the resolver's effective skillIds so the
  // picker order matches the runtime gate exactly (not the catalog order).
  const byId = new Map(input.skills.map((s) => [s.id, s]))
  const skills = capabilities.skillIds
    .map((id) => byId.get(id))
    .filter((s): s is SkillView => s !== undefined)
  return { filtered: true, skills }
}

// Validates a forced-skill chip against the current effective capabilities at SEND time.
// A chip can go stale when the specialist is edited in Settings while the chip stays in the
// composer, so this is checked on send (not only on pick). Returns the stable rejection reason.
export const validateForcedSkillChip = (
  skillId: string,
  input: ResolveRendererCapabilitiesInput
): { allowed: true } | { allowed: false; reason: string } => {
  const capabilities = resolveRendererCapabilities(input)
  return validateForcedSkill(skillId, capabilities)
}

// Validates every forced-skill chip at send time and returns the first rejection (if any).
export const validateForcedSkillChips = (
  skillIds: string[],
  input: ResolveRendererCapabilitiesInput
): { allowed: true } | { allowed: false; reason: string; skillId: string } => {
  for (const skillId of skillIds) {
    const result = validateForcedSkillChip(skillId, input)
    if (!result.allowed) {
      return { ...result, skillId }
    }
  }
  return { allowed: true }
}

// Surfaces the framework enforcement-strength label for the specialist badge. Claude Code is
// `Hard enforced`; Codex and OpenCode are `Guidance only` and must never be presented as a
// security boundary. Only meaningful when a specialist is bound.
export const resolveFrameworkStrengthLabel = (
  frameworkId: AgentFrameworkId,
  input: ResolveRendererCapabilitiesInput
): { label: string; isNative: boolean } | null => {
  const capabilities = resolveRendererCapabilities(input)
  if (capabilities.kind !== 'bound') return null

  const strength = frameworkEnforcementStrength(frameworkId, capabilities.skillNames)
  return { label: strength.label, isNative: strength.isNative }
}
