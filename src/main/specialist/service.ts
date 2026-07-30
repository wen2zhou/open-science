import { randomUUID } from 'node:crypto'

import { createLogger } from '../logger'
import { SpecialistRepository } from './repository'
import type { StoredSpecialist } from './types'
import type {
  SpecialistProfileView,
  SpecialistListItem,
  CreateSpecialistInput
} from '../../shared/specialist'
import {
  deriveSpecialistName,
  validateCreateSpecialistInput,
  emptyFullAccessConfig,
  emptySelectedConfig
} from '../../shared/specialist'

const log = createLogger('specialist.service')

// ---------------------------------------------------------------------------
// View projection
// ---------------------------------------------------------------------------

const toView = (s: StoredSpecialist): SpecialistProfileView => ({
  id: s.id,
  name: s.name,
  displayName: s.displayName,
  description: s.description,
  systemPrompt: s.systemPrompt,
  iconKey: s.iconKey,
  colorKey: s.colorKey,
  enabled: s.enabled,
  capabilityMode: s.capabilityMode,
  fullAccess: s.fullAccess,
  selectedCapabilities: s.selectedCapabilities,
  revision: s.revision
})

// ---------------------------------------------------------------------------
// ProfileService
// ---------------------------------------------------------------------------

// The single domain service for Specialist Profiles.
// Settings, IPC handlers, and future SDK callers must use this — never bypass
// it to write directly to the repository.
export class ProfileService {
  private readonly listeners: Set<() => void> = new Set()

  constructor(private readonly repo: SpecialistRepository) {}

  // Returns all custom specialists as views (no Reviewer, no Main Agent, no None).
  async list(): Promise<SpecialistProfileView[]> {
    const doc = await this.repo.getAll()
    return doc.specialists.map(toView)
  }

  // Returns the full list for the Settings UI, including the built-in Reviewer placeholder.
  async listForSettings(): Promise<SpecialistListItem[]> {
    const custom = await this.list()
    const items: SpecialistListItem[] = custom.map((v) => ({ kind: 'custom' as const, ...v }))
    items.push({ kind: 'reviewer', id: 'reviewer' })
    return items
  }

  async getById(id: string): Promise<SpecialistProfileView> {
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.id === id)
    if (!found) throw new Error(`Specialist ${id} not found.`)
    return toView(found)
  }

  async getByName(name: string): Promise<SpecialistProfileView> {
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.name === name)
    if (!found) throw new Error(`Specialist "${name}" not found.`)
    return toView(found)
  }

  async create(input: CreateSpecialistInput): Promise<SpecialistProfileView> {
    const doc = await this.repo.getAll()
    const existingNames = doc.specialists.map((s) => s.name)
    const existingIds = new Map(doc.specialists.map((s) => [s.name, s.id]))

    const errors = validateCreateSpecialistInput(input, existingNames, existingIds)
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join('; '))
    }

    const name = input.name ?? deriveSpecialistName(input.displayName)

    const stored: StoredSpecialist = {
      id: randomUUID(),
      name,
      displayName: input.displayName,
      description: input.description ?? '',
      systemPrompt: input.systemPrompt ?? '',
      iconKey: input.iconKey,
      colorKey: input.colorKey,
      enabled: true,
      capabilityMode: input.capabilityMode ?? 'full',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: emptySelectedConfig(),
      revision: 1
    }

    // systemPrompt is user content, not a secret — no logging concern here.
    // Do NOT log systemPrompt content per cross-cutting requirement.
    log.info('creating specialist', { id: stored.id, name: stored.name })

    await this.repo.insert(stored)
    this.notify()
    return toView(stored)
  }

  async setEnabled(id: string, enabled: boolean): Promise<SpecialistProfileView> {
    await this.repo.setEnabled(id, enabled)
    this.notify()
    const doc = await this.repo.getAll()
    const found = doc.specialists.find((s) => s.id === id)
    if (!found) throw new Error(`Specialist ${id} not found after setEnabled.`)
    return toView(found)
  }

  // Subscribes a listener to be called whenever the profile catalog changes.
  // Returns an unsubscribe function.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        log.error('specialist catalog listener threw', { error })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createProfileService = (storageDir: string): ProfileService => {
  return new ProfileService(new SpecialistRepository(storageDir))
}
