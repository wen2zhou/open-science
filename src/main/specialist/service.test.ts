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
    const view = await service.create({ name: 'RNA-seq Reviewer' })
    expect(view.id).toBeTruthy()
    expect(typeof view.id).toBe('string')
  })

  it('stores the provided name verbatim', async () => {
    const view = await service.create({ name: 'RNA-seq Reviewer' })
    expect(view.name).toBe('RNA-seq Reviewer')
  })

  it('defaults to Full access mode', async () => {
    const view = await service.create({ name: 'My Bot' })
    expect(view.capabilityMode).toBe('full')
  })

  it('initialises both empty capability configs', async () => {
    const view = await service.create({ name: 'My Bot' })
    expect(view.fullAccess.excludedSkillIds).toEqual([])
    expect(view.fullAccess.excludedConnectorIds).toEqual([])
    expect(view.selectedCapabilities.skillIds).toEqual([])
  })

  it('persists connector settings supplied by the editor when creating a specialist', async () => {
    const view = await service.create({
      name: 'Connector Bot',
      capabilityMode: 'selected',
      fullAccess: {
        excludedSkillIds: [],
        excludedConnectorIds: ['pubmed'],
        connectorTools: []
      },
      selectedCapabilities: {
        skillIds: [],
        connectorIds: ['chemistry'],
        connectorTools: []
      }
    })
    expect(view.capabilityMode).toBe('selected')
    expect(view.fullAccess.excludedConnectorIds).toEqual(['pubmed'])
    expect(view.selectedCapabilities.connectorIds).toEqual(['chemistry'])
  })

  it('sets enabled=true by default', async () => {
    const view = await service.create({ name: 'My Bot' })
    expect(view.enabled).toBe(true)
  })

  it('rejects empty name', async () => {
    await expect(service.create({ name: '' })).rejects.toThrow()
  })

  it('rejects duplicate name', async () => {
    await service.create({ name: 'My Bot' })
    await expect(service.create({ name: 'My Bot' })).rejects.toThrow()
  })

  it('rejects an unsupported capability mode before persisting the profile', async () => {
    await expect(
      service.create({ name: 'My Bot', capabilityMode: 'unrestricted' } as never)
    ).rejects.toThrow(/capability mode/i)

    expect(await service.list()).toEqual([])
  })

  it('rejects non-string optional identity fields before persisting the profile', async () => {
    await expect(service.create({ name: 'My Bot', description: 42 } as never)).rejects.toThrow(
      /description must be a string/i
    )

    expect(await service.list()).toEqual([])
  })

  it('specialist is visible in list after creation', async () => {
    await service.create({ name: 'RNA-seq Reviewer' })
    const list = await service.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('RNA-seq Reviewer')
  })
})

describe('ProfileService.getById', () => {
  it('returns the specialist by id', async () => {
    const created = await service.create({ name: 'RNA-seq Reviewer' })
    const found = await service.getById(created.id)
    expect(found.id).toBe(created.id)
  })

  it('throws for unknown id', async () => {
    await expect(service.getById('no-such-id')).rejects.toThrow()
  })
})

describe('ProfileService.getByName', () => {
  it('returns specialist by name', async () => {
    const created = await service.create({ name: 'RNA-seq Reviewer' })
    const found = await service.getByName(created.name)
    expect(found.id).toBe(created.id)
  })

  it('throws for unknown name', async () => {
    await expect(service.getByName('No Such Name')).rejects.toThrow()
  })
})

describe('ProfileService.setEnabled', () => {
  it('toggles enabled state', async () => {
    const created = await service.create({ name: 'My Bot' })
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
    const created = await service.create({ name: 'RNA-seq Reviewer' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      name: 'RNA-seq Auditor',
      description: 'Updated description.',
      systemPrompt: 'Be rigorous.'
    })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('RNA-seq Auditor')
    expect(updated.description).toBe('Updated description.')
    expect(updated.systemPrompt).toBe('Be rigorous.')
    expect(updated.revision).toBe(created.revision + 1)
  })

  it('persists changes and leaves unmentioned fields intact', async () => {
    const created = await service.create({ name: 'My Bot' })
    await service.update({
      id: created.id,
      revision: created.revision,
      description: 'New description.'
    })
    const found = await service.getById(created.id)
    // name not provided → unchanged
    expect(found.name).toBe('My Bot')
    expect(found.description).toBe('New description.')
  })

  it('persists connector exclusions and inclusions independently across mode switches', async () => {
    const created = await service.create({ name: 'Connector Bot' })
    const full = await service.update({
      id: created.id,
      revision: created.revision,
      fullAccess: {
        excludedSkillIds: ['skill-a'],
        excludedConnectorIds: ['pubmed'],
        connectorTools: []
      }
    })
    const selected = await service.update({
      id: created.id,
      revision: full.revision,
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['skill-b'],
        connectorIds: ['chemistry'],
        connectorTools: []
      }
    })

    expect(selected.capabilityMode).toBe('selected')
    expect(selected.fullAccess.excludedConnectorIds).toEqual(['pubmed'])
    expect(selected.selectedCapabilities.connectorIds).toEqual(['chemistry'])

    const switchedBack = await service.update({
      id: created.id,
      revision: selected.revision,
      capabilityMode: 'full'
    })
    expect(switchedBack.fullAccess.excludedConnectorIds).toEqual(['pubmed'])
    expect(switchedBack.selectedCapabilities.connectorIds).toEqual(['chemistry'])
  })

  it('rejects malformed capability patches before persistence', async () => {
    const created = await service.create({ name: 'Connector Bot' })
    await expect(
      service.update({
        id: created.id,
        revision: created.revision,
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [42], connectorTools: [] }
      } as never)
    ).rejects.toThrow(/capability configuration/i)
    expect((await service.getById(created.id)).revision).toBe(created.revision)
  })

  it('keeps the immutable id and supports renaming', async () => {
    const created = await service.create({ name: 'My Bot' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      name: 'Custom Renamed'
    })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('Custom Renamed')
  })

  it('allows keeping the same name (self excluded from uniqueness)', async () => {
    const created = await service.create({ name: 'My Bot' })
    const updated = await service.update({
      id: created.id,
      revision: created.revision,
      name: created.name
    })
    expect(updated.name).toBe(created.name)
  })

  it('rejects a name that collides with another specialist', async () => {
    const first = await service.create({ name: 'Alpha Bot' })
    const second = await service.create({ name: 'Beta Bot' })
    await expect(
      service.update({ id: second.id, revision: second.revision, name: first.name })
    ).rejects.toThrow(/already in use/i)

    expect(await service.list()).toHaveLength(2)
  })

  it('rejects a stale revision (optimistic concurrency conflict)', async () => {
    const created = await service.create({ name: 'My Bot' })
    await expect(
      service.update({ id: created.id, revision: created.revision + 1, name: 'X' })
    ).rejects.toThrow(/revision conflict/i)
  })

  it('notifies listeners after a successful update', async () => {
    const created = await service.create({ name: 'My Bot' })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.update({ id: created.id, revision: created.revision, description: 'new' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rejects an update missing revision', async () => {
    const created = await service.create({ name: 'My Bot' })
    await expect(service.update({ id: created.id } as never)).rejects.toThrow(/id and revision/i)
  })
})

describe('ProfileService.listForSettings', () => {
  it('includes custom specialists', async () => {
    await service.create({ name: 'My Bot' })
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
    await service.create({ name: 'My Bot' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('notifies listener after setEnabled', async () => {
    const created = await service.create({ name: 'My Bot' })
    const listener = vi.fn()
    service.subscribe(listener)
    await service.setEnabled(created.id, false)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('unsubscribe stops notifications', async () => {
    const listener = vi.fn()
    const unsub = service.subscribe(listener)
    unsub()
    await service.create({ name: 'My Bot' })
    expect(listener).not.toHaveBeenCalled()
  })
})
