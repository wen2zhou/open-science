import { ipcMain } from 'electron'

import type {
  CreateSpecialistRequest,
  SetSpecialistEnabledRequest,
  SpecialistListItem,
  SpecialistProfileView
} from '../../shared/specialist'
import { SPECIALIST_IPC } from '../../shared/specialist'
import { ProfileService } from './service'
import { createLogger } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'

const log = createLogger('specialist:ipc')

// Broadcasts a catalog-changed event to all renderer windows.
const broadcastCatalogChanged = (): void => {
  broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
}

// Registers all specialist IPC handlers against ipcMain.
// Call once per app lifecycle, after the ProfileService is ready.
export const registerSpecialistIpcHandlers = (service: ProfileService): void => {
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
}
