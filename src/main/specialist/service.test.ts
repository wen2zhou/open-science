import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { ProfileService } from './service'
import { SpecialistRepository } from './repository'

let tmpDir: string
let service: ProfileService

beforeEach(async () => {
  tmpDir = join(tmpdir(), `profile-service-${randomUUID()}`)
  await mkdir(tmpDir, { recursive: true })
  service = new ProfileService(new SpecialistRepository(tmpDir))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('ProfileService.list', () => {
  it('returns empty array on fresh store', async () => {
    expect(await service.list()).toHaveLength(0)
  })

  it('does not include Reviewer', async () => {
    const result = await service.list()
    expect(result.every((r) => r.id !== 'reviewer')).toBe(true)
  })
})

describe('ProfileService.create', () => {
  it('creates a specialist with immutable UUID', async () => {
    const view = await service.create({ displayName: 'RNA-seq Reviewer' })
    expect(view.id).toBeTruthy()
    expect(typeof view.id).toBe('string')
  })

  it('derives UPPER_SNAKE name from displayName', async () => {
    const view = await service.create({ displayName: 'RNA-seq Reviewer' })
    expect(view.name).toBe('RNA_SEQ_REVIEWER')
  })

  it('allows explicit name override', async () => {
    const view = await service.create({ displayName: 'My Bot', name: 'CUSTOM_NAME' })
    expect(view.name).toBe('CUSTOM_NAME')
  })

  it('defaults to Full access mode', async () => {
    const view = await service.create({ displayName: 'My Bot' })
    expect(view.capabilityMode).toBe('full')
  })

  it('initialises both empty capability configs', async () => {
    const view = await service.create({ displayName: 'My Bot' })
    expect(view.fullAccess.excludedSkillIds).toEqual([])
    expect(view.fullAccess.excludedConnectorIds).toEqual([])
    expect(view.selectedCapabilities.skillIds).toEqual([])
  })

  it('sets enabled=true by default', async () => {
    const view = await service.create({ displayName: 'My Bot' })
    expect(view.enabled).toBe(true)
  })

  it('rejects empty displayName', async () => {
    await expect(service.create({ displayName: '' })).rejects.toThrow()
  })

  it('rejects duplicate name', async () => {
    await service.create({ displayName: 'My Bot' })
    await expect(service.create({ displayName: 'My Bot' })).rejects.toThrow()
  })

  it('rejects reserved name REVIEWER', async () => {
    await expect(service.create({ displayName: 'Reviewer' })).rejects.toThrow()
  })

  it('rejects an unsupported capability mode before persisting the profile', async () => {
    await expect(
      service.create({ displayName: 'My Bot', capabilityMode: 'unrestricted' } as never)
    ).rejects.toThrow(/capability mode/i)

    expect(await service.list()).toEqual([])
  })

  it('rejects non-string optional identity fields before persisting the profile', async () => {
    await expect(
      service.create({ displayName: 'My Bot', description: 42 } as never)
    ).rejects.toThrow(/description must be a string/i)

    expect(await service.list()).toEqual([])
  })

  it('specialist is visible in list after creation', async () => {
    await service.create({ displayName: 'RNA-seq Reviewer' })
    const list = await service.list()
    expect(list).toHaveLength(1)
    expect(list[0].displayName).toBe('RNA-seq Reviewer')
  })
})

describe('ProfileService.getById', () => {
  it('returns the specialist by id', async () => {
    const created = await service.create({ displayName: 'RNA-seq Reviewer' })
    const found = await service.getById(created.id)
    expect(found.id).toBe(created.id)
  })

  it('throws for unknown id', async () => {
    await expect(service.getById('no-such-id')).rejects.toThrow()
  })
})

describe('ProfileService.getByName', () => {
  it('returns specialist by UPPER_SNAKE name', async () => {
    const created = await service.create({ displayName: 'RNA-seq Reviewer' })
    const found = await service.getByName(created.name)
    expect(found.id).toBe(created.id)
  })

  it('throws for unknown name', async () => {
    await expect(service.getByName('NO_SUCH_NAME')).rejects.toThrow()
  })
})

describe('ProfileService.setEnabled', () => {
  it('toggles enabled state', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    const disabled = await service.setEnabled(created.id, false)
    expect(disabled.enabled).toBe(false)

    const re = await service.setEnabled(created.id, true)
    expect(re.enabled).toBe(true)
  })

  it('throws for unknown id', async () => {
    await expect(service.setEnabled('no-such-id', false)).rejects.toThrow()
  })
})

describe('ProfileService.update', () => {
  it('updates identity fields and bumps revision', async () => {
    const created = await service.create({ displayName: 'RNA-seq Reviewer' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      displayName: 'RNA-seq Auditor',
      description: 'Updated description.',
      systemPrompt: 'Be rigorous.'
    })
    expect(updated.id).toBe(created.id)
    expect(updated.displayName).toBe('RNA-seq Auditor')
    expect(updated.description).toBe('Updated description.')
    expect(updated.systemPrompt).toBe('Be rigorous.')
    expect(updated.revision).toBe(created.revision + 1)
  })

  it('persists changes and leaves unmentioned fields intact', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    await service.update({
      id: created.id,
      revision: created.revision,
      displayName: 'Renamed Bot'
    })
    const found = await service.getById(created.id)
    expect(found.displayName).toBe('Renamed Bot')
    // name not provided → unchanged
    expect(found.name).toBe('MY_BOT')
  })

  it('keeps the immutable id and supports renaming', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      name: 'CUSTOM_RENAMED'
    })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('CUSTOM_RENAMED')
  })

  it('allows keeping the same public name (self excluded from uniqueness)', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      name: created.name
    })
    expect(updated.name).toBe(created.name)
  })

  it('rejects a name that collides with another specialist', async () => {
    const first = await service.create({ displayName: 'Alpha Bot' })
    const second = await service.create({ displayName: 'Beta Bot' })
    await expect(
      service.update({ id: second.id, revision: second.revision, name: first.name })
    ).rejects.toThrow(/already in use/i)

    expect(await service.list()).toHaveLength(2)
  })

  it('rejects a stale revision (optimistic concurrency conflict)', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    await expect(
      service.update({ id: created.id, revision: created.revision + 1, displayName: 'X' })
    ).rejects.toThrow(/revision conflict/i)
  })

  it('notifies listeners after a successful update', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.update({ id: created.id, revision: created.revision, description: 'new' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rejects an update missing revision', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    await expect(
      service.update({ id: created.id } as never)
    ).rejects.toThrow(/id and revision/i)
  })
})

describe('ProfileService.listForSettings', () => {
  it('includes custom specialists', async () => {
    await service.create({ displayName: 'My Bot' })
    const items = await service.listForSettings()
    expect(items.some((i) => i.kind === 'custom')).toBe(true)
  })

  it('always includes built-in Reviewer placeholder', async () => {
    const items = await service.listForSettings()
    const reviewer = items.find((i) => i.kind === 'reviewer')
    expect(reviewer).toBeDefined()
  })

  it('Reviewer id is "reviewer"', async () => {
    const items = await service.listForSettings()
    const reviewer = items.find((i) => i.kind === 'reviewer')
    expect(reviewer?.id).toBe('reviewer')
  })
})

describe('ProfileService.subscribe', () => {
  it('notifies listener after create', async () => {
    const listener = vi.fn()
    service.subscribe(listener)
    await service.create({ displayName: 'My Bot' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('notifies listener after setEnabled', async () => {
    const created = await service.create({ displayName: 'My Bot' })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.setEnabled(created.id, false)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('unsubscribe stops notifications', async () => {
    const listener = vi.fn()
    const unsub = service.subscribe(listener)
    unsub()
    await service.create({ displayName: 'My Bot' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('Main Agent and None are not modelled as profiles', () => {
  it('list never returns a profile named MAIN', async () => {
    const list = await service.list()
    expect(list.every((r) => r.name !== 'MAIN')).toBe(true)
  })

  it('list never returns a profile named NONE', async () => {
    const list = await service.list()
    expect(list.every((r) => r.name !== 'NONE')).toBe(true)
  })

  it('cannot create a specialist named MAIN', async () => {
    await expect(service.create({ displayName: 'Main', name: 'MAIN' })).rejects.toThrow()
  })

  it('cannot create a specialist named NONE', async () => {
    await expect(service.create({ displayName: 'None', name: 'NONE' })).rejects.toThrow()
  })
})
