import { ipcMain } from 'electron'

import type {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DeleteSpecialistRequest,
  DuplicateSpecialistRequest,
  CreateSpecialistInput,
  SpecialistListItem,
  SpecialistProfileView,
  SetSessionSpecialistRequest,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution
} from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { ProfileService } from './service'
import { SessionBindingService } from './session-binding'
import { createLogger } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'

const log = createLogger('specialist:ipc')

// Broadcasts a catalog-changed event to all renderer windows.
const broadcastCatalogChanged = (): void => {
  broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
}

// Registers all specialist IPC handlers against ipcMain.
// Call once per app lifecycle, after the ProfileService is ready.
export const registerSpecialistIpcHandlers = (
  service: ProfileService,
  sessionBindingService?: SessionBindingService
): void => {
  // Subscribe once so every mutation (create, setEnabled) triggers a broadcast.
  service.subscribe(broadcastCatalogChanged)

  ipcMain.handle(SPECIALIST_IPC.LIST, async (): Promise<SpecialistListItem[]> => {
    try {
      return await service.listForSettings()
    } catch (error) {
      log.error('specialist:list failed', { error })
      throw error
    }
  })

  ipcMain.handle(
    SPECIALIST_IPC.CREATE,
    async (_event, request: CreateSpecialistRequest): Promise<SpecialistProfileView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        return await service.create(request)
      } catch (error) {
        log.error('specialist:create failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.UPDATE,
    async (_event, request: UpdateSpecialistRequest): Promise<SpecialistProfileView> => {
      // Re-validate in main process — renderer input is untrusted.
      try {
        return await service.update(request)
      } catch (error) {
        log.error('specialist:update failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.SET_ENABLED,
    async (_event, request: SetSpecialistEnabledRequest): Promise<SpecialistProfileView> => {
      try {
        return await service.setEnabled(request.id, request.enabled)
      } catch (error) {
        log.error('specialist:set-enabled failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.DELETE,
    async (_event, request: DeleteSpecialistRequest): Promise<void> => {
      try {
        await service.delete(request.id, request.expectedRevision)
      } catch (error) {
        log.error('specialist:delete failed', { error })
        throw error
      }
    }
  )

  ipcMain.handle(
    SPECIALIST_IPC.DUPLICATE,
    async (_event, request: DuplicateSpecialistRequest): Promise<CreateSpecialistInput> =>
      service.duplicate(request.id)
  )

  // Session switching — only registered when a SessionBindingService is provided.
  // This handler is a named seam: the future host.agents.switch() SDK (issue 08)
  // will resolve name→UUID and call this same channel, not a parallel path.
  if (sessionBindingService) {
    ipcMain.handle(
      SPECIALIST_IPC.SET_SESSION_SPECIALIST,
      async (_event, request: SetSessionSpecialistRequest): Promise<void> => {
        if (!request || typeof request.sessionId !== 'string') {
          throw new Error('SET_SESSION_SPECIALIST: sessionId must be a string.')
        }
        if (request.specialistId !== undefined && typeof request.specialistId !== 'string') {
          throw new Error('SET_SESSION_SPECIALIST: specialistId must be a string or undefined.')
        }
        // Validate the UUID exists and is enabled before accepting it.
        if (request.specialistId !== undefined) {
          const resolution = await sessionBindingService.resolve(
            request.sessionId,
            request.specialistId
          )
          if (resolution.kind === 'unavailable') {
            // Surface the reason so the renderer can show a meaningful message.
            throw new Error(resolution.reason)
          }
        }
        sessionBindingService.setBinding(request.sessionId, request.specialistId)
      }
    )

    ipcMain.handle(
      SPECIALIST_IPC.RESOLVE_SESSION_SPECIALIST,
      async (
        _event,
        request: ResolveSessionSpecialistRequest
      ): Promise<SessionSpecialistResolution> => {
        if (!request || typeof request.sessionId !== 'string') {
          throw new Error('RESOLVE_SESSION_SPECIALIST: sessionId must be a string.')
        }
        return sessionBindingService.resolve(request.sessionId)
      }
    )
  }
}
