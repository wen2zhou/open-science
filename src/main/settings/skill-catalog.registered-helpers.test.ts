import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import type { BundledSkill, SkillRegistry } from '../skills/registry'
import type { UserSkillRepository } from '../skills/user-skill-repository'
import { NotebookRuntimeService, type NotebookExecutionRequest } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
import { SettingsRepository } from './repository'
import { SkillCatalogModule } from './skill-catalog'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const skill = async (source: BundledSkill['source'], id: string): Promise<BundledSkill> => {
  const sourceDir = await mkdtemp(join(tmpdir(), `${id}-`))
  roots.push(sourceDir)
  await writeFile(join(sourceDir, 'kernel.py'), `def ${id.replaceAll('-', '_')}():\n    return 1\n`)
  return {
    id,
    name: id,
    displayName: id,
    description: id,
    source,
    updatedAt: '2026-08-26T00:00:00.000Z',
    sourceDir,
    helpers: [
      {
        id: `${id}-helper`,
        language: 'python',
        interfaceRevision: 1,
        implementation: 'kernel.py',
        exports: [id.replaceAll('-', '_')],
        dependencies: []
      }
    ]
  }
}

describe('SkillCatalogModule registered helper projection', () => {
  it('derives Built-in, Personal and Imported helpers from one catalog', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'helper-skill-catalog-'))
    roots.push(storageRoot)
    await mkdir(storageRoot, { recursive: true })
    const builtin = await skill('featured', 'builtin-skill')
    const personal = await skill('personal', 'personal-skill')
    const imported = await skill('imported', 'imported-skill')
    const repository = new SettingsRepository(storageRoot)
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      skillRegistry: { list: async () => [builtin] } as unknown as SkillRegistry,
      userSkills: { list: async () => [personal, imported] } as unknown as UserSkillRepository
    })
    const registry = catalog.registeredHelperCatalog()

    await expect(registry.resolve('builtin-skill-helper')).resolves.toMatchObject({
      skillId: 'builtin-skill',
      origin: 'builtin'
    })
    await expect(registry.resolve('personal-skill-helper')).resolves.toMatchObject({
      skillId: 'personal-skill',
      origin: 'personal'
    })
    await expect(registry.resolve('imported-skill-helper')).resolves.toMatchObject({
      skillId: 'imported-skill',
      origin: 'imported'
    })

    const executions: NotebookExecutionRequest[] = []
    const notebook = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      helperModuleCatalog: registry,
      executorFactory: () => ({
        execute: async (request) => {
          executions.push(request)
          return {
            status: 'completed' as const,
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    for (const helperId of [
      'builtin-skill-helper',
      'personal-skill-helper',
      'imported-skill-helper'
    ]) {
      await notebook.execute({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: storageRoot,
        code: 'result = 1',
        cellId: `cell-${helperId}`,
        helperModules: [helperId]
      })
    }
    expect(executions.map((request) => request.helperModules?.[0]?.origin)).toEqual([
      'builtin',
      'personal',
      'imported'
    ])

    await repository.setSkillEnabled('personal-skill', false)
    await expect(registry.resolve('personal-skill-helper')).rejects.toThrow('not authorized')
    await expect(
      registry.resolve('personal-skill-helper', {
        sessionId: 'specialist-session',
        allowedSkillIds: ['personal-skill']
      })
    ).resolves.toBeDefined()
    await expect(
      registry.resolve('builtin-skill-helper', {
        sessionId: 'specialist-session',
        allowedSkillIds: ['personal-skill']
      })
    ).rejects.toThrow('not authorized')
  })

  it('rolls back a promoted Personal candidate that conflicts with the live helper graph', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'helper-promotion-rollback-'))
    roots.push(storageRoot)
    const repository = new SettingsRepository(storageRoot)
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      skillRegistry: { list: async () => [] } as unknown as SkillRegistry
    })
    const packageRoot = async (name: string, value: string): Promise<string> => {
      const root = await mkdtemp(join(tmpdir(), `helper-promote-${name}-`))
      roots.push(root)
      await writeFile(
        join(root, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`
      )
      await writeFile(
        join(root, 'kernel.py'),
        `def shared_export():\n    return ${JSON.stringify(value)}\n`
      )
      await writeFile(
        join(root, 'open-science.json'),
        JSON.stringify({
          schemaVersion: 1,
          helpers: [
            {
              id: 'shared-helper',
              language: 'python',
              interfaceRevision: 1,
              implementation: 'kernel.py',
              exports: ['shared_export'],
              dependencies: []
            }
          ]
        })
      )
      return root
    }

    await catalog.publishHostSkill('first', await packageRoot('first', 'old'), false)
    const registry = catalog.registeredHelperCatalog()
    const old = await registry.resolve('shared-helper')
    await expect(
      catalog.publishHostSkill('conflict', await packageRoot('conflict', 'new'), false)
    ).rejects.toThrow('duplicate helper ID')

    const invalidReplacement = await packageRoot('first', 'replacement')
    const replacementManifest = JSON.parse(
      await readFile(join(invalidReplacement, 'open-science.json'), 'utf8')
    ) as { helpers: Array<{ dependencies: string[] }> }
    replacementManifest.helpers[0]!.dependencies = ['missing-helper']
    await writeFile(
      join(invalidReplacement, 'open-science.json'),
      JSON.stringify(replacementManifest)
    )
    await expect(catalog.publishHostSkill('first', invalidReplacement, true)).rejects.toThrow(
      'unknown dependency'
    )

    expect((await catalog.listSkills()).map((entry) => entry.id)).toEqual(['personal-first'])
    await expect(registry.resolve('shared-helper')).resolves.toMatchObject({
      generation: old?.generation,
      source: expect.stringContaining('"old"')
    })
  })
})
