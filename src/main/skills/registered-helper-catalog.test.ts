import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RegisteredSkillHelperCatalog,
  type RegisteredSkillPackage
} from './registered-helper-catalog'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const packageFixture = async (
  origin: RegisteredSkillPackage['origin'],
  skillId: string,
  source = 'def public_value():\n    return "v1"\n'
): Promise<RegisteredSkillPackage> => {
  const packageRoot = await mkdtemp(join(tmpdir(), `registered-${origin}-`))
  roots.push(packageRoot)
  await writeFile(join(packageRoot, 'kernel.py'), source)
  return {
    skillId,
    origin,
    packageRoot,
    helpers: [
      {
        id: `${skillId}-helper`,
        language: 'python',
        interfaceRevision: 1,
        implementation: 'kernel.py',
        exports: ['public_value'],
        dependencies: []
      }
    ]
  }
}

const createCatalog = async (
  packages: () => Promise<readonly RegisteredSkillPackage[]>,
  authorize?: ConstructorParameters<typeof RegisteredSkillHelperCatalog>[0]['authorize']
): Promise<RegisteredSkillHelperCatalog> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'registered-generations-'))
  roots.push(storageRoot)
  return new RegisteredSkillHelperCatalog({ storageRoot, packages, authorize })
}

describe('RegisteredSkillHelperCatalog', () => {
  it('normalizes all four origins through one catalog port and materializes app-owned generations', async () => {
    const packages = await Promise.all(
      (['builtin', 'personal', 'imported', 'connector'] as const).map((origin) =>
        packageFixture(origin, origin)
      )
    )
    const catalog = await createCatalog(async () => packages)

    for (const entry of packages) {
      const helper = await catalog.resolve(`${entry.skillId}-helper`, {
        projectId: 'project-1',
        sessionId: 'session-1'
      })
      expect(helper).toMatchObject({
        id: `${entry.skillId}-helper`,
        skillId: entry.skillId,
        origin: entry.origin,
        language: 'python',
        interfaceRevision: 1,
        exports: ['public_value'],
        dependencies: []
      })
      expect(helper?.source).toContain('return "v1"')
      expect(helper?.generation).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(helper?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(JSON.stringify(helper)).not.toContain(entry.packageRoot)
    }
  })

  it('assigns every helper in one package the same immutable package generation', async () => {
    const entry = await packageFixture('builtin', 'multi')
    entry.helpers.push({ ...entry.helpers[0]!, id: 'multi-second-helper' })
    const catalog = await createCatalog(async () => [entry])

    const first = await catalog.resolve('multi-helper')
    const second = await catalog.resolve('multi-second-helper')
    expect(first?.generation).toBe(second?.generation)
    const root = catalog.generationRoot(first!.generation)
    await expect(readFile(join(root, 'multi-helper', 'source.py'), 'utf8')).resolves.toContain(
      'public_value'
    )
    await expect(
      readFile(join(root, 'multi-second-helper', 'source.py'), 'utf8')
    ).resolves.toContain('public_value')
  })

  it.each(['builtin', 'personal', 'imported', 'connector'] as const)(
    'keeps the old immutable %s generation after replacement and never rereads its source',
    async (origin) => {
      const entry = await packageFixture(origin, 'plot')
      let current = entry
      const catalog = await createCatalog(async () => [current])
      const first = await catalog.resolve('plot-helper')
      expect(first?.source).toContain('"v1"')

      await writeFile(
        join(entry.packageRoot, 'kernel.py'),
        'def public_value():\n    return "v2"\n'
      )
      expect((await catalog.resolve('plot-helper'))?.source).toContain('"v1"')

      const replacement = await packageFixture(
        origin,
        'plot',
        'def public_value():\n    return "v2"\n'
      )
      current = replacement
      catalog.invalidate()
      const second = await catalog.resolve('plot-helper')
      expect(second?.source).toContain('"v2"')
      expect(second?.generation).not.toBe(first?.generation)

      const generationRoot = catalog.generationRoot(first!.generation)
      await expect(
        readFile(join(generationRoot, 'plot-helper', 'source.py'), 'utf8')
      ).resolves.toContain('"v1"')
    }
  )

  it.each([
    ['/absolute.py', 'implementation locator'],
    ['../escape.py', 'implementation locator'],
    ['nested\\kernel.py', 'implementation locator']
  ])('rejects unsafe locator %s', async (implementation, message) => {
    const entry = await packageFixture('imported', 'unsafe')
    entry.helpers[0] = { ...entry.helpers[0]!, implementation }
    const catalog = await createCatalog(async () => [entry])
    await expect(catalog.resolve('unsafe-helper')).rejects.toThrow(message)
  })

  it('rejects symlinks, invalid UTF-8, oversized source, missing exports, and duplicate exports', async () => {
    const cases: Array<{
      mutate: (entry: RegisteredSkillPackage) => Promise<void>
      error: string
    }> = [
      {
        mutate: async (entry) => {
          await writeFile(
            join(entry.packageRoot, 'target.py'),
            'def public_value():\n    return 1\n'
          )
          await rm(join(entry.packageRoot, 'kernel.py'))
          await symlink('target.py', join(entry.packageRoot, 'kernel.py'))
        },
        error: 'symbolic link'
      },
      {
        mutate: (entry) =>
          writeFile(join(entry.packageRoot, 'kernel.py'), Buffer.from([0xff, 0xfe])),
        error: 'UTF-8'
      },
      {
        mutate: (entry) => writeFile(join(entry.packageRoot, 'kernel.py'), 'x'.repeat(1_048_577)),
        error: 'size limit'
      },
      {
        mutate: (entry) => writeFile(join(entry.packageRoot, 'kernel.py'), 'VALUE = 1\n'),
        error: 'callable export'
      },
      {
        mutate: async (entry) => {
          entry.helpers[0] = { ...entry.helpers[0]!, exports: ['public_value', 'public_value'] }
        },
        error: 'duplicate export'
      }
    ]

    for (const [index, testCase] of cases.entries()) {
      const entry = await packageFixture('connector', `bad-${index}`)
      await testCase.mutate(entry)
      const catalog = await createCatalog(async () => [entry])
      await expect(catalog.resolve(`bad-${index}-helper`)).rejects.toThrow(testCase.error)
    }
  })

  it('fails closed on duplicate IDs, missing dependencies, cycles, and non-callable dependencies', async () => {
    const first = await packageFixture('builtin', 'first')
    const duplicate = await packageFixture('personal', 'second')
    duplicate.helpers[0] = { ...duplicate.helpers[0]!, id: 'first-helper' }
    await expect(
      (await createCatalog(async () => [first, duplicate])).resolve('first-helper')
    ).rejects.toThrow('duplicate helper ID')

    const missing = await packageFixture('imported', 'missing')
    missing.helpers[0] = { ...missing.helpers[0]!, dependencies: ['absent-helper'] }
    await expect(
      (await createCatalog(async () => [missing])).resolve('missing-helper')
    ).rejects.toThrow('unknown dependency')

    const left = await packageFixture('builtin', 'left')
    const right = await packageFixture('connector', 'right')
    left.helpers[0] = { ...left.helpers[0]!, dependencies: ['right-helper'] }
    right.helpers[0] = { ...right.helpers[0]!, dependencies: ['left-helper'] }
    await expect(
      (await createCatalog(async () => [left, right])).resolve('left-helper')
    ).rejects.toThrow('dependency cycle')
  })

  it('rejects a registered generation whose combined helper sources exceed the total limit', async () => {
    const packages = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        packageFixture(
          'builtin',
          `large-${index}`,
          `def public_value():\n    return ${index}\n#${'x'.repeat(900_000)}`
        )
      )
    )
    const catalog = await createCatalog(async () => packages)

    await expect(catalog.resolve('large-0-helper')).rejects.toThrow('total source size limit')
  })

  it('enforces trusted scope authorization without accepting scope claims in helper IDs', async () => {
    const allowed = await packageFixture('builtin', 'allowed')
    const denied = await packageFixture('personal', 'denied')
    const catalog = await createCatalog(
      async () => [allowed, denied],
      ({ skillId }, scope) => scope?.sessionId === 'session-1' && skillId === 'allowed'
    )

    await expect(
      catalog.resolve('allowed-helper', { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toBeDefined()
    await expect(
      catalog.resolve('denied-helper', { projectId: 'project-1', sessionId: 'session-1' })
    ).rejects.toThrow('not authorized')
    await expect(catalog.resolve('/tmp/kernel.py')).resolves.toBeUndefined()
    await expect(catalog.resolve('sha256:' + 'a'.repeat(64))).resolves.toBeUndefined()
  })

  it('validates Personal and Imported descriptors before a staged package is promoted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'staged-helper-'))
    roots.push(root)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'kernel.py'), 'def public_value():\n    return 1\n')
    const descriptor = {
      schemaVersion: 1,
      helpers: [
        {
          id: 'staged-helper',
          language: 'python',
          interfaceRevision: 1,
          implementation: 'kernel.py',
          exports: ['missing'],
          dependencies: []
        }
      ]
    }
    await writeFile(join(root, 'open-science.json'), JSON.stringify(descriptor))

    const { inspectSkillPackage } = await import('./skill-package-inspection')
    await expect(inspectSkillPackage(root)).rejects.toThrow('callable export')
  })
})
