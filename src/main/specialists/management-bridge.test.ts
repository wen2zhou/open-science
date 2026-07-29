import { describe, expect, it, vi } from 'vitest'

import type { SpecialistView, CreateSpecialistRequest } from '../../shared/settings'

import { SpecialistManagementBridge } from './management-bridge'

// Builds an in-memory settings stub the bridge can wire to. Mirrors the real SettingsService surface the
// bridge consumes (list/get/create/... + the two global catalogs), with a write log so tests assert which
// mutations actually persisted and how many times the refresh broadcast fired.
const makeSettings = (initial: SpecialistView[] = []) => {
  const stored = new Map<string, SpecialistView>(initial.map((s) => [s.id, s]))
  const writes = { create: 0, update: 0, duplicate: 0, setEnabled: 0, delete: 0 }
  return {
    writes,
    stored,
    listSpecialists: async () => [...stored.values()],
    getSpecialist: async (id: string) => {
      const found = stored.get(id)
      if (!found) throw new Error('Specialist not found.')
      return found
    },
    createSpecialist: async (request: CreateSpecialistRequest) => {
      writes.create += 1
      const created: SpecialistView = {
        id: `sp-${stored.size + 1}`,
        agentId: request.agentId,
        name: request.name,
        description: request.description,
        instructions: request.instructions,
        colorKey: request.colorKey,
        iconKey: request.iconKey,
        skillIds: request.skillIds ?? [],
        connectorIds: request.connectorIds ?? [],
        enabled: request.enabled ?? true,
        revision: 1,
        kind: 'custom',
        effectiveSkillCount: request.skillIds?.length ?? 0,
        effectiveConnectorCount: request.connectorIds?.length ?? 0
      }
      stored.set(created.id, created)
      return created
    },
    updateSpecialist: async () => {
      writes.update += 1
      throw new Error('not used here')
    },
    duplicateSpecialist: async () => {
      writes.duplicate += 1
      throw new Error('not used here')
    },
    setSpecialistEnabled: async () => {
      writes.setEnabled += 1
      throw new Error('not used here')
    },
    deleteSpecialist: async () => {
      writes.delete += 1
    },
    getGlobalSkillCatalog: async () => [
      { id: 'customize', frameworkName: 'Customize', enabled: true },
      { id: 'rna-seq', frameworkName: 'RNA-seq', enabled: true }
    ],
    getGlobalConnectorCatalog: async () => [
      { id: 'pubmed', enabled: true },
      { id: 'geo', enabled: false }
    ]
  }
}

describe('SpecialistManagementBridge', () => {
  it('stages a create without persisting and broadcasts nothing', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const registry = { set: vi.fn() }
    const bridge = new SpecialistManagementBridge({
      settings,
      registry,
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('create_specialist', {
      agentId: 'rna-reviewer',
      name: 'RNA Reviewer',
      skillIds: ['rna-seq'],
      connectorIds: ['pubmed']
    })

    expect(staged.mutationId).toMatch(/^specialist-mutation-/)
    expect(staged.preview.action).toBe('create')
    expect(staged.preview.identity.name).toBe('RNA Reviewer')
    expect(staged.preview.skills).toEqual(['rna-seq'])
    expect(staged.preview.connectors).toEqual(['pubmed'])
    // Nothing persisted yet, nothing broadcast.
    expect(settings.writes.create).toBe(0)
    expect(refresh).not.toHaveBeenCalled()
    expect(registry.set).not.toHaveBeenCalled()
  })

  it('confirming applies the mutation once, reads it back, and broadcasts the refresh', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const bridge = new SpecialistManagementBridge({
      settings: settings,
      registry: { set: vi.fn() },
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('create_specialist', {
      agentId: 'rna-reviewer',
      name: 'RNA Reviewer'
    })
    const confirmed = await bridge.confirmMutation(staged.mutationId)

    expect(settings.writes.create).toBe(1)
    expect(confirmed.specialist?.agentId).toBe('rna-reviewer')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a mutationId can only be confirmed once', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const bridge = new SpecialistManagementBridge({
      settings: settings,
      registry: { set: vi.fn() },
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('create_specialist', {
      agentId: 'rna-reviewer',
      name: 'RNA Reviewer'
    })
    await bridge.confirmMutation(staged.mutationId)
    // Second confirm is a no-op mutation (unknown id) — nothing new is written or broadcast.
    await expect(bridge.confirmMutation(staged.mutationId)).rejects.toThrow(/Unknown or expired/i)
    expect(settings.writes.create).toBe(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('declining (cancel) leaves storage and the broadcast untouched', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const bridge = new SpecialistManagementBridge({
      settings: settings,
      registry: { set: vi.fn() },
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('create_specialist', {
      agentId: 'rna-reviewer',
      name: 'RNA Reviewer'
    })
    await bridge.cancelMutation(staged.mutationId)

    expect(settings.writes.create).toBe(0)
    expect(refresh).not.toHaveBeenCalled()
    // After cancel, confirming the same id is rejected — the staged mutation is gone.
    await expect(bridge.confirmMutation(staged.mutationId)).rejects.toThrow(/Unknown or expired/i)
  })

  it('an approved switch updates only the session specialistId and broadcasts once', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const registry = { set: vi.fn() }
    const bridge = new SpecialistManagementBridge({
      settings: settings,
      registry,
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('switch_specialist', {
      sessionId: 'session-1',
      specialistId: 'sp-target'
    })
    expect(staged.preview.action).toBe('switch')

    const confirmed = await bridge.confirmMutation(staged.mutationId)
    expect(confirmed.switched).toEqual({ targetSessionId: 'session-1', specialistId: 'sp-target' })
    // The switch path writes ONLY specialistId — never a permission profile.
    expect(registry.set).toHaveBeenCalledWith('session-1', 'sp-target')
    expect(registry.set).toHaveBeenCalledTimes(1)
    expect(settings.writes.create).toBe(0)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('switch to None writes undefined and broadcasts once', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const registry = { set: vi.fn() }
    const bridge = new SpecialistManagementBridge({
      settings: settings,
      registry,
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('switch_specialist', {
      sessionId: 'session-1',
      specialistId: null
    })
    const confirmed = await bridge.confirmMutation(staged.mutationId)
    expect(confirmed.switched?.specialistId).toBeUndefined()
    expect(registry.set).toHaveBeenCalledWith('session-1', undefined)
  })

  it('read-only catalog calls go straight through without confirmation', async () => {
    const settings = makeSettings([
      {
        id: 'sp-1',
        agentId: 'existing',
        name: 'Existing',
        skillIds: [],
        connectorIds: [],
        enabled: true,
        revision: 1,
        kind: 'custom',
        effectiveSkillCount: 0,
        effectiveConnectorCount: 0
      }
    ])
    const refresh = vi.fn()
    const bridge = new SpecialistManagementBridge({
      settings: settings,
      registry: { set: vi.fn() },
      broadcastSettingsRefresh: refresh
    })

    const list = await bridge.callTool('list_specialists', {})
    expect(list.isError).toBeFalsy()
    const skills = await bridge.callTool('list_available_skills', {})
    const parsedSkills = JSON.parse(skills.content[0].text)
    expect(parsedSkills.skills.map((s: { id: string }) => s.id)).toEqual(['customize', 'rna-seq'])
    expect(refresh).not.toHaveBeenCalled()
  })
})

// Criteria-level integration: the runtime contract behind the two 04b criteria.
describe('SpecialistManagementBridge — 04b criteria', () => {
  it('approving a create shows exactly ONE new Custom row in the catalog, broadcast once', async () => {
    // Start with one existing Custom row, mirroring an already-open Settings page.
    const settings = makeSettings([
      {
        id: 'sp-existing',
        agentId: 'existing',
        name: 'Existing',
        skillIds: [],
        connectorIds: [],
        enabled: true,
        revision: 1,
        kind: 'custom',
        effectiveSkillCount: 0,
        effectiveConnectorCount: 0
      }
    ])
    const refresh = vi.fn()
    const bridge = new SpecialistManagementBridge({
      settings,
      registry: { set: vi.fn() },
      broadcastSettingsRefresh: refresh
    })

    const before = await settings.listSpecialists()
    expect(before).toHaveLength(1)

    // Approve path: stage then confirm exactly once.
    const staged = await bridge.stageMutation('create_specialist', {
      agentId: 'rna-reviewer',
      name: 'RNA Reviewer'
    })
    const confirmed = await bridge.confirmMutation(staged.mutationId)

    // Exactly one new row appears in the live catalog; the read-back is the new record.
    const after = await settings.listSpecialists()
    expect(after).toHaveLength(2)
    expect(after.some((s) => s.id === confirmed.specialist?.id)).toBe(true)
    // The refresh broadcast fires exactly once — the already-open Settings page reloads immediately.
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('an approved switch updates ONLY the session specialistId (next-message semantics), not permission', async () => {
    const settings = makeSettings()
    const refresh = vi.fn()
    const registry = { set: vi.fn() }
    // A permission-profile setter the switch path must NEVER touch. The bridge has no reference to it,
    // so this guards the invariant structurally: if switch ever widened, this spy would still be unused.
    const setPermissionProfile = vi.fn()
    const bridge = new SpecialistManagementBridge({
      settings,
      registry,
      broadcastSettingsRefresh: refresh
    })

    const staged = await bridge.stageMutation('switch_specialist', {
      sessionId: 'session-1',
      specialistId: 'sp-target'
    })
    const confirmed = await bridge.confirmMutation(staged.mutationId)

    // The switch keeps the current turn on the old identity and applies the new binding from the next
    // message: it writes ONLY the session specialistId into the registry, and broadcasts once.
    expect(confirmed.switched).toEqual({ targetSessionId: 'session-1', specialistId: 'sp-target' })
    expect(registry.set).toHaveBeenCalledTimes(1)
    expect(registry.set).toHaveBeenCalledWith('session-1', 'sp-target')
    expect(setPermissionProfile).not.toHaveBeenCalled()
    // No specialist record is created/updated by a switch.
    expect(settings.writes.create).toBe(0)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
