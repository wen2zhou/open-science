// Shared types and validation for Personal Specialist Profiles.
// All mutation rules live here so Settings, SDK, and runtime share one contract.

// IPC channel names shared between main, preload, and renderer.
export const SPECIALIST_IPC = {
  LIST: 'specialist:list',
  CREATE: 'specialist:create',
  UPDATE: 'specialist:update',
  SET_ENABLED: 'specialist:set-enabled',
  DELETE: 'specialist:delete',
  DUPLICATE: 'specialist:duplicate',
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

// A Skill catalog entry deliberately uses the durable app id for policy and the framework-facing
// name only at the transport boundary. Main Agent enablement is not represented here: Specialists
// own their capability policy independently of the Main Agent's disabled-skill preference.
export type SpecialistSkillCatalogEntry = {
  id: string
  frameworkName: string
  displayName?: string
}

export type EffectiveSpecialistSkills =
  | { kind: 'main' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'specialist'
      skillIds: string[]
      frameworkNames: string[]
      missingSkillIds: string[]
    }

// Resolve against the live catalog; callers must not snapshot catalog contents into a profile or
// session. Full access includes future entries by construction, while selected is an explicit list.
export const resolveEffectiveSpecialistSkills = (
  specialist:
    | Pick<SpecialistProfileView, 'capabilityMode' | 'fullAccess' | 'selectedCapabilities'>
    | undefined,
  catalog: SpecialistSkillCatalogEntry[]
): EffectiveSpecialistSkills => {
  if (specialist === undefined) return { kind: 'main' }
  const byId = new Map(catalog.map((skill) => [skill.id, skill]))
  const requestedIds =
    specialist.capabilityMode === 'full'
      ? catalog
          .filter((skill) => !specialist.fullAccess.excludedSkillIds.includes(skill.id))
          .map((skill) => skill.id)
      : specialist.selectedCapabilities.skillIds

  const skillIds: string[] = []
  const frameworkNames: string[] = []
  const missingSkillIds: string[] = []
  for (const id of requestedIds) {
    const skill = byId.get(id)
    if (!skill) {
      // Exclusions are valid durable references too, but a missing exclusion has no local effect.
      if (specialist.capabilityMode === 'selected') missingSkillIds.push(id)
      continue
    }
    if (skillIds.includes(id)) continue
    skillIds.push(id)
    frameworkNames.push(skill.frameworkName)
  }
  return { kind: 'specialist', skillIds, frameworkNames, missingSkillIds }
}

// Renderer-safe view of one specialist profile (no secret fields).
export type SpecialistProfileView = {
  id: string
  name: string // immutable-reference-safe public UPPER_SNAKE identifier
  displayName?: string
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
  displayName?: string
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
  displayName?: string
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

export type DeleteSpecialistRequest = { id: string; expectedRevision?: number }
export type DuplicateSpecialistRequest = { id: string }

// Validation error for a single field.
export type SpecialistFieldError = {
  field: 'name' | 'description' | 'systemPrompt'
  message: string
}

// ---------------------------------------------------------------------------
// Field length limits
// ---------------------------------------------------------------------------

// Hard caps shared by validation, the UI counters, and the maxLength attrs so
// the three never drift apart.
export const SPECIALIST_NAME_MAX_LENGTH = 80
export const SPECIALIST_DISPLAY_NAME_MAX_LENGTH = 80
export const SPECIALIST_DESCRIPTION_MAX_LENGTH = 200

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

// Legacy editor validation remains permissive; lifecycle/SDK mutations use the
// strict public-name validator below.
// Returns an error message string, or undefined when the name is valid.
export const validateSpecialistName = (
  name: string,
  existingNames: string[],
  currentId?: string, // pass for edit: skip self-collision
  existingIds?: Map<string, string> // name -> id for duplicate detection
): string | undefined => {
  if (!name.trim()) return 'Name is required.'
  if (name.trim().length > SPECIALIST_NAME_MAX_LENGTH) {
    return `Name must be ${SPECIALIST_NAME_MAX_LENGTH} characters or fewer.`
  }

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

export const validateSpecialistPublicName = (name: string): string | undefined =>
  /^[A-Z0-9_]{2,32}$/.test(name)
    ? undefined
    : 'Name must be 2-32 uppercase letters, numbers, or underscores.'

export const validateSpecialistDisplayName = (displayName: string): string | undefined => {
  if (!displayName.trim()) return 'Display name is required.'
  if (displayName.length > SPECIALIST_DISPLAY_NAME_MAX_LENGTH) {
    return `Display name must be ${SPECIALIST_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Description validation
// ---------------------------------------------------------------------------

// Validate a candidate description. Empty is allowed (the field is optional).
// Returns an error message string, or undefined when the description is valid.
export const validateSpecialistDescription = (description: string): string | undefined => {
  if (description.length > SPECIALIST_DESCRIPTION_MAX_LENGTH) {
    return `Description must be ${SPECIALIST_DESCRIPTION_MAX_LENGTH} characters or fewer.`
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

  if (input.displayName !== undefined) {
    const displayNameError = validateSpecialistDisplayName(input.displayName)
    if (displayNameError) errors.push({ field: 'name', message: displayNameError })
  }

  if (input.description !== undefined) {
    const descriptionError = validateSpecialistDescription(input.description)
    if (descriptionError) errors.push({ field: 'description', message: descriptionError })
  }

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

  if (input.displayName !== undefined) {
    const displayNameError = validateSpecialistDisplayName(input.displayName)
    if (displayNameError) errors.push({ field: 'name', message: displayNameError })
  }

  if (input.description !== undefined) {
    const descriptionError = validateSpecialistDescription(input.description)
    if (descriptionError) errors.push({ field: 'description', message: descriptionError })
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
