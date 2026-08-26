import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import type { RegisteredSkillPackage } from '../skills/registered-helper-catalog'
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
  it('derives Built-in, Personal, Imported and canonical Connector helpers from one catalog', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'helper-skill-catalog-'))
    roots.push(storageRoot)
    await mkdir(storageRoot, { recursive: true })
    const builtin = await skill('featured', 'builtin-skill')
    const personal = await skill('personal', 'personal-skill')
    const imported = await skill('imported', 'imported-skill')
    const connectorSkill = await skill('featured', 'connector-skill')
    const connectorPackage: RegisteredSkillPackage = {
      skillId: connectorSkill.id,
      origin: 'connector',
      packageRoot: connectorSkill.sourceDir,
      helpers: [...(connectorSkill.helpers ?? [])]
    }
    const repository = new SettingsRepository(storageRoot)
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      skillRegistry: { list: async () => [builtin] } as unknown as SkillRegistry,
      userSkills: { list: async () => [personal, imported] } as unknown as UserSkillRepository,
      registeredConnectorPackages: async () => [connectorPackage]
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
    await expect(registry.resolve('connector-skill-helper')).resolves.toMatchObject({
      skillId: 'connector-skill',
      origin: 'connector'
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
      'imported-skill-helper',
      'connector-skill-helper'
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
      'imported',
      'connector'
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
})
