// Runtime bridge that instantiates the deps-driven SpecialistManagementMcpServer (issue 04a) inside
// the main process and wires it to the real settings service, the per-session Specialist registry,
// and the renderer-facing settings refresh broadcast. This closes the gap left open by 04a: the
// management tool surface was fully built and unit-tested, but never instantiated, and nothing routed
// the Customize agent's mutation proposals into the chat approval card or back through confirmation.
//
// The bridge is intentionally narrow: it does NOT re-implement any management logic. It builds the
// SpecialistManagementDeps from live app services and exposes a typed call surface (stageMutation /
// confirmMutation / cancelMutation / readTools) that the Customize chat confirm path and the approval
// card invoke through IPC. Read-only tools (list/get/catalogs) go straight through `callTool`; mutations
// always return the 04a preview + mutationId and are persisted only when confirmMutation is called.
//
// Permission-mode invariant: every operation here touches only specialist storage and the session
// specialistId binding. It never reads or writes the session permission profile, so create/update/switch
// cannot alter the current session's permission mode.

import type { SpecialistView } from '../../shared/settings'
import type {
  SpecialistSkillCatalogEntry,
  SpecialistConnectorCatalogEntry,
  SpecialistManagementDeps,
  SpecialistMcpCallResult,
  SpecialistMutationPreview
} from './mcp-server'
import { SpecialistManagementMcpServer } from './mcp-server'

// The settings-service seam the bridge consumes. Kept structural so a test can pass a small stub; in
// production this is the real SettingsService.
export type SpecialistManagementBridgeSettings = {
  listSpecialists: () => Promise<SpecialistView[]>
  getSpecialist: (id: string) => Promise<SpecialistView>
  createSpecialist: (input: import('../../shared/settings').CreateSpecialistRequest) => Promise<SpecialistView>
  updateSpecialist: (input: import('../../shared/settings').UpdateSpecialistRequest) => Promise<SpecialistView>
  duplicateSpecialist: (input: import('../../shared/settings').DuplicateSpecialistRequest) => Promise<SpecialistView>
  setSpecialistEnabled: (input: import('../../shared/settings').SetSpecialistEnabledRequest) => Promise<SpecialistView>
  deleteSpecialist: (input: import('../../shared/settings').DeleteSpecialistRequest) => Promise<void>
  // Catalog reads the management tool uses to build its validation parity and preview completeness.
  // These return the SAME global enabled-state the runtime gate resolves, so a previewed set never
  // disagrees with what the effective-capability gate would allow.
  getGlobalSkillCatalog: () => Promise<import('./effective-capabilities').GlobalSkillEntry[]>
  getGlobalConnectorCatalog: () => Promise<import('./effective-capabilities').GlobalConnectorEntry[]>
}

// Per-session Specialist registry seam. The bridge's switch path writes ONLY specialistId here, never
// the permission profile — matching the issue-02 next-message switch semantics.
export type SpecialistManagementBridgeRegistry = {
  set: (sessionId: string, specialistId: string | undefined) => void
}

export type SpecialistManagementBridgeOptions = {
  settings: SpecialistManagementBridgeSettings
  registry: SpecialistManagementBridgeRegistry
  // Broadcasts a "specialists changed" signal so an already-open Settings page reloads and shows the
  // newly created/updated row immediately (no restart). This is the SAME refresh the settings UI emits
  // after its own direct mutations, so the live catalog and the UI stay in sync from either origin.
  broadcastSettingsRefresh: () => void
}

// Typed result for a mutation-stage call: the structured preview the approval card renders, plus the
// single-use mutationId the caller must pass back to confirm or cancel the staged mutation.
export type SpecialistMutationStageResult = {
  mutationId: string
  preview: SpecialistMutationPreview
}

const parseContent = (result: SpecialistMcpCallResult): unknown => {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// Decodes the raw management-MCP tool result into the bridge's typed result, throwing when the tool
// reported an error so callers surface failures instead of silently persisting nothing.
const decodeStageResult = (result: SpecialistMcpCallResult): SpecialistMutationStageResult => {
  if (result.isError) {
    const text = result.content.find((entry) => entry.type === 'text')?.text ?? 'Mutation rejected.'
    throw new Error(text)
  }
  const payload = parseContent(result) as { mutationId?: string; preview?: SpecialistMutationPreview }
  if (!payload.mutationId || !payload.preview) {
    throw new Error('The management tool did not return a mutation preview.')
  }
  return { mutationId: payload.mutationId, preview: payload.preview }
}

export class SpecialistManagementBridge {
  private readonly server: SpecialistManagementMcpServer

  constructor(options: SpecialistManagementBridgeOptions) {
    const deps: SpecialistManagementDeps = {
      listSpecialists: () => options.settings.listSpecialists(),
      getSpecialist: (id) => options.settings.getSpecialist(id),
      createSpecialist: (input) => options.settings.createSpecialist(input),
      updateSpecialist: (input) => options.settings.updateSpecialist(input),
      duplicateSpecialist: (input) => options.settings.duplicateSpecialist(input),
      setSpecialistEnabled: (input) => options.settings.setSpecialistEnabled(input),
      deleteSpecialist: (input) => options.settings.deleteSpecialist(input),
      setSessionSpecialist: (sessionId, specialistId) =>
        options.registry.set(sessionId, specialistId),
      broadcastSettingsRefresh: () => options.broadcastSettingsRefresh(),
      listAvailableSkills: async (): Promise<SpecialistSkillCatalogEntry[]> =>
        options.settings.getGlobalSkillCatalog().then((skills) =>
          skills.map((skill) => ({
            id: skill.id,
            name: skill.frameworkName,
            enabled: skill.enabled
          }))
        ),
      listAvailableConnectors: async (): Promise<SpecialistConnectorCatalogEntry[]> =>
        options.settings.getGlobalConnectorCatalog().then((connectors) =>
          connectors.map((connector) => ({
            id: connector.id,
            displayName: connector.id,
            enabled: connector.enabled
          }))
        )
    }
    this.server = new SpecialistManagementMcpServer(deps)
  }

  // Routes an arbitrary management tool call through the underlying server. Used for read-only tools
  // (list_specialists / get_specialist / list_available_skills / list_available_connectors) that need no
  // confirmation. Mutations should go through stageMutation so the caller renders the approval card.
  async callTool(toolName: string, args: Record<string, unknown>): Promise<SpecialistMcpCallResult> {
    return this.server.callToolForTest(toolName, args)
  }

  // Stages a mutation: returns the structured preview + a single-use mutationId. Nothing is persisted.
  // The Customize chat renders the preview as the approval card; the user must approve (confirmMutation)
  // or decline (cancelMutation) before anything is written.
  async stageMutation(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<SpecialistMutationStageResult> {
    const result = await this.server.callToolForTest(toolName, args)
    return decodeStageResult(result)
  }

  // Confirms a previously staged mutation exactly once. The management server applies it, reads back the
  // actual post-mutation state, and broadcasts the settings refresh so an open Settings page updates.
  // On success returns the post-mutation Specialist (or, for switch, the new session binding).
  async confirmMutation(
    mutationId: string
  ): Promise<{ specialist?: SpecialistView; switched?: { targetSessionId: string; specialistId?: string } }> {
    const result = await this.server.callToolForTest('confirm_mutation', { mutationId })
    if (result.isError) {
      const text = result.content.find((entry) => entry.type === 'text')?.text ?? 'Confirmation failed.'
      throw new Error(text)
    }
    const payload = parseContent(result) as {
      specialist?: SpecialistView
      targetSessionId?: string
      specialistId?: string
    }
    if (payload.targetSessionId !== undefined) {
      return { switched: { targetSessionId: payload.targetSessionId, specialistId: payload.specialistId } }
    }
    if (!payload.specialist) {
      throw new Error('The mutation was confirmed but no Specialist was read back.')
    }
    return { specialist: payload.specialist }
  }

  // Cancels a staged mutation with no side effects. Used when the user declines the approval card.
  async cancelMutation(mutationId: string): Promise<void> {
    await this.server.callToolForTest('cancel_mutation', { mutationId })
  }
}
