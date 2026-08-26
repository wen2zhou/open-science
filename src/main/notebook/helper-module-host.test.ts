import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { NotebookHelperModuleHost, type RegisteredNotebookHelperModule } from './helper-module-host'
import type { NotebookKernelEpochOwnership } from './session-aggregate'

const digest = (source: string): string => createHash('sha256').update(source).digest('hex')

const helper = (
  id: string,
  source = `def ${id.replaceAll('-', '_')}():\n    return ${JSON.stringify(id)}`,
  dependencies: readonly string[] = [],
  registeredGeneration = 'generation-1'
): RegisteredNotebookHelperModule => ({
  id,
  language: 'python',
  source,
  sourceDigest: digest(source),
  exports: [id.replaceAll('-', '_')],
  dependencies,
  registeredGeneration,
  generationRoot: `/registered/${registeredGeneration}`
})

const epoch = (id: string): NotebookKernelEpochOwnership => ({
  id,
  processKey: 'python:default-python'
})

describe('NotebookHelperModuleHost', () => {
  it('pins roots before deterministic dependency expansion and initializes each helper once', async () => {
    const descriptors = new Map([
      ['root-b', helper('root-b', undefined, ['shared'])],
      ['root-a', helper('root-a', undefined, ['shared'])],
      ['shared', helper('shared')]
    ])
    const resolve = vi.fn(async (id: string) => descriptors.get(id))
    const host = new NotebookHelperModuleHost({ resolve })
    const ownership = epoch('epoch-1')

    const request = await host.preflight('python', ['root-b', 'root-a', 'root-b'])
    const first = await host.plan(ownership, request)
    host.commitInitialized(
      ownership,
      first.injections.map(({ id }) => id)
    )
    const second = await host.plan(ownership, await host.preflight('python', ['root-a', 'root-b']))

    expect(first.injections.map(({ id }) => id)).toEqual(['shared', 'root-a', 'root-b'])
    expect(second.injections).toEqual([])
    expect(first.protectedGenerationRoots).toEqual(['/registered/generation-1'])
  })

  it('fails missing dependencies and cycles before returning an injection plan', async () => {
    const missingHost = new NotebookHelperModuleHost({
      resolve: async (id) => (id === 'root' ? helper('root', undefined, ['missing']) : undefined)
    })
    await expect(
      missingHost.plan(epoch('missing-epoch'), await missingHost.preflight('python', ['root']))
    ).rejects.toThrow(/MISSING_HELPER_DEPENDENCY.*root.*missing/)

    const cycleHost = new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'a'
          ? helper('a', undefined, ['b'])
          : id === 'b'
            ? helper('b', undefined, ['a'])
            : undefined
    })
    await expect(
      cycleHost.plan(epoch('cycle-epoch'), await cycleHost.preflight('python', ['a']))
    ).rejects.toThrow(/HELPER_DEPENDENCY_CYCLE.*a -> b -> a/)
  })

  it('keeps the first registered generation pinned until the aggregate rotates the epoch', async () => {
    let current = helper('stable', 'def stable():\n    return 1', [], 'generation-1')
    const host = new NotebookHelperModuleHost({ resolve: async () => current })
    const firstEpoch = epoch('epoch-1')

    const first = await host.plan(firstEpoch, await host.preflight('python', ['stable']))
    host.commitInitialized(firstEpoch, ['stable'])
    current = helper('stable', 'def stable():\n    return 2', [], 'generation-2')
    const pinned = await host.plan(firstEpoch, await host.preflight('python', ['stable']))
    const replacement = await host.plan(
      epoch('epoch-2'),
      await host.preflight('python', ['stable'])
    )

    expect(first.injections[0]).toMatchObject({ registeredGeneration: 'generation-1' })
    expect(pinned.injections).toEqual([])
    expect(replacement.injections[0]).toMatchObject({ registeredGeneration: 'generation-2' })
  })

  it('rejects a catalog digest mismatch without exposing source text', async () => {
    const source = 'def secret_export():\n    return "protected source marker"'
    const host = new NotebookHelperModuleHost({
      resolve: async () => ({ ...helper('secret', source), sourceDigest: '0'.repeat(64) })
    })

    const failure = await host.preflight('python', ['secret']).catch((error: unknown) => error)
    expect(String(failure)).toMatch(/HELPER_GENERATION_MISMATCH.*secret/)
    expect(String(failure)).not.toContain('protected source marker')
  })
})
