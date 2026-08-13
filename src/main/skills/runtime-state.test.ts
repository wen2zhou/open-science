import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CompositeLanguageRuntimeAdapter,
  PythonLanguageRuntimeAdapter,
  RLanguageRuntimeAdapter,
  SkillRuntimeStateOwner
} from './runtime-state'

const temporaryRoots: string[] = []

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'skill-runtime-state-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('SkillRuntimeStateOwner', () => {
  it('composes language adapters behind one language-neutral environment contract', async () => {
    const owner = new SkillRuntimeStateOwner({ storageRoot: await temporaryRoot() })
    const binding = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'multi-language-1',
      attemptId: 'attempt-1',
      language: new CompositeLanguageRuntimeAdapter([
        new PythonLanguageRuntimeAdapter(),
        new RLanguageRuntimeAdapter()
      ]),
      environment: { HOME: '/users/researcher' }
    })

    expect(binding.environment).toMatchObject({
      HOME: '/users/researcher',
      PYTHONPYCACHEPREFIX: join(binding.roots.cacheRoot, 'python', 'bytecode'),
      R_LIBS_USER: join(binding.roots.cacheRoot, 'r', 'library')
    })
  })

  it('allocates binding- and Attempt-scoped roots and layers Python state without replacing HOME', async () => {
    const owner = new SkillRuntimeStateOwner({ storageRoot: await temporaryRoot() })
    const first = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'python-1',
      attemptId: 'attempt-1',
      language: new PythonLanguageRuntimeAdapter(),
      environment: { HOME: '/users/researcher', EXISTING: 'kept' }
    })
    const second = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'python-1',
      attemptId: 'attempt-2',
      language: new PythonLanguageRuntimeAdapter(),
      environment: { HOME: '/users/researcher' }
    })

    expect(second.roots.cacheRoot).toBe(first.roots.cacheRoot)
    expect(second.roots.stateRoot).toBe(first.roots.stateRoot)
    expect(second.roots.temporaryRoot).not.toBe(first.roots.temporaryRoot)
    expect(second.roots.outputHandoffRoot).not.toBe(first.roots.outputHandoffRoot)
    expect(first.environment).toMatchObject({
      HOME: '/users/researcher',
      EXISTING: 'kept',
      TMPDIR: first.roots.temporaryRoot,
      PYTHONPYCACHEPREFIX: join(first.roots.cacheRoot, 'python', 'bytecode'),
      XDG_CACHE_HOME: first.roots.cacheRoot,
      XDG_STATE_HOME: first.roots.stateRoot
    })
  })

  it('provides R with Attempt temp and binding library roots without replacing HOME', async () => {
    const owner = new SkillRuntimeStateOwner({ storageRoot: await temporaryRoot() })
    const binding = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'r-1',
      attemptId: 'attempt-1',
      language: new RLanguageRuntimeAdapter(),
      environment: { HOME: '/users/researcher' }
    })

    expect(binding.environment).toMatchObject({
      HOME: '/users/researcher',
      TMPDIR: binding.roots.temporaryRoot,
      R_LIBS_USER: join(binding.roots.cacheRoot, 'r', 'library')
    })
  })

  it('creates an Attempt-owned writable copy that never changes the projected package', async () => {
    const sourceDir = await temporaryRoot()
    await mkdir(join(sourceDir, 'scripts'))
    await writeFile(join(sourceDir, 'SKILL.md'), '# Projected', 'utf8')
    await writeFile(join(sourceDir, 'scripts', 'run.py'), 'print("original")', 'utf8')
    await chmod(join(sourceDir, 'scripts', 'run.py'), 0o444)
    const owner = new SkillRuntimeStateOwner({ storageRoot: await temporaryRoot() })
    const binding = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'python-1',
      attemptId: 'attempt-1'
    })

    const copy = await binding.createExecutionCopy({ sourceDir, packageId: 'alpha' })
    expect((await stat(join(copy, 'scripts', 'run.py'))).mode & 0o200).toBe(0o200)
    await writeFile(join(copy, 'scripts', 'run.py'), 'print("changed")', 'utf8')
    expect(await readFile(join(sourceDir, 'scripts', 'run.py'), 'utf8')).toBe('print("original")')

    await binding.release()
    await expect(stat(copy)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects identifiers that could escape the owned storage tree', async () => {
    const owner = new SkillRuntimeStateOwner({ storageRoot: await temporaryRoot() })
    await expect(
      owner.acquire({
        agentSessionId: '../other',
        runtimeBindingId: 'python-1',
        attemptId: 'attempt-1'
      })
    ).rejects.toThrow(/filesystem-safe/i)
  })

  it('removes empty binding and Agent Session ancestors after normal cleanup', async () => {
    const storageRoot = await temporaryRoot()
    const owner = new SkillRuntimeStateOwner({ storageRoot })
    const binding = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'binding-1',
      attemptId: 'attempt-1'
    })

    await binding.release()
    await owner.cleanupRuntimeBinding({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'binding-1'
    })

    expect(await readdir(join(storageRoot, 'agent-sessions'))).toEqual([])
  })

  it('reconciles stale Attempts and cache bytes after a crash without removing unmarked data', async () => {
    const storageRoot = await temporaryRoot()
    let now = 10
    const owner = new SkillRuntimeStateOwner({ storageRoot, now: () => now })
    const stale = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'python-old',
      attemptId: 'attempt-old'
    })
    await writeFile(join(stale.roots.cacheRoot, 'large.cache'), '12345678', 'utf8')
    await writeFile(join(stale.roots.outputHandoffRoot, 'result.txt'), 'result', 'utf8')
    const unmarked = join(
      storageRoot,
      'agent-sessions',
      'agent-session-1',
      'runtime-bindings',
      'python-old',
      'attempts',
      'unmarked'
    )
    await mkdir(unmarked)
    await writeFile(join(unmarked, 'keep.txt'), 'keep', 'utf8')

    now = 100
    const restarted = new SkillRuntimeStateOwner({ storageRoot, now: () => now })
    const current = await restarted.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'python-current',
      attemptId: 'attempt-current'
    })
    await writeFile(join(current.roots.cacheRoot, 'small.cache'), '1234', 'utf8')
    const report = await restarted.reconcile({ maxAttemptAgeMs: 50, maxCacheBytes: 4 })

    await expect(stat(stale.roots.temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(stale.roots.cacheRoot, 'large.cache'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(join(unmarked, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(current.roots.cacheRoot, 'small.cache'), 'utf8')).toBe('1234')
    expect(report).toMatchObject({ attemptsRemoved: 1, cachesRemoved: 1 })
    expect(report.bytesRemoved).toBeGreaterThan(8)
  })

  it('fences an active lease from age and byte reconciliation until release', async () => {
    const storageRoot = await temporaryRoot()
    let now = 10
    const owner = new SkillRuntimeStateOwner({ storageRoot, now: () => now })
    const binding = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'python-1',
      attemptId: 'attempt-1'
    })
    await writeFile(join(binding.roots.cacheRoot, 'active.cache'), '12345678', 'utf8')

    now = 100
    expect(await owner.reconcile({ maxAttemptAgeMs: 50, maxCacheBytes: 0 })).toMatchObject({
      attemptsRemoved: 0,
      cachesRemoved: 0
    })
    expect(await readFile(join(binding.roots.cacheRoot, 'active.cache'), 'utf8')).toBe('12345678')

    await binding.release()
    now = 200
    expect(await owner.reconcile({ maxAttemptAgeMs: 50, maxCacheBytes: 0 })).toMatchObject({
      attemptsRemoved: 0,
      cachesRemoved: 1
    })
  })

  it('removes a complete stale binding after restart while fencing live bindings', async () => {
    const storageRoot = await temporaryRoot()
    const crashedOwner = new SkillRuntimeStateOwner({ storageRoot, now: () => 10 })
    const crashed = await crashedOwner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'crashed-binding',
      attemptId: 'crashed-attempt'
    })
    await writeFile(join(crashed.roots.cacheRoot, 'cached.bin'), 'cache', 'utf8')

    const restarted = new SkillRuntimeStateOwner({ storageRoot, now: () => 20 })
    const live = await restarted.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'live-binding',
      attemptId: 'live-attempt'
    })
    const report = await restarted.reconcile({ maxBindingAgeMs: 0 })

    await expect(stat(crashed.roots.cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(live.roots.cacheRoot)).resolves.toBeDefined()
    expect(report.bindingsRemoved).toBe(1)
  })

  it('retries normal Attempt cleanup after a transient parent permission failure', async () => {
    const storageRoot = await temporaryRoot()
    const owner = new SkillRuntimeStateOwner({ storageRoot })
    const binding = await owner.acquire({
      agentSessionId: 'agent-session-1',
      runtimeBindingId: 'binding-1',
      attemptId: 'attempt-1'
    })
    const attemptRoot = join(binding.roots.temporaryRoot, '..')
    const attemptsRoot = join(attemptRoot, '..')
    await chmod(attemptsRoot, 0o500)

    await expect(binding.release()).rejects.toMatchObject({ code: 'EACCES' })
    await chmod(attemptsRoot, 0o700)
    await binding.release()

    await expect(stat(attemptRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
