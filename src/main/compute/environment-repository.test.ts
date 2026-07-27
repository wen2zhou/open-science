import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  ComputeEnvironment,
  EnvironmentResolution,
  EnvironmentSpec
} from '../../shared/compute-environment'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ComputeEnvironmentRepository } from './environment-repository'
import { ComputeHostRepository } from './repository'

const CONDA_READY: EnvironmentResolution = {
  kind: 'conda',
  envName: 'ml',
  activation: 'conda activate ml'
}
const CONDA_CHANGED: EnvironmentResolution = {
  kind: 'conda',
  envName: 'ml2',
  activation: 'conda activate ml2'
}
const SPEC_V1: EnvironmentSpec = {
  runtime: 'conda',
  packages: ['numpy'],
  variables: {},
  weights: [],
  smokeChecks: []
}
const SPEC_V2: EnvironmentSpec = {
  runtime: 'conda',
  packages: ['numpy', 'scipy'],
  variables: {},
  weights: [],
  smokeChecks: []
}

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined
let repo: ComputeEnvironmentRepository

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-env-'))
  const client = createProjectDbClient(storageRoot)
  disconnect = () => client.$disconnect()
  await ensureProjectSchema(client)
  repo = new ComputeEnvironmentRepository(() => Promise.resolve(client))
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('ComputeEnvironmentRepository — additive migration', () => {
  it('creates the table on a pre-existing DB without disturbing existing rows', async () => {
    // Re-open a fresh DB that already has a Project row but no ComputeEnvironment table.
    const root = await mkdtemp(join(tmpdir(), 'open-science-env-migrate-'))
    const client = createProjectDbClient(root)
    try {
      await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Project" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "isExample" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )`)
      await client.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('p1','Survivor',CURRENT_TIMESTAMP)`
      )
      await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
      // Idempotent.
      await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

      const projects = await client.project.findMany()
      expect(projects).toHaveLength(1)
      expect(projects[0]!.name).toBe('Survivor')
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ComputeEnvironmentRepository — CRUD + uniqueness', () => {
  it('creates a registry record and reads it back with spec + resolution parsed', async () => {
    const created = await repo.create({
      providerId: 'ssh:biowulf',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    expect(created.id).toBeDefined()
    expect(created.status).toBe('ready')
    expect(created.spec).toEqual(SPEC_V1)
    expect(created.resolution).toEqual(CONDA_READY)
    expect(created.visibility).toBe('provider')

    const fetched = await repo.get(created.id)
    expect(fetched?.name).toBe('ml')
    expect(fetched?.status).toBe('ready')
    expect(fetched?.resolution?.kind).toBe('conda')
  })

  it('enforces provider-scoped name uniqueness (different providers, same name OK)', async () => {
    await repo.create({ providerId: 'ssh:a', name: 'ml', spec: SPEC_V1, resolution: CONDA_READY })
    // Same name on a DIFFERENT provider is allowed.
    const other = await repo.create({
      providerId: 'ssh:b',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY
    })
    expect(other.providerId).toBe('ssh:b')

    // Same name on the SAME provider is rejected with a readable error.
    await expect(
      repo.create({ providerId: 'ssh:a', name: 'ml', spec: SPEC_V1, resolution: CONDA_READY })
    ).rejects.toThrow(/already registered/i)
  })

  it('lists environments for a provider, newest-first', async () => {
    await repo.create({ providerId: 'ssh:a', name: 'one', spec: SPEC_V1, resolution: CONDA_READY })
    await repo.create({ providerId: 'ssh:a', name: 'two', spec: SPEC_V1, resolution: CONDA_READY })
    await repo.create({ providerId: 'ssh:b', name: 'one', spec: SPEC_V1, resolution: CONDA_READY })

    const list = await repo.listByProvider('ssh:a')
    expect(list.map((e) => e.name)).toEqual(['two', 'one'])
    expect(list.every((e) => e.providerId === 'ssh:a')).toBe(true)
  })

  it('finds a ready environment by (providerId, name) and resolves it', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    const resolved = await repo.findReadyByName('ssh:a', 'ml')
    expect(resolved?.id).toBe(created.id)
    expect(resolved?.status).toBe('ready')

    // Not-ready environments are not resolved.
    await repo.create({
      providerId: 'ssh:a',
      name: 'building',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'building'
    })
    expect(await repo.findReadyByName('ssh:a', 'building')).toBeNull()
  })

  it('updates resolution/spec and recomputes specHash on edit', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    const originalHash = created.specHash
    const updated = await repo.update(created.id, {
      spec: SPEC_V2,
      resolution: CONDA_CHANGED,
      status: 'stale'
    })
    expect(updated.specHash).not.toBe(originalHash)
    expect(updated.status).toBe('stale')
    expect(updated.spec).toEqual(SPEC_V2)
    expect(updated.resolution?.kind).toBe('conda')
    expect(updated.resolution).toEqual(CONDA_CHANGED)
  })

  it('deletes a registry record', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY
    })
    await repo.delete(created.id)
    expect(await repo.get(created.id)).toBeNull()
  })

  it('records validation evidence and a validatedAt timestamp', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY
    })
    const validated = await repo.recordValidation(created.id, {
      specHash: created.specHash,
      command: 'python -c "import numpy"',
      exitCode: 0,
      validatedAt: '2026-07-27T00:00:00.000Z',
      result: 'ready'
    })
    expect(validated.status).toBe('ready')
    expect(validated.validation?.exitCode).toBe(0)
    expect(validated.validatedAt).toBeGreaterThan(0)
  })
})

describe('ComputeEnvironmentRepository — stale transition', () => {
  it('marks a ready environment stale when its spec changes', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    const updated = await repo.update(created.id, { spec: SPEC_V2 })
    expect(updated.status).toBe('stale')
    // A stale env cannot be resolved by name.
    expect(await repo.findReadyByName('ssh:a', 'ml')).toBeNull()
  })

  it('marks a ready environment stale when its resolution changes', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    const updated = await repo.update(created.id, { resolution: CONDA_CHANGED })
    expect(updated.status).toBe('stale')
  })

  it('does NOT auto-stale when an unrelated field (detailsDoc) changes', async () => {
    const created = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    const updated = await repo.update(created.id, { detailsDoc: 'new notes' })
    expect(updated.status).toBe('ready')
  })
})

describe('ComputeEnvironmentRepository — compat with host table', () => {
  it('coexists with ComputeHost rows in the same DB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-env-host-'))
    const client = createProjectDbClient(root)
    try {
      await ensureProjectSchema(client)
      const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
      const envRepo = new ComputeEnvironmentRepository(() => Promise.resolve(client))
      const host = await hostRepo.create({ sshAlias: 'biowulf' })
      const env = await envRepo.create({
        providerId: host.providerId,
        name: 'ml',
        spec: SPEC_V1,
        resolution: CONDA_READY,
        initialStatus: 'ready'
      })
      expect(env.providerId).toBe(host.providerId)
      const list = (await envRepo.listByProvider(host.providerId)) as ComputeEnvironment[]
      expect(list).toHaveLength(1)
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ComputeEnvironmentRepository — reserveForProvisioning (atomic build lock)', () => {
  it('reserves a non-building environment and flips it to building', async () => {
    const env = await repo.create({
      providerId: 'ssh:a',
      name: 'ml',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'draft'
    })
    const won = await repo.reserveForProvisioning(env.id)
    expect(won).toBe(true)
    expect((await repo.get(env.id))?.status).toBe('building')
  })

  it('refuses an environment already building or validating (no state change)', async () => {
    const building = await repo.create({
      providerId: 'ssh:a',
      name: 'b',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'building'
    })
    expect(await repo.reserveForProvisioning(building.id)).toBe(false)
    expect((await repo.get(building.id))?.status).toBe('building')

    const validating = await repo.create({
      providerId: 'ssh:a',
      name: 'v',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'validating'
    })
    expect(await repo.reserveForProvisioning(validating.id)).toBe(false)
    expect((await repo.get(validating.id))?.status).toBe('validating')
  })

  it('can reserve a previously-terminal environment (ready/failed/stale/draft)', async () => {
    for (const status of ['ready', 'failed', 'stale', 'draft'] as const) {
      const env = await repo.create({
        providerId: 'ssh:a',
        name: `e-${status}`,
        spec: SPEC_V1,
        resolution: CONDA_READY,
        initialStatus: status
      })
      expect(await repo.reserveForProvisioning(env.id)).toBe(true)
      expect((await repo.get(env.id))?.status).toBe('building')
    }
  })
})

describe('ComputeEnvironmentRepository — legacy rows failing spec validation', () => {
  it('degrades a stored cachePath with shell metacharacters to an undefined spec', async () => {
    // A row written before cachePath was hardened can hold a shell-active path. Reading it back must
    // stay a structured degrade (spec: undefined) so the UI and the poller keep working, and must
    // never surface the unvalidated value where it could reach a rendered command.
    const created = await repo.create({
      providerId: 'ssh:legacy',
      name: 'ml-legacy',
      spec: SPEC_V1,
      resolution: CONDA_READY,
      initialStatus: 'ready'
    })
    const client = createProjectDbClient(storageRoot!)
    try {
      await client.computeEnvironment.update({
        where: { id: created.id },
        data: { specJson: JSON.stringify({ ...SPEC_V1, cachePath: '/data/$(id)' }) }
      })
    } finally {
      await client.$disconnect()
    }

    const fetched = await repo.get(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.spec).toBeUndefined()
    // The rest of the row still reads back intact, so list views and the poller are unaffected.
    expect(fetched?.name).toBe('ml-legacy')
    expect(fetched?.status).toBe('ready')
    expect(fetched?.resolution?.kind).toBe('conda')

    // Listing the provider must not throw either.
    const listed = await repo.listByProvider('ssh:legacy')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.spec).toBeUndefined()
  })
})
