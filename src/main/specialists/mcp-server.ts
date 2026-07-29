// App-owned Specialist Management MCP server.
//
// Exposes list/get/create/update/duplicate/enable/disable/delete/switch plus read-only Skill and
// Connector catalog reads. It lives OUTSIDE the notebook host.mcp() bridge and never participates in
// notebook connector dispatch. Read-only operations execute immediately; every mutation and switch is
// a two-phase operation: the tool call returns a preview and a mutationId, and nothing is persisted
// until the caller confirms that mutationId (and each mutationId can be confirmed at most once).
//
// The server is deps-driven so the tool surface is unit-testable without the Electron IPC stack.

import { validateSpecialistDraft } from '../../shared/specialist-validation'
import type {
  SpecialistView,
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  DuplicateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DeleteSpecialistRequest
} from '../../shared/settings'

// Read-only catalog projections reused for validation parity with the Settings editor.
export type SpecialistSkillCatalogEntry = {
  id: string
  name: string
  description?: string
  enabled: boolean
}
export type SpecialistConnectorCatalogEntry = {
  id: string
  displayName: string
  description?: string
  enabled: boolean
}

// Service seam the main process wires up (settings store + session registry + IPC broadcast).
// Every operation routes through here so the tool never touches storage or the registry directly.
export type SpecialistManagementDeps = {
  listSpecialists: () => Promise<SpecialistView[]>
  getSpecialist: (id: string) => Promise<SpecialistView>
  createSpecialist: (input: CreateSpecialistRequest) => Promise<SpecialistView>
  updateSpecialist: (input: UpdateSpecialistRequest) => Promise<SpecialistView>
  duplicateSpecialist: (input: DuplicateSpecialistRequest) => Promise<SpecialistView>
  setSpecialistEnabled: (input: SetSpecialistEnabledRequest) => Promise<SpecialistView>
  deleteSpecialist: (input: DeleteSpecialistRequest) => Promise<void>
  setSessionSpecialist: (sessionId: string, specialistId: string | undefined) => void | Promise<void>
  broadcastSettingsRefresh: () => void
  listAvailableSkills: () => Promise<SpecialistSkillCatalogEntry[]>
  listAvailableConnectors: () => Promise<SpecialistConnectorCatalogEntry[]>
}

// Minimal MCP call-tool result shape. Kept local so the surface is testable without the MCP SDK.
export type SpecialistMcpContent = { type: 'text'; text: string }
export type SpecialistMcpCallResult = {
  isError?: boolean
  content: SpecialistMcpContent[]
  // Present (with a mutationId) when a mutation tool call requires confirmation before executing.
  // Undefined for read-only tools, which execute immediately.
  requiresConfirmation?: { mutationId: string }
}

export type SpecialistMutationPreview = {
  action: string
  identity: { id?: string; agentId: string; name: string }
  // Summary only — never the raw instruction text, so failures/previews cannot leak it.
  instructionsSummary: { changed: boolean; length: number }
  // The COMPLETE target Skill and Connector id sets after the mutation, not just the diff.
  skills: string[]
  connectors: string[]
  expectedRevision?: number
  // Whether existing bound sessions stay available after the change.
  affectedSessions?: { available: boolean }
  // Present for switch mutations.
  targetSessionId?: string
}

// A staged mutation awaiting explicit confirmation. Each holds enough to execute exactly once.
type PendingMutation =
  | { kind: 'create'; draft: ReturnType<typeof validateSpecialistDraft> }
  | { kind: 'update'; id: string; expectedRevision: number; draft: ReturnType<typeof validateSpecialistDraft> }
  | { kind: 'duplicate'; id: string; expectedRevision: number; source: SpecialistView }
  | { kind: 'setEnabled'; id: string; enabled: boolean; source: SpecialistView }
  | { kind: 'delete'; id: string; expectedRevision: number; source: SpecialistView }
  | { kind: 'switch'; sessionId: string; specialistId: string | undefined }

const ok = (text: string): SpecialistMcpCallResult => ({ content: [{ type: 'text', text }] })
const okJson = (value: unknown): SpecialistMcpCallResult => ok(JSON.stringify(value))
const fail = (text: string): SpecialistMcpCallResult => ({ isError: true, content: [{ type: 'text', text }] })

const builtinLabel = (kind: SpecialistView['kind']): string =>
  kind === 'builtin-reviewer' ? 'Reviewer' : kind === 'builtin-customize' ? 'Customize' : 'Built-in'

const isFullyProtected = (kind: SpecialistView['kind']): boolean =>
  kind === 'builtin-reviewer' || kind === 'builtin-customize'

export class SpecialistManagementMcpServer {
  private readonly deps: SpecialistManagementDeps
  private readonly pending = new Map<string, PendingMutation>()
  private mutationSequence = 0

  constructor(deps: SpecialistManagementDeps) {
    this.deps = deps
  }

  // Entry point used by the MCP transport and by tests. Dispatches a tool call to its handler.
  async callToolForTest(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<SpecialistMcpCallResult> {
    return this.handleCall(toolName, args)
  }

  private async handleCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<SpecialistMcpCallResult> {
    switch (toolName) {
      case 'list_specialists':
        return okJson({ specialists: await this.deps.listSpecialists() })
      case 'get_specialist':
        return this.getSpecialist(args)
      case 'list_available_skills':
        return okJson({ skills: await this.deps.listAvailableSkills() })
      case 'list_available_connectors':
        return okJson({ connectors: await this.deps.listAvailableConnectors() })
      case 'create_specialist':
        return this.stageCreate(args)
      case 'update_specialist':
        return this.stageUpdate(args)
      case 'duplicate_specialist':
        return this.stageDuplicate(args)
      case 'set_specialist_enabled':
        return this.stageSetEnabled(args)
      case 'delete_specialist':
        return this.stageDelete(args)
      case 'switch_specialist':
        return this.stageSwitch(args)
      case 'confirm_mutation':
        return this.confirmMutation(args)
      case 'cancel_mutation':
        return this.cancelMutation(args)
      default:
        return fail(`Unknown tool: ${toolName}`)
    }
  }

  private async getSpecialist(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const id = readString(args.id)
    if (!id) return fail('id is required.')
    try {
      return okJson({ specialist: await this.deps.getSpecialist(id) })
    } catch (cause) {
      return fail(sanitizeError(cause))
    }
  }

  // Builds the validation catalog the Settings editor uses, so the same validator rejects the same
  // inputs (true parity rather than a second rule set).
  private async buildValidationCatalog(excludeId?: string) {
    const [specialists, skills, connectors] = await Promise.all([
      this.deps.listSpecialists(),
      this.deps.listAvailableSkills(),
      this.deps.listAvailableConnectors()
    ])
    return {
      agentIds: specialists.filter((s) => s.id !== excludeId).map((s) => s.agentId),
      skillIds: skills.filter((s) => s.enabled).map((s) => s.id),
      connectorIds: connectors.filter((c) => c.enabled).map((c) => c.id)
    }
  }

  private async stageCreate(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const draft = readDraft(args)
    let validated
    try {
      const catalog = await this.buildValidationCatalog()
      validated = validateSpecialistDraft(draft, catalog)
    } catch (cause) {
      return fail(errorText(cause))
    }
    const mutationId = this.nextMutationId()
    this.pending.set(mutationId, { kind: 'create', draft: validated })
    return okJson({ mutationId, preview: previewForCreate(validated) })
  }

  private async stageUpdate(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const id = readString(args.id)
    const expectedRevision = readNumber(args.expectedRevision)
    if (!id || expectedRevision === undefined) return fail('id and expectedRevision are required.')
    let existing: SpecialistView
    try {
      existing = await this.deps.getSpecialist(id)
    } catch (cause) {
      return fail(sanitizeError(cause))
    }
    if (isFullyProtected(existing.kind)) {
      return fail(`${builtinLabel(existing.kind)} is a built-in Specialist and cannot be edited directly.`)
    }
    const draft = readDraft(args)
    let validated
    try {
      const catalog = await this.buildValidationCatalog(id)
      validated = validateSpecialistDraft(draft, {
        ...catalog,
        retainedSkillIds: existing.skillIds,
        retainedConnectorIds: existing.connectorIds
      })
    } catch (cause) {
      return fail(errorText(cause))
    }
    const mutationId = this.nextMutationId()
    this.pending.set(mutationId, { kind: 'update', id, expectedRevision, draft: validated })
    return okJson({
      mutationId,
      preview: previewForUpdate(id, validated, expectedRevision, existing)
    })
  }

  private async stageDuplicate(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const { id, expectedRevision, existing, error } = await this.resolveExisting(args)
    if (error) return error
    if (existing!.kind === 'builtin-reviewer') {
      return fail(`${builtinLabel(existing!.kind)} is a built-in Specialist and cannot be duplicated.`)
    }
    const mutationId = this.nextMutationId()
    this.pending.set(mutationId, { kind: 'duplicate', id: id!, expectedRevision: expectedRevision!, source: existing! })
    return okJson({ mutationId, preview: previewForDuplicate(existing!) })
  }

  private async stageSetEnabled(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const id = readString(args.id)
    const enabled = readBoolean(args.enabled)
    if (!id || enabled === undefined) return fail('id and enabled are required.')
    let existing: SpecialistView
    try {
      existing = await this.deps.getSpecialist(id)
    } catch (cause) {
      return fail(sanitizeError(cause))
    }
    if (existing.kind === 'builtin-reviewer') {
      return fail(`${builtinLabel(existing.kind)} is a built-in Specialist and its enabled state is fixed.`)
    }
    const mutationId = this.nextMutationId()
    this.pending.set(mutationId, { kind: 'setEnabled', id, enabled, source: existing })
    return okJson({ mutationId, preview: previewForSetEnabled(id, enabled, existing) })
  }

  private async stageDelete(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const { id, expectedRevision, existing, error } = await this.resolveExisting(args)
    if (error) return error
    if (isFullyProtected(existing!.kind)) {
      return fail(`${builtinLabel(existing!.kind)} is a built-in Specialist and cannot be deleted.`)
    }
    const mutationId = this.nextMutationId()
    this.pending.set(mutationId, { kind: 'delete', id: id!, expectedRevision: expectedRevision!, source: existing! })
    return okJson({ mutationId, preview: previewForDelete(existing!) })
  }

  private async stageSwitch(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const sessionId = readString(args.sessionId)
    if (!sessionId) return fail('sessionId is required.')
    // null (JSON) → undefined (None). A missing field also means None.
    const specialistId = args.specialistId === null || args.specialistId === undefined
      ? undefined
      : readString(args.specialistId)
    if (args.specialistId !== null && args.specialistId !== undefined && !specialistId) {
      return fail('specialistId must be a stable id or null for None.')
    }
    const mutationId = this.nextMutationId()
    this.pending.set(mutationId, { kind: 'switch', sessionId, specialistId })
    return okJson({
      mutationId,
      preview: {
        action: 'switch',
        targetSessionId: sessionId,
        specialistId,
        affectedSessions: { available: specialistId !== undefined }
      }
    })
  }

  private async confirmMutation(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const mutationId = readString(args.mutationId)
    if (!mutationId) return fail('mutationId is required.')
    const mutation = this.pending.get(mutationId)
    if (!mutation) return fail('Unknown or expired mutation. Re-issue the tool call for a new preview.')
    // Remove first so a mutation can be confirmed at most once, even if execution throws.
    this.pending.delete(mutationId)
    try {
      return await this.executeMutation(mutation)
    } catch (cause) {
      return fail(sanitizeError(cause))
    }
  }

  private async executeMutation(mutation: PendingMutation): Promise<SpecialistMcpCallResult> {
    switch (mutation.kind) {
      case 'create': {
        const created = await this.deps.createSpecialist(mutation.draft)
        const readBack = await this.readBack(created.id, created)
        this.deps.broadcastSettingsRefresh()
        return okJson({ specialist: readBack })
      }
      case 'update': {
        await this.deps.updateSpecialist({ ...mutation.draft, id: mutation.id, expectedRevision: mutation.expectedRevision })
        const readBack = await this.readBack(mutation.id)
        this.deps.broadcastSettingsRefresh()
        return okJson({ specialist: readBack })
      }
      case 'duplicate': {
        const duplicated = await this.deps.duplicateSpecialist({
          id: mutation.id,
          expectedRevision: mutation.expectedRevision
        })
        const readBack = await this.readBack(duplicated.id, duplicated)
        this.deps.broadcastSettingsRefresh()
        return okJson({ specialist: readBack })
      }
      case 'setEnabled': {
        const updated = await this.deps.setSpecialistEnabled({
          id: mutation.id,
          enabled: mutation.enabled
        })
        const readBack = await this.readBack(updated.id, updated)
        this.deps.broadcastSettingsRefresh()
        return okJson({ specialist: readBack })
      }
      case 'delete': {
        await this.deps.deleteSpecialist({ id: mutation.id, expectedRevision: mutation.expectedRevision })
        this.deps.broadcastSettingsRefresh()
        return okJson({ deleted: true, id: mutation.id })
      }
      case 'switch': {
        await this.deps.setSessionSpecialist(mutation.sessionId, mutation.specialistId)
        this.deps.broadcastSettingsRefresh()
        return okJson({ targetSessionId: mutation.sessionId, specialistId: mutation.specialistId })
      }
    }
  }

  private async cancelMutation(args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    const mutationId = readString(args.mutationId)
    if (!mutationId) return fail('mutationId is required.')
    this.pending.delete(mutationId)
    return okJson({ cancelled: true })
  }

  // Reads back the actual stored record after a mutation; falls back to the value the service
  // returned if read-back is unavailable so the caller still sees post-mutation state.
  private async readBack(id: string, fallback?: SpecialistView): Promise<SpecialistView> {
    try {
      return await this.deps.getSpecialist(id)
    } catch {
      if (fallback) return fallback
      throw new Error('The Specialist was saved but could not be read back.')
    }
  }

  private async resolveExisting(args: Record<string, unknown>): Promise<{
    id?: string
    expectedRevision?: number
    existing?: SpecialistView
    error?: SpecialistMcpCallResult
  }> {
    const id = readString(args.id)
    const expectedRevision = readNumber(args.expectedRevision)
    if (!id || expectedRevision === undefined) {
      return { error: fail('id and expectedRevision are required.') }
    }
    try {
      const existing = await this.deps.getSpecialist(id)
      return { id, expectedRevision, existing }
    } catch (cause) {
      return { error: fail(sanitizeError(cause)) }
    }
  }

  private nextMutationId(): string {
    this.mutationSequence += 1
    return `specialist-mutation-${this.mutationSequence}`
  }
}

// --- arg readers + preview builders -----------------------------------------

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const readBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const readDraft = (args: Record<string, unknown>) => ({
  agentId: readString(args.agentId) ?? '',
  name: readString(args.name) ?? '',
  description: readString(args.description),
  instructions: readString(args.instructions),
  colorKey: readString(args.colorKey),
  iconKey: readString(args.iconKey),
  skillIds: Array.isArray(args.skillIds) ? (args.skillIds as string[]).filter((id) => typeof id === 'string') : [],
  connectorIds: Array.isArray(args.connectorIds)
    ? (args.connectorIds as string[]).filter((id) => typeof id === 'string')
    : [],
  enabled: readBoolean(args.enabled) ?? true
})

const instructionsSummaryFor = (
  draft: { instructions?: string },
  existing?: SpecialistView
): SpecialistMutationPreview['instructionsSummary'] => {
  const next = draft.instructions ?? ''
  const before = existing?.instructions ?? ''
  return { changed: next !== before, length: next.length }
}

const previewForCreate = (draft: ReturnType<typeof validateSpecialistDraft>): SpecialistMutationPreview => ({
  action: 'create',
  identity: { agentId: draft.agentId, name: draft.name },
  instructionsSummary: instructionsSummaryFor(draft),
  skills: draft.skillIds,
  connectors: draft.connectorIds,
  affectedSessions: { available: true }
})

const previewForUpdate = (
  id: string,
  draft: ReturnType<typeof validateSpecialistDraft>,
  expectedRevision: number,
  existing: SpecialistView
): SpecialistMutationPreview => ({
  action: 'update',
  identity: { id, agentId: draft.agentId, name: draft.name },
  instructionsSummary: instructionsSummaryFor(draft, existing),
  skills: draft.skillIds,
  connectors: draft.connectorIds,
  expectedRevision,
  affectedSessions: { available: draft.enabled !== false }
})

const previewForDuplicate = (source: SpecialistView): SpecialistMutationPreview => ({
  action: 'duplicate',
  identity: { agentId: source.agentId, name: source.name },
  instructionsSummary: instructionsSummaryFor({ instructions: source.instructions }),
  skills: source.skillIds,
  connectors: source.connectorIds,
  affectedSessions: { available: true }
})

const previewForSetEnabled = (
  id: string,
  enabled: boolean,
  source: SpecialistView
): SpecialistMutationPreview => ({
  action: enabled ? 'enable' : 'disable',
  identity: { id, agentId: source.agentId, name: source.name },
  instructionsSummary: instructionsSummaryFor({ instructions: source.instructions }, source),
  skills: source.skillIds,
  connectors: source.connectorIds,
  affectedSessions: { available: enabled }
})

const previewForDelete = (source: SpecialistView): SpecialistMutationPreview => ({
  action: 'delete',
  identity: { id: source.id, agentId: source.agentId, name: source.name },
  instructionsSummary: { changed: false, length: 0 },
  skills: source.skillIds,
  connectors: source.connectorIds,
  affectedSessions: { available: false }
})

// Validation errors are safe to surface verbatim (they are field-level, never instruction content).
const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'The Specialist draft is invalid.'

// Execution errors come from trusted app services. Pass the message through but never echo caller-
// supplied instruction text: redact anything unusually long that could be a leaked blob.
const sanitizeError = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : 'The Specialist operation failed.'
  if (message.length > 200) return 'The Specialist operation failed.'
  return message
}
