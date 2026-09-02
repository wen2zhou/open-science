import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ensurePrismaClientSnapshot,
  fingerprintGeneratedPrismaClient,
  prismaClientRuntimeAlias
} from './prisma-client-isolation'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  )
})

describe('Vitest Prisma Client isolation', () => {
  it('copies the generated runtime and native engine into a worktree-local immutable snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prisma-client-isolation-'))
    fixtures.push(root)
    const generated = join(root, 'node_modules', '.prisma', 'client')
    await mkdir(join(root, 'prisma'), { recursive: true })
    await mkdir(generated, { recursive: true })
    const schema = 'model Example { id String @id }\n'
    await writeFile(join(root, 'prisma', 'schema.prisma'), schema)
    await writeFile(join(generated, 'schema.prisma'), schema)
    await writeFile(join(generated, 'index.js'), 'exports.version = "first"\n')
    await writeFile(join(generated, 'libquery_engine-test.node'), 'native-engine')

    const snapshot = await ensurePrismaClientSnapshot(root)
    await writeFile(join(generated, 'index.js'), 'exports.version = "overwritten"\n')

    await expect(readFile(join(snapshot, 'index.js'), 'utf8')).resolves.toContain('first')
    await expect(readFile(join(snapshot, 'libquery_engine-test.node'), 'utf8')).resolves.toBe(
      'native-engine'
    )
  })

  it('aliases only the generated @prisma/client entry point', () => {
    const alias = prismaClientRuntimeAlias()
    expect(alias.find.test('@prisma/client')).toBe(true)
    expect(alias.find.test('@prisma/client/runtime/library.js')).toBe(false)
    expect(alias.replacement).toContain('.vitest/prisma-client-')
  })

  it('fingerprints generated runtime and native-engine content, not only schema', async () => {
    const first = mkdtempSync(join(tmpdir(), 'prisma-client-fingerprint-a-'))
    const second = mkdtempSync(join(tmpdir(), 'prisma-client-fingerprint-b-'))
    fixtures.push(first, second)
    for (const root of [first, second]) {
      await writeFile(join(root, 'schema.prisma'), 'model Example { id String @id }\n')
      await writeFile(join(root, 'index.js'), 'exports.version = "first"\n')
      await writeFile(join(root, 'libquery_engine-test.node'), 'native-engine')
    }

    expect(await fingerprintGeneratedPrismaClient(first)).toBe(
      await fingerprintGeneratedPrismaClient(second)
    )
    await writeFile(join(second, 'index.js'), 'exports.version = "second"\n')
    expect(await fingerprintGeneratedPrismaClient(first)).not.toBe(
      await fingerprintGeneratedPrismaClient(second)
    )
    await writeFile(join(second, 'index.js'), 'exports.version = "first"\n')
    await writeFile(join(second, 'libquery_engine-test.node'), 'different-engine')
    expect(await fingerprintGeneratedPrismaClient(first)).not.toBe(
      await fingerprintGeneratedPrismaClient(second)
    )
  })
})
