import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { SpecialistRepository } from '../repository'
import { ProfileService } from '../service'
import { SpecialistPackageService } from './service'

const encoder = new TextEncoder()
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

const validZip = (overrides: { version?: string; description?: string } = {}): Uint8Array =>
  zipSync({
    'manifest.json': encoder.encode(
      JSON.stringify({
        schema_version: 1,
        id: 'research-synth',
        version: overrides.version ?? '1.3.0',
        requires_app: '>=0.9.2 <1.0.0',
        skills: { builtin: [], required: [], bundled: [] }
      })
    ),
    'specialist.json': encoder.encode(
      JSON.stringify({
        name: 'Research Synthesizer',
        description: overrides.description ?? 'Synthesizes research.',
        systemPrompt: 'Private imported instructions.',
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      })
    )
  })

let storageDir: string

beforeEach(async () => {
  storageDir = join(tmpdir(), `specialist-package-${randomUUID()}`)
  await mkdir(storageDir, { recursive: true })
})

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true })
})

describe('SpecialistPackageService', () => {
  it('previews and explicitly confirms an atomic overwrite while preserving local enabled state', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Existing Research Synthesizer',
      description: 'Existing content.',
      systemPrompt: 'Keep existing.',
      enabled: false,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 4,
      packageVersion: '1.2.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    const preview = await service.preview(validZip())
    expect(preview).toMatchObject({
      installable: true,
      overwrite: {
        id: 'research-synth',
        target: 'custom',
        currentVersion: '1.2.0',
        incomingVersion: '1.3.0',
        modifiedSinceImport: false,
        hasImportBaseline: false
      }
    })
    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'overwrite-confirmation-required'
    })
    await expect(
      service.install({ candidateToken: preview.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        id: 'research-synth',
        systemPrompt: 'Private imported instructions.',
        enabled: false,
        revision: 5,
        packageVersion: '1.3.0',
        origin: 'imported'
      }
    })
    await expect(new ProfileService(repository).getById('research-synth')).resolves.toMatchObject({
      systemPrompt: 'Private imported instructions.',
      enabled: false,
      revision: 5,
      importBaseline: {
        importedAt: expect.any(String),
        archiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
  })

  it('derives modified provenance from the live portable profile and reports version risks', async () => {
    const repository = new SpecialistRepository(storageDir)
    const initial = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      now: () => new Date('2026-08-03T09:00:00.000Z')
    })
    const installed = await initial.preview(validZip())
    await initial.install({ candidateToken: installed.candidateToken })

    const unchanged = await initial.preview(validZip())
    expect(unchanged.overwrite).toMatchObject({ modifiedSinceImport: false })
    expect(unchanged.diagnostics.map((item) => item.code)).toContain(
      'specialist.overwrite-same-version'
    )

    await new ProfileService(repository).update({
      id: 'research-synth',
      revision: 1,
      description: 'Locally edited.'
    })
    const modified = await initial.preview(validZip())
    expect(modified.overwrite).toMatchObject({ modifiedSinceImport: true })
    expect(modified.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'specialist.overwrite-local-modifications',
        'specialist.overwrite-same-version'
      ])
    )

    const changedWithoutBump = await initial.preview(
      validZip({ description: 'Changed package content.' })
    )
    expect(changedWithoutBump.diagnostics.map((item) => item.code)).toContain(
      'specialist.overwrite-content-without-version-bump'
    )
    const downgrade = await initial.preview(validZip({ version: '1.2.0' }))
    expect(downgrade.diagnostics.map((item) => item.code)).toContain(
      'specialist.overwrite-downgrade'
    )
  })

  it('rejects overwrite confirmation after revision drift without changing the edited profile', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Existing Research Synthesizer',
      description: 'Existing content.',
      systemPrompt: 'Keep existing.',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 2,
      packageVersion: '1.2.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    const preview = await service.preview(validZip())
    await new ProfileService(repository).update({
      id: 'research-synth',
      revision: 2,
      systemPrompt: 'Concurrent edit must survive.'
    })

    await expect(
      service.install({ candidateToken: preview.candidateToken, confirmOverwrite: true })
    ).resolves.toEqual({ status: 'failed', code: 'revision-conflict' })
    await expect(new ProfileService(repository).getById('research-synth')).resolves.toMatchObject({
      systemPrompt: 'Concurrent edit must survive.',
      revision: 3
    })
  })

  it('installs the exact previewed package once as an enabled editable imported Specialist', async () => {
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      token: () => 'one-time-token',
      now: () => new Date('2026-08-03T10:00:00.000Z')
    })

    const preview = await service.preview(validZip())
    expect(preview).toMatchObject({
      candidateToken: 'one-time-token',
      installable: true,
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        bundledSkillIds: [],
        connectorIds: []
      }
    })

    await expect(
      service.install({ candidateToken: preview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        id: 'research-synth',
        enabled: true,
        packageVersion: '1.3.0',
        origin: 'imported'
      }
    })
    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'stale-candidate'
    })

    const restarted = new ProfileService(new SpecialistRepository(storageDir))
    await expect(restarted.getById('research-synth')).resolves.toMatchObject({
      name: 'Research Synthesizer',
      systemPrompt: 'Private imported instructions.',
      revision: 1
    })
    const edited = await restarted.update({
      id: 'research-synth',
      revision: 1,
      description: 'Edited after import.'
    })
    expect(edited).toMatchObject({
      description: 'Edited after import.',
      origin: 'imported',
      packageVersion: '1.3.0',
      ownedSkillIds: []
    })
    const duplicateDraft = await restarted.duplicate('research-synth')
    const duplicate = await restarted.create(duplicateDraft)
    expect(duplicate).toMatchObject({ origin: 'local', packageVersion: '0.1.0', ownedSkillIds: [] })
  })

  it('cleans candidates on cancel and expiry and serializes concurrent replay attempts', async () => {
    const repository = new SpecialistRepository(storageDir)
    let now = new Date('2026-08-03T10:00:00.000Z')
    let tokenNumber = 0
    const onCommitted = vi.fn()
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      token: () => `candidate-${++tokenNumber}`,
      now: () => now,
      onCommitted
    })

    const cancelled = await service.preview(validZip())
    service.cancel(cancelled.candidateToken)
    await expect(service.install({ candidateToken: cancelled.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'stale-candidate'
    })

    const expired = await service.preview(validZip())
    now = new Date('2026-08-03T11:00:00.000Z')
    await expect(service.install({ candidateToken: expired.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'candidate-expired'
    })

    const live = await service.preview(validZip())
    const results = await Promise.all([
      service.install({ candidateToken: live.candidateToken }),
      service.install({ candidateToken: live.candidateToken })
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['failed', 'installed'])
    expect(results).toContainEqual({ status: 'failed', code: 'stale-candidate' })
    expect(onCommitted).toHaveBeenCalledOnce()
  })

  it('preserves old durable state and blocks later package mutation when recovery cannot complete', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({
      name: 'EXISTING_SPECIALIST',
      systemPrompt: 'Keep me.'
    })
    await mkdir(join(storageDir, 'specialist-package-transaction.json'))
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      token: () => randomUUID()
    })

    const first = await service.preview(validZip())
    await expect(service.install({ candidateToken: first.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'recovery-failed'
    })
    await expect(profiles.getById(existing.id)).resolves.toMatchObject({ systemPrompt: 'Keep me.' })
    await expect(profiles.getById('research-synth')).rejects.toThrow(/not found/i)

    const second = await service.preview(validZip())
    await expect(service.install({ candidateToken: second.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'recovery-failed'
    })
  })

  it('rolls back a failed Specialist document swap without changing the old durable state', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({
      name: 'EXISTING_SPECIALIST',
      systemPrompt: 'Keep me.'
    })
    const replace = vi.spyOn(repository, 'replaceAll')
    replace.mockRejectedValueOnce(new Error('simulated durable write failure'))
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    const preview = await service.preview(validZip())

    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'commit-failed'
    })
    await expect(profiles.getById(existing.id)).resolves.toMatchObject({ systemPrompt: 'Keep me.' })
    await expect(profiles.getById('research-synth')).rejects.toThrow(/not found/i)
  })

  it('distinguishes rollback failure from the commit that triggered it', async () => {
    const repository = new SpecialistRepository(storageDir)
    vi.spyOn(repository, 'replaceAll').mockRejectedValue(new Error('storage unavailable'))
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    const preview = await service.preview(validZip())

    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'rollback-failed'
    })
  })

  it('rolls back an interrupted Specialist transaction on restart before accepting a new mutation', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({ name: 'EXISTING_SPECIALIST' })
    const before = await repository.getAll()
    const partial = {
      ...before.specialists[0],
      id: 'partial-specialist',
      name: 'PARTIAL_SPECIALIST'
    }
    await writeFile(
      join(storageDir, 'specialist-package-transaction.json'),
      JSON.stringify({
        transactionId: 'interrupted-transaction',
        phase: 'committing',
        specialistId: partial.id,
        before,
        after: { ...before, specialists: [...before.specialists, partial] }
      }),
      'utf8'
    )
    await repository.replaceAll({ ...before, specialists: [...before.specialists, partial] })

    const restarted = new SpecialistPackageService({
      storageDir,
      repository: new SpecialistRepository(storageDir),
      catalog: async () => catalog
    })
    const preview = await restarted.preview(validZip())
    await expect(
      restarted.install({ candidateToken: preview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed'
    })

    const recoveredProfiles = new ProfileService(new SpecialistRepository(storageDir))
    await expect(recoveredProfiles.getById(existing.id)).resolves.toBeDefined()
    await expect(recoveredProfiles.getById('partial-specialist')).rejects.toThrow(/not found/i)
    await expect(recoveredProfiles.getById('research-synth')).resolves.toBeDefined()
  })
})
