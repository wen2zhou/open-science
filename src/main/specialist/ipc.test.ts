import { describe, expect, it, vi } from 'vitest'

import type { SpecialistProfileView } from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { SessionBindingService } from './session-binding'
import { registerSpecialistIpcHandlers } from './ipc'
import type { ProfileService } from './service'

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const profile = {
  id: 'specialist-1',
  name: 'RESEARCHER',
  description: '',
  systemPrompt: 'Research.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
} as SpecialistProfileView

const createProfileService = (): ProfileService =>
  ({
    getById: vi.fn().mockResolvedValue(profile),
    listForSettings: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn()
  }) as unknown as ProfileService

describe('specialist session IPC', () => {
  it('registers and persists a session specialist switch', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const persistSessionSpecialist = vi.fn().mockResolvedValue(undefined)

    registerSpecialistIpcHandlers(createProfileService(), binding, persistSessionSpecialist)

    const handler = handlers.get(SPECIALIST_IPC.SET_SESSION_SPECIALIST)
    expect(handler).toBeDefined()

    await handler?.(undefined, { sessionId: 'session-1', specialistId: profile.id })

    expect(persistSessionSpecialist).toHaveBeenCalledWith('session-1', profile.id)
    expect(binding.getBinding('session-1')).toBe(profile.id)
  })

  it('returns only the renderer-safe template save result from main', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const exportContributionTemplate = vi.fn().mockResolvedValue({ saved: true })

    registerSpecialistIpcHandlers(
      createProfileService(),
      binding,
      vi.fn(),
      undefined,
      undefined,
      exportContributionTemplate
    )

    const result = await handlers.get(SPECIALIST_IPC.EXPORT_CONTRIBUTION_TEMPLATE)?.(
      undefined,
      undefined
    )
    expect(result).toEqual({ saved: true })
  })

  it('keeps archive bytes in main and rejects mutated install requests before the package service', async () => {
    handlers.clear()
    const binding = new SessionBindingService(createProfileService())
    const preview = vi.fn().mockResolvedValue({
      candidateToken: 'candidate-1',
      summary: { id: 'safe-id' },
      diagnostics: [],
      installable: true
    })
    const install = vi.fn()

    registerSpecialistIpcHandlers(
      createProfileService(),
      binding,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      {
        service: { preview, install, cancel: vi.fn(), dispose: vi.fn() },
        selectArchive: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]) })
      }
    )

    const selected = await handlers.get(SPECIALIST_IPC.SELECT_PACKAGE)?.(undefined, undefined)
    expect(selected).toEqual({
      candidateToken: 'candidate-1',
      summary: { id: 'safe-id' },
      diagnostics: [],
      installable: true
    })
    expect(JSON.stringify(selected)).not.toMatch(/bytes|path/i)
    expect(preview).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))

    await expect(
      handlers.get(SPECIALIST_IPC.INSTALL_PACKAGE)?.(undefined, {
        candidateToken: 'candidate-1',
        enabled: false
      })
    ).resolves.toEqual({ status: 'failed', code: 'candidate-invalid' })
    expect(install).not.toHaveBeenCalled()
  })
})
