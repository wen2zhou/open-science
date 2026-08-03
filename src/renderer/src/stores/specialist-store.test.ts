import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSpecialistStore } from './specialist-store'

const setSpecialistApi = (api: Partial<Window['api']['specialist']>): void => {
  ;(globalThis as unknown as { window: { api: { specialist: unknown } } }).window = {
    api: { specialist: api }
  } as never
}

beforeEach(() => {
  useSpecialistStore.setState({ items: [], isLoaded: false, packagePreview: undefined })
})

describe('specialist store package import', () => {
  it('keeps only the renderer-safe preview and reloads the catalog after a durable install', async () => {
    const preview = {
      candidateToken: 'candidate-1',
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        name: 'Research Synthesizer',
        description: 'Synthesizes research.',
        source: 'zip' as const,
        requiresApp: '>=0.9.2 <1.0.0',
        bundledSkillIds: [],
        requiredSkillIds: [],
        builtinSkillIds: [],
        connectorIds: ['missing-lab']
      },
      diagnostics: [
        {
          severity: 'warning' as const,
          code: 'connector.unavailable',
          message: 'Connector is unavailable.',
          relatedId: 'missing-lab'
        }
      ],
      installable: true
    }
    const installed = {
      kind: 'custom' as const,
      id: 'research-synth',
      name: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'private',
      enabled: true,
      capabilityMode: 'selected' as const,
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: ['missing-lab'], connectorTools: [] },
      revision: 1,
      packageVersion: '1.3.0',
      origin: 'imported' as const,
      ownedSkillIds: []
    }
    const list = vi.fn().mockResolvedValue([installed, { kind: 'reviewer', id: 'reviewer' }])
    setSpecialistApi({
      selectPackage: vi.fn().mockResolvedValue(preview),
      installPackage: vi.fn().mockResolvedValue({ status: 'installed', specialist: installed }),
      list
    })

    await expect(useSpecialistStore.getState().selectPackage()).resolves.toEqual(preview)
    expect(useSpecialistStore.getState().packagePreview).toEqual(preview)
    await expect(useSpecialistStore.getState().installPackage()).resolves.toMatchObject({
      status: 'installed'
    })
    expect(list).toHaveBeenCalledOnce()
    expect(useSpecialistStore.getState().items[0]).toMatchObject({
      id: 'research-synth',
      origin: 'imported'
    })
  })
})
