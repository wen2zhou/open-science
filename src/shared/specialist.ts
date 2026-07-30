// Shared types and validation for Personal Specialist Profiles.
// All mutation rules live here so Settings, SDK, and runtime share one contract.

// IPC channel names shared between main, preload, and renderer.
export const SPECIALIST_IPC = {
  LIST: 'specialist:list',
  CREATE: 'specialist:create',
  UPDATE: 'specialist:update',
  SET_ENABLED: 'specialist:set-enabled',
  CATALOG_CHANGED: 'specialist:catalog-changed'
} as const

// The capability scope mode for a specialist.
export type SpecialistCapabilityMode = 'full' | 'selected'

// Per-connector tool-level rules. Uses bare method names (no connector prefix).
export type ConnectorToolRule = {
  connectorId: string
  includedMethods?: string[]
  excludedMethods?: string[]
  includeToolsPattern?: string
  excludeToolsPattern?: string
}

// Full access mode config: default-include-all, explicit exclusions only.
export type SpecialistFullAccessConfig = {
  excludedSkillIds: string[]
  excludedConnectorIds: string[]
  connectorTools: ConnectorToolRule[]
}

// Selected capabilities mode config: default-exclude-all, explicit inclusions only.
export type SpecialistSelectedConfig = {
  skillIds: string[]
  connectorIds: string[]
  connectorTools: ConnectorToolRule[]
}

// Renderer-safe view of one specialist profile (no secret fields).
export type SpecialistProfileView = {
  id: string
  name: string // human-readable, unique
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  enabled: boolean
  capabilityMode: SpecialistCapabilityMode
  fullAccess: SpecialistFullAccessConfig
  selectedCapabilities: SpecialistSelectedConfig
  revision: number
}

// The built-in Reviewer entry shown in the list (read-only, never a real profile).
export type ReviewerEntry = {
  kind: 'reviewer'
  id: 'reviewer'
}

// Union for the list — either a real profile or the reviewer placeholder.
export type SpecialistListItem = ({ kind: 'custom' } & SpecialistProfileView) | ReviewerEntry

// Input for creating a new specialist.
export type CreateSpecialistInput = {
  name: string
  description?: string
  systemPrompt?: string
  iconKey?: string
  colorKey?: string
  capabilityMode?: SpecialistCapabilityMode
  fullAccess?: SpecialistFullAccessConfig
  selectedCapabilities?: SpecialistSelectedConfig
}

// Input for updating an existing specialist. Both capability configurations are
// deliberately independent of the active mode: switching modes must never throw
// away the other mode's connector (or skill) selection. `revision` enables
// optimistic concurrency (must match the stored record).
export type UpdateSpecialistInput = {
  id: string
  revision: number
  name?: string
  description?: string
  systemPrompt?: string
  iconKey?: string
  colorKey?: string
  capabilityMode?: SpecialistCapabilityMode
  fullAccess?: SpecialistFullAccessConfig
  selectedCapabilities?: SpecialistSelectedConfig
}

// Request / response types for IPC.
export type CreateSpecialistRequest = CreateSpecialistInput
export type UpdateSpecialistRequest = UpdateSpecialistInput

export type SetSpecialistEnabledRequest = {
  id: string
  enabled: boolean
}

// Validation error for a single field.
export type SpecialistFieldError = {
  field: 'name' | 'description' | 'systemPrompt'
  message: string
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

// Validate a candidate name (human-readable, unique).
// Returns an error message string, or undefined when the name is valid.
export const validateSpecialistName = (
  name: string,
  existingNames: string[],
  currentId?: string, // pass for edit: skip self-collision
  existingIds?: Map<string, string> // name -> id for duplicate detection
): string | undefined => {
  if (!name.trim()) return 'Name is required.'
  if (name.trim().length > 80) return 'Name must be 80 characters or fewer.'

  // Duplicate check: skip self when editing.
  const collision = existingIds?.get(name)
  if (collision !== undefined && collision !== currentId) {
    return 'Name is already in use.'
  }
  // Fallback when existingIds not provided.
  if (!existingIds && existingNames.includes(name)) {
    return 'Name is already in use.'
  }

  return undefined
}

// Validate all fields for a CreateSpecialistInput.
// Returns an array of field errors (empty = valid).
export const validateCreateSpecialistInput = (
  input: CreateSpecialistInput,
  existingNames: string[],
  existingIds?: Map<string, string>
): SpecialistFieldError[] => {
  const errors: SpecialistFieldError[] = []

  const nameError = validateSpecialistName(input.name, existingNames, undefined, existingIds)
  if (nameError) errors.push({ field: 'name', message: nameError })

  return errors
}

// Validate the provided (partial) fields for an UpdateSpecialistInput.
// Only fields that are present are validated. Name uniqueness skips the
// specialist's own id (`input.id`) so self-rename is allowed.
export const validateUpdateSpecialistInput = (
  input: UpdateSpecialistInput,
  existingNames: string[],
  existingIds?: Map<string, string>
): SpecialistFieldError[] => {
  const errors: SpecialistFieldError[] = []

  if (input.name !== undefined) {
    const nameError = validateSpecialistName(input.name, existingNames, input.id, existingIds)
    if (nameError) errors.push({ field: 'name', message: nameError })
  }

  return errors
}

// ---------------------------------------------------------------------------
// Empty config helpers
// ---------------------------------------------------------------------------

export const emptyFullAccessConfig = (): SpecialistFullAccessConfig => ({
  excludedSkillIds: [],
  excludedConnectorIds: [],
  connectorTools: []
})

export const emptySelectedConfig = (): SpecialistSelectedConfig => ({
  skillIds: [],
  connectorIds: [],
  connectorTools: []
})
