import type { SpecialistDraft } from './settings'

export const SPECIALIST_AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SPECIALIST_COLOR_KEYS = [
  'blue',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'slate'
] as const
export const SPECIALIST_ICON_KEYS = [
  'beaker',
  'book-open',
  'brain',
  'flask-conical',
  'microscope',
  'search'
] as const

export type SpecialistValidationCatalog = {
  agentIds: Iterable<string>
  skillIds: Iterable<string>
  connectorIds: Iterable<string>
  // Unavailable ids already persisted on an item remain removable/editable but cannot be newly added.
  retainedSkillIds?: Iterable<string>
  retainedConnectorIds?: Iterable<string>
}

export type ValidatedSpecialistDraft = Required<Pick<SpecialistDraft, 'agentId' | 'name'>> &
  Omit<SpecialistDraft, 'agentId' | 'name'> & { skillIds: string[]; connectorIds: string[] }

const unique = (ids: readonly string[] | undefined): string[] => [
  ...new Set((ids ?? []).filter((id): id is string => typeof id === 'string'))
]

// Shared, deterministic validation used before renderer submission and at the trusted IPC/service
// boundary. It deliberately reports the first actionable field error, preserving the caller's draft.
export const validateSpecialistDraft = (
  value: SpecialistDraft,
  catalog: SpecialistValidationCatalog
): ValidatedSpecialistDraft => {
  const agentId = value.agentId?.trim()
  const name = value.name?.trim()
  if (
    !agentId ||
    agentId.length < 2 ||
    agentId.length > 64 ||
    !SPECIALIST_AGENT_ID_PATTERN.test(agentId)
  ) {
    throw new Error('Agent ID must be 2–64 lowercase letters, numbers, and hyphens.')
  }
  if (new Set(catalog.agentIds).has(agentId)) throw new Error('Agent ID is already in use.')
  if (!name || name.length > 80) throw new Error('Name must be between 1 and 80 characters.')
  if (value.description && value.description.length > 500)
    throw new Error('Description must be at most 500 characters.')
  if (value.instructions && value.instructions.length > 20_000)
    throw new Error('Instructions must be at most 20,000 characters.')
  if (value.colorKey && !SPECIALIST_COLOR_KEYS.includes(value.colorKey as never))
    throw new Error('Unknown color.')
  if (value.iconKey && !SPECIALIST_ICON_KEYS.includes(value.iconKey as never))
    throw new Error('Unknown icon.')

  const skillIds = unique(value.skillIds)
  const connectorIds = unique(value.connectorIds)
  const allowedSkills = new Set([...catalog.skillIds, ...(catalog.retainedSkillIds ?? [])])
  const allowedConnectors = new Set([
    ...catalog.connectorIds,
    ...(catalog.retainedConnectorIds ?? [])
  ])
  const unknownSkill = skillIds.find((id) => !allowedSkills.has(id))
  const unknownConnector = connectorIds.find((id) => !allowedConnectors.has(id))
  if (unknownSkill) throw new Error(`Unknown skill: ${unknownSkill}`)
  if (unknownConnector) throw new Error(`Unknown connector: ${unknownConnector}`)

  return { ...value, agentId, name, skillIds, connectorIds }
}
