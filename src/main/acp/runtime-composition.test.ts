// Pins the production Agent Context resolver: createAcpRuntime is Electron-coupled, so the lookup
// policy (trim, blank/missing ⇒ undefined, failure ⇒ undefined instead of throwing) is extracted as
// createProjectAgentContextResolver and covered here against a fake repository.

import { describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

const {
  createProjectAgentContextResolver,
  reconcileScopedRuntimeRootOnce,
  resolveSpecialistSkillBindingPolicy
} = await import('./runtime-composition')

describe('createProjectAgentContextResolver', () => {
  it('returns the trimmed Agent Context for a known project', async () => {
    const get = vi.fn(async () => ({ agentContext: '  Always cite DOIs.\n' }))
    const resolver = createProjectAgentContextResolver({ get })

    await expect(resolver('project-1')).resolves.toBe('Always cite DOIs.')
    expect(get).toHaveBeenCalledWith('project-1')
  })

  it('returns undefined when the project is missing or its Agent Context is blank', async () => {
    const missing = createProjectAgentContextResolver({ get: vi.fn(async () => null) })
    const blank = createProjectAgentContextResolver({
      get: vi.fn(async () => ({ agentContext: '   ' }))
    })
    const absent = createProjectAgentContextResolver({ get: vi.fn(async () => ({})) })

    await expect(missing('unknown-id')).resolves.toBeUndefined()
    await expect(blank('project-1')).resolves.toBeUndefined()
    await expect(absent('project-1')).resolves.toBeUndefined()
  })

  it('returns undefined instead of throwing when the lookup fails', async () => {
    const resolver = createProjectAgentContextResolver({
      get: vi.fn(async () => {
        throw new Error('database is locked')
      })
    })

    await expect(resolver('project-1')).resolves.toBeUndefined()
  })
})

describe('scoped runtime reconciliation', () => {
  it('removes crash leftovers once without deleting a later concurrent runtime', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'scoped-runtime-reconcile-'))
    const root = join(parent, 'scoped-agents')
    const stale = join(root, 'reviewer-stale')
    const live = join(root, 'reviewer-live')
    try {
      await mkdir(stale, { recursive: true })
      await reconcileScopedRuntimeRootOnce(root)
      await expect(access(stale)).rejects.toThrow()

      await mkdir(live, { recursive: true })
      await reconcileScopedRuntimeRootOnce(root)
      await expect(access(live)).resolves.toBeUndefined()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('Specialist process scope', () => {
  it('derives an exact current package and Connector binding', async () => {
    await expect(
      resolveSpecialistSkillBindingPolicy(
        {
          resolveRunnableById: async () =>
            ({
              enabled: true,
              capabilityMode: 'selected',
              fullAccess: {
                excludedSkillIds: [],
                excludedConnectorIds: [],
                connectorTools: []
              },
              selectedCapabilities: {
                skillIds: ['specialist-package'],
                connectorIds: ['pubmed'],
                connectorTools: []
              }
            }) as never
        },
        {
          listSpecialistSkillCatalog: async () => [
            {
              id: 'specialist-package',
              frameworkName: 'specialist-package',
              displayName: 'Specialist package',
              source: 'personal',
              mainEnabled: false,
              available: true
            },
            {
              id: 'unrelated-package',
              frameworkName: 'unrelated-package',
              displayName: 'Unrelated package',
              source: 'featured',
              mainEnabled: true,
              available: true
            }
          ],
          provisionedConnectorSkillNames: async () => ['mcp-pubmed', 'mcp-zotero']
        },
        'specialist-1'
      )
    ).resolves.toEqual({
      kind: 'exact',
      allowedSkillIds: ['specialist-package', 'mcp-pubmed']
    })
  })
})
