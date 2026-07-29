// Single source of truth for the effective Specialist capability projection.
//
// This module lives in `src/shared` so BOTH the main process (runtime gate in
// src/main/acp) and the renderer (composer picker + send-time forced-skill
// validation) import the SAME function. That guarantees the visible capability
// set can never drift from the runtime gate — there is no second calculation.
//
// It is deliberately framework-agnostic and free of any main-only or
// renderer-only imports. The specialist binding is generic over a minimal
// capability-bearing shape (`skillIds` / `connectorIds`) so it works equally
// with the main `StoredSpecialist` and the renderer `SpecialistView`.

import type { AgentFrameworkId } from '../settings'

// The minimal specialist shape this resolver reads. Both StoredSpecialist (main)
// and SpecialistView (renderer) satisfy it.
export type CapabilityBearingSpecialist = {
  skillIds: string[]
  connectorIds: string[]
}

// ---- Input catalog types ----

// One globally registered skill with its framework-level name and enabled state.
export type GlobalSkillEntry = {
  id: string
  // The name the Claude Code skill tool accepts (e.g. 'RNA-seq'). Used to build the skills whitelist.
  frameworkName: string
  enabled: boolean
}

// One globally registered connector with its enabled state.
// id is the stable bundled catalog id or the custom MCP server's immutable UUID.
export type GlobalConnectorEntry = {
  id: string
  enabled: boolean
}

// ---- Binding input (resolved from registry + settings) ----

export type EffectiveCapabilityBinding<TSpecialist extends CapabilityBearingSpecialist =
  CapabilityBearingSpecialist> =
  | { kind: 'none' }
  | { kind: 'unavailable'; specialistId: string }
  | { kind: 'bound'; specialistId: string; specialist: TSpecialist }

// ---- Result types ----

// None: no specialist restricts skills or connectors. Passes through all global policy unchanged.
type NoneCapabilities = {
  kind: 'none'
  // undefined = omit the skills field entirely from ACP setup (no whitelist at all)
  skillWhitelist: undefined
  // undefined = no connector restriction from specialist layer
  connectorAllowlist: undefined
}

// Unavailable: fail-closed — no skills, no connectors, block everything.
type UnavailableCapabilities = {
  kind: 'unavailable'
  specialistId: string
  skillIds: []
  skillNames: []
  connectorIds: []
  // skillWhitelist is [] to explicitly send empty list to framework
  skillWhitelist: []
}

// Bound: effective intersection of specialist allowlist with global catalog.
type BoundCapabilities = {
  kind: 'bound'
  specialistId: string
  // Ordered effective skillIds (intersection: specialist ∩ globally-enabled)
  skillIds: string[]
  // Framework names for effective skills (same order as skillIds)
  skillNames: string[]
  // Ordered effective connectorIds (intersection: specialist ∩ globally-enabled)
  connectorIds: string[]
  // Framework skill names ready for the ACP setup. [] means bound zero-skill specialist.
  // Callers pass this directly as skills: skillWhitelist (truthy [] gets sent; undefined is omitted).
  skillWhitelist: string[]
  // Stored skills that cannot be resolved in any catalog (deleted/unknown)
  missingSkillIds: string[]
  // Stored skills present in catalog but globally disabled
  unavailableSkillIds: string[]
  // Stored connectors that cannot be resolved
  missingConnectorIds: string[]
  // Stored connectors present in catalog but globally disabled
  unavailableConnectorIds: string[]
}

export type EffectiveCapabilities =
  | NoneCapabilities
  | UnavailableCapabilities
  | BoundCapabilities

// ---- Resolver ----

// Computes the effective capability intersection for a session's specialist binding.
// Both UI projection and runtime enforcement use this single function so the visible state can never
// drift from the connector gate.
export const resolveEffectiveCapabilities = <TSpecialist extends CapabilityBearingSpecialist>(
  binding: EffectiveCapabilityBinding<TSpecialist>,
  globalSkills: GlobalSkillEntry[],
  globalConnectors: GlobalConnectorEntry[]
): EffectiveCapabilities => {
  if (binding.kind === 'none') {
    return { kind: 'none', skillWhitelist: undefined, connectorAllowlist: undefined }
  }

  if (binding.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      specialistId: binding.specialistId,
      skillIds: [],
      skillNames: [],
      connectorIds: [],
      skillWhitelist: []
    }
  }

  const { specialist } = binding
  const skillMap = new Map(globalSkills.map((s) => [s.id, s]))
  const connectorMap = new Map(globalConnectors.map((c) => [c.id, c]))

  // Effective skills: ordered intersection of specialist.skillIds with globally-enabled skills
  const effectiveSkillIds: string[] = []
  const effectiveSkillNames: string[] = []
  const missingSkillIds: string[] = []
  const unavailableSkillIds: string[] = []

  for (const id of specialist.skillIds) {
    const entry = skillMap.get(id)
    if (!entry) {
      missingSkillIds.push(id)
    } else if (!entry.enabled) {
      unavailableSkillIds.push(id)
    } else {
      effectiveSkillIds.push(id)
      effectiveSkillNames.push(entry.frameworkName)
    }
  }

  // Effective connectors: ordered intersection of specialist.connectorIds with globally-enabled
  const effectiveConnectorIds: string[] = []
  const missingConnectorIds: string[] = []
  const unavailableConnectorIds: string[] = []

  for (const id of specialist.connectorIds) {
    const entry = connectorMap.get(id)
    if (!entry) {
      missingConnectorIds.push(id)
    } else if (!entry.enabled) {
      unavailableConnectorIds.push(id)
    } else {
      effectiveConnectorIds.push(id)
    }
  }

  return {
    kind: 'bound',
    specialistId: binding.specialistId,
    skillIds: effectiveSkillIds,
    skillNames: effectiveSkillNames,
    connectorIds: effectiveConnectorIds,
    // [] is truthy in JS so an empty allowlist is sent explicitly as skills: [] to the framework.
    // This matches the PRD rule: bound zero-skill specialist must be sent explicitly as skills: [].
    skillWhitelist: effectiveSkillNames,
    missingSkillIds,
    unavailableSkillIds,
    missingConnectorIds,
    unavailableConnectorIds
  }
}

// ---- Forced-skill validation seam ----

// Result returned before every send for forced-skill chip validation.
export type ForcedSkillValidationResult =
  | { allowed: true }
  | { allowed: false; reason: string }

// Validates a forced skill chip against the current effective capabilities.
// Rejected when: binding is unavailable, or skill is not in the effective allowlist.
// Passes when: binding is none (no restriction), or skill is in effectiveSkillIds.
export const validateForcedSkill = (
  skillId: string,
  capabilities: EffectiveCapabilities
): ForcedSkillValidationResult => {
  if (capabilities.kind === 'none') return { allowed: true }

  if (capabilities.kind === 'unavailable') {
    return {
      allowed: false,
      reason: `Skill "${skillId}" cannot be used: the bound specialist is unavailable. Select a different specialist or None to continue.`
    }
  }

  if (!capabilities.skillIds.includes(skillId)) {
    return {
      allowed: false,
      reason: `Skill "${skillId}" is not allowed by the active specialist. Remove the skill chip or switch the specialist to continue.`
    }
  }

  return { allowed: true }
}

// ---- Framework enforcement strength metadata ----

export type FrameworkEnforcementStrength = {
  // 'Hard enforced' for claude-code; 'Guidance only' for codex/opencode.
  label: string
  // True only for claude-code which has native ACP skill whitelist support.
  isNative: boolean
  // Present only for non-native frameworks when allowedSkillNames is non-empty.
  // Must NOT claim native enforcement.
  guidanceText?: string
}

// Returns the enforcement strength descriptor for the active framework.
// Consumers (renderer) use label and isNative for UI badges.
// guidanceText is appended to Codex/OpenCode instructions — do not claim it is a security boundary.
export const frameworkEnforcementStrength = (
  frameworkId: AgentFrameworkId,
  allowedSkillNames?: string[]
): FrameworkEnforcementStrength => {
  if (frameworkId === 'claude-code') {
    return { label: 'Hard enforced', isNative: true }
  }

  // Codex and OpenCode do not have native session-level skill filtering.
  const guidanceText =
    allowedSkillNames && allowedSkillNames.length > 0
      ? buildGuidanceOnlySkillText(allowedSkillNames)
      : undefined

  return { label: 'Guidance only', isNative: false, guidanceText }
}

// Generates the allowed-skill guidance text appended to Codex/OpenCode instructions.
// This is a soft guidance — not a security boundary. The text must not claim hard enforcement.
const buildGuidanceOnlySkillText = (allowedSkillNames: string[]): string => {
  const list = allowedSkillNames.map((name) => `- ${name}`).join('\n')
  return [
    '<specialist_skill_guidance>',
    'For this session, please focus on the following skills only:',
    list,
    'This is a configuration preference; other skills may still be accessible in the environment.',
    '</specialist_skill_guidance>'
  ].join('\n')
}
