import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createComputeHandlers } from './ipc'
import { ComputeEnvironmentRepository } from './environment-repository'
import type { ComputeEnvironmentRepository as IRepo } from './environment-repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined
let envRepo: IRepo

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-env-ipc-'))
  const client = createProjectDbClient(storageRoot)
  disconnect = () => client.$disconnect()
  await ensureProjectSchema(client)
  envRepo = new ComputeEnvironmentRepository(() => Promise.resolve(client as PrismaClient))
})

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const CONDA = { kind: 'conda' as const, envName: 'ml', activation: 'conda activate ml' }
const SPEC = { runtime: 'conda' as const, packages: ['numpy'] }

describe('compute handlers — environment registry (IPC boundary)', () => {
  it('creates + lists an environment through the handler, validating spec/resolution', async () => {
    const handlers = createComputeHandlers(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const created = await handlers.environmentCreate('ssh:biowulf', {
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    // A freshly registered environment is always draft — ready can only come from provisioning
    // validation (environmentRecordValidation), never from the create call.
    expect(created.status).toBe('draft')
    expect(created.resolution?.kind).toBe('conda')

    const list = await handlers.environmentsList('ssh:biowulf')
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('ml')
  })

  it('rejects an invalid resolution at the IPC boundary before touching the DB', async () => {
    const handlers = createComputeHandlers(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    await expect(
      handlers.environmentCreate('ssh:biowulf', {
        name: 'bad',
        spec: SPEC,
        // conda without activation is invalid.
        resolution: { kind: 'conda', envName: 'ml' }
      })
    ).rejects.toThrow(/activation/i)
    expect(await handlers.environmentsList('ssh:biowulf')).toHaveLength(0)
  })

  it("rejects initialStatus='ready' — ready must come from provisioning, not registration", async () => {
    const handlers = createComputeHandlers(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    await expect(
      handlers.environmentCreate('ssh:biowulf', {
        name: 'ml',
        spec: SPEC,
        resolution: CONDA,
        initialStatus: 'ready'
      })
    ).rejects.toThrow(/ready.*provisioning|provisioning/i)
    // The guard fires before any DB write, so no row is persisted.
    expect(await handlers.environmentsList('ssh:biowulf')).toHaveLength(0)
  })

  it('auto-stales a ready environment when its spec changes through the update handler', async () => {
    const handlers = createComputeHandlers(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    // ready is established through validation evidence, not the create call.
    const created = await handlers.environmentCreate('ssh:biowulf', {
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    await handlers.environmentRecordValidation(created.id, {
      specHash: created.specHash,
      command: 'python -c "import numpy"',
      exitCode: 0,
      validatedAt: '2026-07-27T00:00:00.000Z',
      result: 'ready'
    })
    const updated = await handlers.environmentUpdate(created.id, {
      spec: { runtime: 'conda', packages: ['numpy', 'scipy'] }
    })
    expect(updated.status).toBe('stale')
  })

  it('records validation evidence and flips status to ready', async () => {
    const handlers = createComputeHandlers(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const created = await handlers.environmentCreate('ssh:biowulf', {
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    await handlers.environmentRecordValidation(created.id, {
      specHash: created.specHash,
      command: 'python -c "import numpy"',
      exitCode: 0,
      validatedAt: '2026-07-27T00:00:00.000Z',
      result: 'ready'
    })
    const list = await handlers.environmentsList('ssh:biowulf')
    expect(list[0]!.status).toBe('ready')
    expect(list[0]!.validation?.exitCode).toBe(0)
  })

  it('deletes an environment through the handler', async () => {
    const handlers = createComputeHandlers(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envRepo
    )
    const created = await handlers.environmentCreate('ssh:biowulf', {
      name: 'ml',
      spec: SPEC,
      resolution: CONDA
    })
    await handlers.environmentDelete(created.id)
    expect(await handlers.environmentsList('ssh:biowulf')).toHaveLength(0)
  })
})
