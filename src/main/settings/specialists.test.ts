import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SettingsRepository, sanitizeSettings } from './repository'
import { validateSpecialistDraft } from '../../shared/specialist-validation'

let storageRoot: string | undefined

const createRepository = async (): Promise<SettingsRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-specialists-'))
  return new SettingsRepository(storageRoot)
}

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('specialist settings lifecycle', () => {
  it('creates a revisioned specialist without losing a concurrent settings mutation', async () => {
    const repository = await createRepository()

    const [created] = await Promise.all([
      repository.createSpecialist({
        agentId: 'rna-reviewer',
        name: 'RNA reviewer',
        connectorIds: ['pubmed'],
        skillIds: []
      }),
      repository.setNotificationsEnabled(false)
    ])

    expect(created).toMatchObject({
      agentId: 'rna-reviewer',
      enabled: true,
      revision: 1,
      skillIds: [],
      connectorIds: ['pubmed']
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)

    await expect(repository.getSettings()).resolves.toMatchObject({
      notificationsEnabled: false,
      specialists: [expect.objectContaining({ id: created.id })]
    })
  })

  it('drops only malformed stored specialists while preserving compatible settings', () => {
    const settings = sanitizeSettings({
      notificationsEnabled: false,
      specialists: [
        { id: 'bad', agentId: 'Bad ID', name: 'Broken', enabled: true, revision: 1 },
        {
          id: 'good',
          agentId: 'good-id',
          name: 'Good',
          enabled: true,
          revision: 2,
          skillIds: ['a', 'a'],
          connectorIds: ['c']
        }
      ],
      disabledBuiltinSpecialistIds: ['customize', 'reviewer']
    })

    expect(settings.notificationsEnabled).toBe(false)
    expect(settings.specialists).toEqual([expect.objectContaining({ id: 'good', skillIds: ['a'] })])
    expect(settings.disabledBuiltinSpecialistIds).toEqual(['customize'])
  })

  it('rejects a stale revision instead of overwriting a newer specialist', async () => {
    const repository = await createRepository()
    const created = await repository.createSpecialist({
      agentId: 'reviewer',
      name: 'Reviewer',
      skillIds: [],
      connectorIds: []
    })
    const updated = { ...created, name: 'Newer name', revision: 2 }
    await repository.replaceSpecialist(created.id, 1, updated)

    await expect(
      repository.replaceSpecialist(created.id, 1, { ...updated, name: 'Stale', revision: 3 })
    ).rejects.toThrow(/reload or duplicate/i)
    await expect(repository.getSettings()).resolves.toMatchObject({
      specialists: [expect.objectContaining({ name: 'Newer name', revision: 2 })]
    })
  })

  it('validates identity and refuses newly introduced unknown capabilities', () => {
    expect(() =>
      validateSpecialistDraft(
        { agentId: 'Not Valid', name: 'Name' },
        { agentIds: [], skillIds: [], connectorIds: [] }
      )
    ).toThrow(/agent id/i)
    expect(() =>
      validateSpecialistDraft(
        { agentId: 'valid-id', name: 'Name', skillIds: ['missing'] },
        { agentIds: [], skillIds: [], connectorIds: [] }
      )
    ).toThrow(/unknown skill/i)
    expect(
      validateSpecialistDraft(
        { agentId: 'valid-id', name: 'Name', skillIds: ['a', 'a'], connectorIds: ['b', 'b'] },
        { agentIds: [], skillIds: ['a'], connectorIds: ['b'] }
      )
    ).toMatchObject({ skillIds: ['a'], connectorIds: ['b'] })
  })
})
