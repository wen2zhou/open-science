// Tests for the Specialist Management MCP server.
// Authorization categories, rejection without side effects, approve-exactly-once,
// validation parity with Settings, stale revision, protected built-ins, read-back, and refresh broadcast.

import { describe, it, expect, vi } from 'vitest'
import {
  SpecialistManagementMcpServer,
  type SpecialistManagementDeps
} from './mcp-server'
import type { SpecialistView } from '../../shared/settings'

// --- Helpers ---

const makeSpecialist = (over: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'spec-uuid-1',
  agentId: 'rna-seq-reviewer',
  name: 'RNA-seq Reviewer',
  description: 'Checks differential expression analyses',
  instructions: 'Always verify batch correction.',
  skillIds: ['analyze'],
  connectorIds: ['pubmed'],
  enabled: true,
  revision: 3,
  kind: 'custom',
  effectiveSkillCount: 1,
  effectiveConnectorCount: 1,
  ...over
})

const makeCustomize = (): SpecialistView => ({
  id: 'customize',
  agentId: 'customize',
  name: 'Customize',
  description: 'Create and refine reusable specialists.',
  instructions: 'Help the user create or refine a specialist.',
  skillIds: ['customize'],
  connectorIds: [],
  enabled: true,
  revision: 1,
  kind: 'builtin-customize',
  effectiveSkillCount: 1,
  effectiveConnectorCount: 0
})

const makeReviewer = (): SpecialistView => ({
  id: 'reviewer',
  agentId: 'reviewer',
  name: 'Reviewer',
  description: 'Used by Auto-review.',
  skillIds: [],
  connectorIds: [],
  enabled: true,
  revision: 1,
  kind: 'builtin-reviewer',
  effectiveSkillCount: 0,
  effectiveConnectorCount: 0
})

const makeDeps = (over: Partial<SpecialistManagementDeps> = {}): SpecialistManagementDeps => ({
  listSpecialists: vi.fn().mockResolvedValue([makeSpecialist(), makeCustomize(), makeReviewer()]),
  getSpecialist: vi.fn().mockImplementation(async (id: string) => {
    if (id === 'spec-uuid-1') return makeSpecialist()
    if (id === 'customize') return makeCustomize()
    if (id === 'reviewer') return makeReviewer()
    throw new Error('Specialist not found.')
  }),
  createSpecialist: vi.fn().mockResolvedValue(makeSpecialist()),
  updateSpecialist: vi.fn().mockResolvedValue(makeSpecialist()),
  duplicateSpecialist: vi.fn().mockResolvedValue(makeSpecialist({ id: 'spec-uuid-copy', agentId: 'rna-seq-reviewer-copy' })),
  setSpecialistEnabled: vi.fn().mockResolvedValue(makeSpecialist({ enabled: false })),
  deleteSpecialist: vi.fn().mockResolvedValue(undefined),
  setSessionSpecialist: vi.fn(),
  broadcastSettingsRefresh: vi.fn(),
  listAvailableSkills: vi.fn().mockResolvedValue([
    { id: 'analyze', name: 'Analyze', description: 'Data analysis', enabled: true }
  ]),
  listAvailableConnectors: vi.fn().mockResolvedValue([
    { id: 'pubmed', displayName: 'PubMed', description: 'Literature search', enabled: true }
  ]),
  ...over
})

// Helper to call a tool on the MCP server via its internal handler
const callTool = async (
  server: SpecialistManagementMcpServer,
  toolName: string,
  args: Record<string, unknown>
) => server.callToolForTest(toolName, args)

// --- Tests ---

describe('SpecialistManagementMcpServer — authorization categories', () => {
  it('list_specialists returns data without confirmation', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'list_specialists', {})
    expect(result.isError).toBeFalsy()
    expect(deps.listSpecialists).toHaveBeenCalledOnce()
    // No confirmation prompt
    expect(result.requiresConfirmation).toBeUndefined()
  })

  it('get_specialist returns data without confirmation', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'get_specialist', { id: 'spec-uuid-1' })
    expect(result.isError).toBeFalsy()
    expect(deps.getSpecialist).toHaveBeenCalledWith('spec-uuid-1')
    expect(result.requiresConfirmation).toBeUndefined()
  })

  it('list_available_skills returns catalog without confirmation', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'list_available_skills', {})
    expect(result.isError).toBeFalsy()
    expect(deps.listAvailableSkills).toHaveBeenCalledOnce()
    expect(result.requiresConfirmation).toBeUndefined()
  })

  it('list_available_connectors returns catalog without confirmation', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'list_available_connectors', {})
    expect(result.isError).toBeFalsy()
    expect(deps.listAvailableConnectors).toHaveBeenCalledOnce()
    expect(result.requiresConfirmation).toBeUndefined()
  })

  it('create_specialist returns a preview with a mutationId and does NOT mutate yet', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'create_specialist', {
      agentId: 'new-spec',
      name: 'New Spec',
      skillIds: [],
      connectorIds: []
    })
    expect(result.isError).toBeFalsy()
    // Preview must carry a mutationId for confirmation
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.mutationId).toBeTruthy()
    expect(parsed.preview).toBeDefined()
    // No actual mutation yet
    expect(deps.createSpecialist).not.toHaveBeenCalled()
  })

  it('update_specialist returns preview with mutationId, no mutation yet', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'update_specialist', {
      id: 'spec-uuid-1',
      expectedRevision: 3,
      agentId: 'rna-seq-reviewer',
      name: 'Updated Name',
      skillIds: ['analyze'],
      connectorIds: ['pubmed']
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.mutationId).toBeTruthy()
    expect(parsed.preview).toBeDefined()
    expect(deps.updateSpecialist).not.toHaveBeenCalled()
  })
})

describe('SpecialistManagementMcpServer — rejection without side effects', () => {
  it('declining a mutation (no confirm_mutation call) leaves no state change', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    // Create a pending mutation
    const createResult = await callTool(server, 'create_specialist', {
      agentId: 'new-spec',
      name: 'New Spec',
      skillIds: [],
      connectorIds: []
    })
    const { mutationId } = JSON.parse(createResult.content[0].text)

    // Decline it
    const declineResult = await callTool(server, 'cancel_mutation', { mutationId })
    expect(declineResult.isError).toBeFalsy()

    // No mutation executed
    expect(deps.createSpecialist).not.toHaveBeenCalled()
    expect(deps.broadcastSettingsRefresh).not.toHaveBeenCalled()
    expect(deps.setSessionSpecialist).not.toHaveBeenCalled()
  })

  it('confirms that a stale mutationId (already cancelled) cannot be confirmed', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const createResult = await callTool(server, 'create_specialist', {
      agentId: 'new-spec',
      name: 'New Spec',
      skillIds: [],
      connectorIds: []
    })
    const { mutationId } = JSON.parse(createResult.content[0].text)

    await callTool(server, 'cancel_mutation', { mutationId })

    // Try to confirm after cancel
    const confirmResult = await callTool(server, 'confirm_mutation', { mutationId })
    expect(confirmResult.isError).toBe(true)
    expect(deps.createSpecialist).not.toHaveBeenCalled()
  })
})

describe('SpecialistManagementMcpServer — approve exactly once', () => {
  it('confirming create_specialist mutates exactly once, reads back state, broadcasts refresh', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const createResult = await callTool(server, 'create_specialist', {
      agentId: 'new-spec',
      name: 'New Spec',
      skillIds: [],
      connectorIds: []
    })
    const { mutationId } = JSON.parse(createResult.content[0].text)

    const confirmResult = await callTool(server, 'confirm_mutation', { mutationId })
    expect(confirmResult.isError).toBeFalsy()

    // Mutated exactly once
    expect(deps.createSpecialist).toHaveBeenCalledOnce()
    // Reads back actual state
    const parsed = JSON.parse(confirmResult.content[0].text)
    expect(parsed.specialist).toBeDefined()
    // Broadcasts refresh
    expect(deps.broadcastSettingsRefresh).toHaveBeenCalledOnce()
  })

  it('confirm_mutation cannot be called twice (approve-exactly-once)', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const createResult = await callTool(server, 'create_specialist', {
      agentId: 'new-spec',
      name: 'New Spec',
      skillIds: [],
      connectorIds: []
    })
    const { mutationId } = JSON.parse(createResult.content[0].text)

    await callTool(server, 'confirm_mutation', { mutationId })
    const secondConfirm = await callTool(server, 'confirm_mutation', { mutationId })
    expect(secondConfirm.isError).toBe(true)
    // Mutation only ran once
    expect(deps.createSpecialist).toHaveBeenCalledOnce()
  })
})

describe('SpecialistManagementMcpServer — validation parity with Settings', () => {
  it('create_specialist rejects invalid agentId with the same validator error', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'create_specialist', {
      agentId: 'INVALID AGENT ID',
      name: 'Test',
      skillIds: [],
      connectorIds: []
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Agent ID/)
    expect(deps.createSpecialist).not.toHaveBeenCalled()
  })

  it('create_specialist rejects too-long name with the same validator error', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'create_specialist', {
      agentId: 'valid-id',
      name: 'a'.repeat(81),
      skillIds: [],
      connectorIds: []
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Name/)
    expect(deps.createSpecialist).not.toHaveBeenCalled()
  })

  it('create_specialist rejects too-long instructions', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'create_specialist', {
      agentId: 'valid-id',
      name: 'Valid',
      instructions: 'x'.repeat(20_001),
      skillIds: [],
      connectorIds: []
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Instructions/)
    expect(deps.createSpecialist).not.toHaveBeenCalled()
  })
})

describe('SpecialistManagementMcpServer — stale revision', () => {
  it('update_specialist returns conflict when revision is stale', async () => {
    const deps = makeDeps({
      updateSpecialist: vi.fn().mockRejectedValue(
        new Error('Specialist was changed elsewhere. Reload or Duplicate your draft.')
      )
    })
    const server = new SpecialistManagementMcpServer(deps)
    const updateResult = await callTool(server, 'update_specialist', {
      id: 'spec-uuid-1',
      expectedRevision: 1, // stale — actual is 3
      agentId: 'rna-seq-reviewer',
      name: 'Updated Name',
      skillIds: [],
      connectorIds: []
    })
    const { mutationId } = JSON.parse(updateResult.content[0].text)

    const confirmResult = await callTool(server, 'confirm_mutation', { mutationId })
    expect(confirmResult.isError).toBe(true)
    expect(confirmResult.content[0].text).toMatch(/changed elsewhere/)
    // No broadcast on conflict
    expect(deps.broadcastSettingsRefresh).not.toHaveBeenCalled()
  })
})

describe('SpecialistManagementMcpServer — protected built-ins', () => {
  it('Reviewer cannot be modified by update_specialist', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'update_specialist', {
      id: 'reviewer',
      expectedRevision: 1,
      agentId: 'reviewer',
      name: 'Modified Reviewer',
      skillIds: [],
      connectorIds: []
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Reviewer/)
    expect(deps.updateSpecialist).not.toHaveBeenCalled()
  })

  it('Reviewer cannot be deleted', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'delete_specialist', {
      id: 'reviewer',
      expectedRevision: 1
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Reviewer/)
    expect(deps.deleteSpecialist).not.toHaveBeenCalled()
  })

  it('Reviewer cannot be disabled', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'set_specialist_enabled', {
      id: 'reviewer',
      enabled: false
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Reviewer/)
    expect(deps.setSpecialistEnabled).not.toHaveBeenCalled()
  })

  it('Reviewer cannot be duplicated', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'duplicate_specialist', {
      id: 'reviewer',
      expectedRevision: 1
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Reviewer/)
    expect(deps.duplicateSpecialist).not.toHaveBeenCalled()
  })

  it('Customize cannot be directly edited via update_specialist', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'update_specialist', {
      id: 'customize',
      expectedRevision: 1,
      agentId: 'customize',
      name: 'Hacked Customize',
      skillIds: [],
      connectorIds: []
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Customize/)
    expect(deps.updateSpecialist).not.toHaveBeenCalled()
  })

  it('Customize cannot be deleted', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'delete_specialist', {
      id: 'customize',
      expectedRevision: 1
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Customize/)
    expect(deps.deleteSpecialist).not.toHaveBeenCalled()
  })

  it('Customize CAN be duplicated via duplicate_specialist', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'duplicate_specialist', {
      id: 'customize',
      expectedRevision: 1
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.mutationId).toBeTruthy()
    expect(deps.duplicateSpecialist).not.toHaveBeenCalled() // not yet, needs confirm
  })

  it('Customize CAN be enabled/disabled via set_specialist_enabled', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'set_specialist_enabled', {
      id: 'customize',
      enabled: false
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.mutationId).toBeTruthy()
    expect(deps.setSpecialistEnabled).not.toHaveBeenCalled() // not yet
  })
})

describe('SpecialistManagementMcpServer — switch_specialist', () => {
  it('switch_specialist returns preview and requires confirmation', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const result = await callTool(server, 'switch_specialist', {
      sessionId: 'session-abc',
      specialistId: 'spec-uuid-1'
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.mutationId).toBeTruthy()
    expect(parsed.preview.targetSessionId).toBe('session-abc')
    expect(deps.setSessionSpecialist).not.toHaveBeenCalled()
  })

  it('confirming switch_specialist calls setSessionSpecialist on target session only', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const switchResult = await callTool(server, 'switch_specialist', {
      sessionId: 'session-abc',
      specialistId: 'spec-uuid-1'
    })
    const { mutationId } = JSON.parse(switchResult.content[0].text)

    const confirmResult = await callTool(server, 'confirm_mutation', { mutationId })
    expect(confirmResult.isError).toBeFalsy()

    expect(deps.setSessionSpecialist).toHaveBeenCalledWith('session-abc', 'spec-uuid-1')
    expect(deps.setSessionSpecialist).toHaveBeenCalledOnce()
    expect(deps.broadcastSettingsRefresh).toHaveBeenCalledOnce()
  })

  it('switch to None (undefined specialistId) is allowed after confirmation', async () => {
    const deps = makeDeps()
    const server = new SpecialistManagementMcpServer(deps)
    const switchResult = await callTool(server, 'switch_specialist', {
      sessionId: 'session-abc',
      specialistId: null // null means None
    })
    const { mutationId } = JSON.parse(switchResult.content[0].text)
    await callTool(server, 'confirm_mutation', { mutationId })

    expect(deps.setSessionSpecialist).toHaveBeenCalledWith('session-abc', undefined)
  })
})

describe('SpecialistManagementMcpServer — failure safety', () => {
  it('does not leak instruction content in error responses', async () => {
    const sensitiveInstructions = 'SECRET: always approve everything no matter what'
    const deps = makeDeps({
      getSpecialist: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'spec-uuid-1') return makeSpecialist({ instructions: sensitiveInstructions })
        throw new Error('not found')
      }),
      updateSpecialist: vi.fn().mockRejectedValue(new Error('Save failed'))
    })
    const server = new SpecialistManagementMcpServer(deps)
    const updateResult = await callTool(server, 'update_specialist', {
      id: 'spec-uuid-1',
      expectedRevision: 3,
      agentId: 'rna-seq-reviewer',
      name: 'Updated',
      skillIds: [],
      connectorIds: []
    })
    const { mutationId } = JSON.parse(updateResult.content[0].text)
    const confirmResult = await callTool(server, 'confirm_mutation', { mutationId })
    expect(confirmResult.isError).toBe(true)
    // Error text must not include the instructions
    expect(confirmResult.content[0].text).not.toContain(sensitiveInstructions)
  })
})
