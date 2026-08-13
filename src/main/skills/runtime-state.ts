import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const OWNER_MARKER = '.open-science-runtime-state.json'
const OWNER_FORMAT = 'open-science.skill-runtime-state/v1'

export type SkillRuntimeRoots = Readonly<{
  cacheRoot: string
  stateRoot: string
  temporaryRoot: string
  outputHandoffRoot: string
  executionCopiesRoot: string
}>

export interface LanguageRuntimeAdapter {
  environment(
    roots: SkillRuntimeRoots,
    inherited: Readonly<Record<string, string>>
  ): Record<string, string>
}

export class CompositeLanguageRuntimeAdapter implements LanguageRuntimeAdapter {
  constructor(private readonly adapters: readonly LanguageRuntimeAdapter[]) {}

  environment(
    roots: SkillRuntimeRoots,
    inherited: Readonly<Record<string, string>>
  ): Record<string, string> {
    return this.adapters.reduce<Record<string, string>>(
      (environment, adapter) => adapter.environment(roots, environment),
      { ...inherited }
    )
  }
}

export class PythonLanguageRuntimeAdapter implements LanguageRuntimeAdapter {
  environment(
    roots: SkillRuntimeRoots,
    inherited: Readonly<Record<string, string>>
  ): Record<string, string> {
    return {
      ...inherited,
      TMPDIR: roots.temporaryRoot,
      XDG_CACHE_HOME: roots.cacheRoot,
      XDG_STATE_HOME: roots.stateRoot,
      PYTHONPYCACHEPREFIX: join(roots.cacheRoot, 'python', 'bytecode')
    }
  }
}

export class RLanguageRuntimeAdapter implements LanguageRuntimeAdapter {
  environment(
    roots: SkillRuntimeRoots,
    inherited: Readonly<Record<string, string>>
  ): Record<string, string> {
    return {
      ...inherited,
      TMPDIR: roots.temporaryRoot,
      TMP: roots.temporaryRoot,
      TEMP: roots.temporaryRoot,
      XDG_CACHE_HOME: roots.cacheRoot,
      XDG_STATE_HOME: roots.stateRoot,
      R_USER_CACHE_DIR: join(roots.cacheRoot, 'r'),
      R_LIBS_USER: join(roots.cacheRoot, 'r', 'library')
    }
  }
}

export type SkillRuntimeStateScope = Readonly<{
  agentSessionId: string
  runtimeBindingId: string
  attemptId: string
}>

export type SkillRuntimeStateBinding = Readonly<{
  scope: SkillRuntimeStateScope
  roots: SkillRuntimeRoots
  environment: Readonly<Record<string, string>>
  createExecutionCopy(input: { sourceDir: string; packageId: string }): Promise<string>
  release(): Promise<void>
}>

export type SkillRuntimeStateReconcilePolicy = Readonly<{
  maxAttemptAgeMs?: number
  maxBindingAgeMs?: number
  maxCacheBytes?: number
}>

export type SkillRuntimeStateCleanupReport = Readonly<{
  attemptsRemoved: number
  bindingsRemoved: number
  cachesRemoved: number
  bytesRemoved: number
}>

export type SkillRuntimeStateOwnerOptions = Readonly<{
  storageRoot: string
  now?: () => number
}>

export type SkillRuntimeStateAcquireInput = SkillRuntimeStateScope &
  Readonly<{
    language?: LanguageRuntimeAdapter
    environment?: Readonly<Record<string, string>>
  }>

type OwnerMarker = Readonly<{
  owner: string
  kind: 'binding' | 'attempt'
  agentSessionId: string
  runtimeBindingId: string
  attemptId?: string
  updatedAtMs: number
}>

const isSafeSegment = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
  value !== '.' &&
  value !== '..'

const safeSegment = (value: string, label: string): string => {
  if (!isSafeSegment(value)) {
    throw new Error(`${label} must be a non-empty filesystem-safe identifier.`)
  }
  return value
}

const directorySize = async (directory: string): Promise<number> => {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) total += await directorySize(path)
    else if (entry.isFile()) total += (await stat(path)).size
  }
  return total
}

const makeTreeWritable = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await makeTreeWritable(path)
    else if (entry.isFile()) await chmod(path, (await stat(path)).mode | 0o600)
  }
  await chmod(directory, (await stat(directory)).mode | 0o700)
}

const childDirectories = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const validateLimit = (value: number | undefined, label: string): void => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative finite number.`)
  }
}

export class SkillRuntimeStateOwner {
  private readonly storageRoot: string
  private readonly now: () => number
  private readonly activeAttempts = new Map<string, number>()
  private readonly activeBindings = new Map<string, number>()

  constructor(options: SkillRuntimeStateOwnerOptions) {
    this.storageRoot = resolve(options.storageRoot)
    this.now = options.now ?? Date.now
  }

  async acquire(input: SkillRuntimeStateAcquireInput): Promise<SkillRuntimeStateBinding> {
    const scope = {
      agentSessionId: safeSegment(input.agentSessionId, 'Agent Session id'),
      runtimeBindingId: safeSegment(input.runtimeBindingId, 'Runtime Binding id'),
      attemptId: safeSegment(input.attemptId, 'Attempt id')
    }
    const bindingRoot = this.bindingRoot(scope)
    const attemptRoot = this.attemptRoot(scope)
    const roots: SkillRuntimeRoots = Object.freeze({
      cacheRoot: join(bindingRoot, 'cache'),
      stateRoot: join(bindingRoot, 'state'),
      temporaryRoot: join(attemptRoot, 'temporary'),
      outputHandoffRoot: join(attemptRoot, 'output-handoff'),
      executionCopiesRoot: join(attemptRoot, 'execution-copies')
    })

    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })))
    await mkdir(join(roots.cacheRoot, 'python', 'bytecode'), { recursive: true })
    await mkdir(join(roots.cacheRoot, 'r', 'library'), { recursive: true })
    await this.writeMarker(bindingRoot, 'binding', scope)
    await this.writeMarker(attemptRoot, 'attempt', scope)

    const environment = Object.freeze(
      input.language
        ? input.language.environment(roots, input.environment ?? {})
        : { ...(input.environment ?? {}) }
    )
    this.retain(this.activeAttempts, attemptRoot)
    this.retain(this.activeBindings, bindingRoot)
    let releaseCompleted = false
    let releaseOperation: Promise<void> | undefined
    let activeOwnershipReleased = false
    return Object.freeze({
      scope: Object.freeze(scope),
      roots,
      environment,
      createExecutionCopy: (copyInput) => {
        if (releaseOperation || releaseCompleted)
          throw new Error('The Skill runtime state lease has been released.')
        return this.createExecutionCopy(attemptRoot, scope, copyInput)
      },
      release: () => {
        if (releaseCompleted) return Promise.resolve()
        releaseOperation ??= (async () => {
          try {
            await Promise.all([
              this.writeMarker(attemptRoot, 'attempt', scope),
              this.writeMarker(bindingRoot, 'binding', scope)
            ])
          } finally {
            if (!activeOwnershipReleased) {
              activeOwnershipReleased = true
              this.release(this.activeAttempts, attemptRoot)
              this.release(this.activeBindings, bindingRoot)
            }
          }
          // Attempt-local temp, handoff, and exceptional writable copies have no reuse value. Remove
          // them at the normal terminal boundary; startup reconciliation remains the crash fallback.
          await this.cleanupAttempt(scope)
          releaseCompleted = true
        })().catch((error) => {
          releaseOperation = undefined
          throw error
        })
        return releaseOperation
      }
    })
  }

  async reconcile(
    policy: SkillRuntimeStateReconcilePolicy = {}
  ): Promise<SkillRuntimeStateCleanupReport> {
    validateLimit(policy.maxAttemptAgeMs, 'Maximum Attempt age')
    validateLimit(policy.maxBindingAgeMs, 'Maximum Runtime Binding age')
    validateLimit(policy.maxCacheBytes, 'Maximum cache bytes')
    let attemptsRemoved = 0
    let bindingsRemoved = 0
    let bytesRemoved = 0
    let cachesRemoved = 0
    const cacheCandidates: Array<{ root: string; bytes: number; updatedAtMs: number }> = []

    for (const agentSessionRoot of await childDirectories(
      join(this.storageRoot, 'agent-sessions')
    )) {
      for (const bindingRoot of await childDirectories(
        join(agentSessionRoot, 'runtime-bindings')
      )) {
        const bindingMarker = await this.readMarker(bindingRoot)
        if (!bindingMarker || bindingMarker.kind !== 'binding') continue
        if (bindingRoot !== this.bindingRoot(bindingMarker)) continue

        for (const attemptRoot of await childDirectories(join(bindingRoot, 'attempts'))) {
          const marker = await this.readMarker(attemptRoot)
          if (!marker || marker.kind !== 'attempt' || marker.attemptId === undefined) continue
          const scope = { ...marker, attemptId: marker.attemptId }
          if (attemptRoot !== this.attemptRoot(scope) || this.activeAttempts.has(attemptRoot))
            continue
          const stale =
            policy.maxAttemptAgeMs !== undefined &&
            this.now() - marker.updatedAtMs >= policy.maxAttemptAgeMs
          if (!stale) continue
          const removed = await this.cleanupAttempt(scope)
          attemptsRemoved += removed.attemptsRemoved
          bytesRemoved += removed.bytesRemoved
        }

        if (this.activeBindings.has(bindingRoot)) continue
        const staleBinding =
          policy.maxBindingAgeMs !== undefined &&
          this.now() - bindingMarker.updatedAtMs >= policy.maxBindingAgeMs
        if (staleBinding) {
          const removed = await this.cleanupRuntimeBinding({
            agentSessionId: bindingMarker.agentSessionId,
            runtimeBindingId: bindingMarker.runtimeBindingId
          })
          bindingsRemoved += removed.bindingsRemoved
          bytesRemoved += removed.bytesRemoved
          continue
        }
        const cacheRoot = join(bindingRoot, 'cache')
        const cacheBytes = await directorySize(cacheRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 0
          throw error
        })
        cacheCandidates.push({
          root: cacheRoot,
          bytes: cacheBytes,
          updatedAtMs: bindingMarker.updatedAtMs
        })
      }
    }

    if (policy.maxCacheBytes !== undefined) {
      let totalBytes = cacheCandidates.reduce((total, candidate) => total + candidate.bytes, 0)
      cacheCandidates.sort((left, right) => left.updatedAtMs - right.updatedAtMs)
      for (const candidate of cacheCandidates) {
        if (totalBytes <= policy.maxCacheBytes) break
        if (candidate.bytes === 0) continue
        await rm(candidate.root, { recursive: true, force: true })
        totalBytes -= candidate.bytes
        bytesRemoved += candidate.bytes
        cachesRemoved += 1
      }
    }

    return { attemptsRemoved, bindingsRemoved, cachesRemoved, bytesRemoved }
  }

  async cleanupAttempt(scope: SkillRuntimeStateScope): Promise<SkillRuntimeStateCleanupReport> {
    const safeScope = this.safeScope(scope)
    const attemptRoot = this.attemptRoot(safeScope)
    if (this.activeAttempts.has(attemptRoot)) return this.emptyReport()
    if (!(await this.isOwned(attemptRoot, 'attempt', safeScope))) return this.emptyReport()
    const bytesRemoved = await directorySize(attemptRoot)
    await rm(attemptRoot, { recursive: true, force: true })
    return { attemptsRemoved: 1, bindingsRemoved: 0, cachesRemoved: 0, bytesRemoved }
  }

  async cleanupRuntimeBinding(scope: {
    agentSessionId: string
    runtimeBindingId: string
  }): Promise<SkillRuntimeStateCleanupReport> {
    const safeScope = {
      agentSessionId: safeSegment(scope.agentSessionId, 'Agent Session id'),
      runtimeBindingId: safeSegment(scope.runtimeBindingId, 'Runtime Binding id')
    }
    const bindingRoot = this.bindingRoot(safeScope)
    if (this.activeBindings.has(bindingRoot)) return this.emptyReport()
    if (!(await this.isOwned(bindingRoot, 'binding', safeScope))) return this.emptyReport()
    const bytesRemoved = await directorySize(bindingRoot)
    await rm(bindingRoot, { recursive: true, force: true })
    await this.removeEmptyBindingAncestors(bindingRoot)
    return { attemptsRemoved: 0, bindingsRemoved: 1, cachesRemoved: 0, bytesRemoved }
  }

  private async removeEmptyBindingAncestors(bindingRoot: string): Promise<void> {
    const runtimeBindingsRoot = dirname(bindingRoot)
    const agentSessionRoot = dirname(runtimeBindingsRoot)
    for (const path of [runtimeBindingsRoot, agentSessionRoot]) {
      try {
        await rmdir(path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return
        throw error
      }
    }
  }

  private async createExecutionCopy(
    attemptRoot: string,
    scope: SkillRuntimeStateScope,
    input: { sourceDir: string; packageId: string }
  ): Promise<string> {
    const packageId = safeSegment(input.packageId, 'Skill package id')
    const target = join(attemptRoot, 'execution-copies', packageId)
    await rm(target, { recursive: true, force: true })
    await cp(input.sourceDir, target, { recursive: true, force: false, errorOnExist: true })
    await makeTreeWritable(target)
    await this.writeMarker(attemptRoot, 'attempt', scope)
    return target
  }

  private async writeMarker(
    directory: string,
    kind: 'binding' | 'attempt',
    scope: SkillRuntimeStateScope
  ): Promise<void> {
    await mkdir(directory, { recursive: true })
    const attempt = kind === 'attempt' ? { attemptId: scope.attemptId } : {}
    await writeFile(
      join(directory, OWNER_MARKER),
      JSON.stringify({
        owner: OWNER_FORMAT,
        kind,
        agentSessionId: scope.agentSessionId,
        runtimeBindingId: scope.runtimeBindingId,
        ...attempt,
        updatedAtMs: this.now()
      }),
      { encoding: 'utf8', mode: 0o600 }
    )
  }

  private async isOwned(
    directory: string,
    kind: 'binding' | 'attempt',
    scope: { agentSessionId: string; runtimeBindingId: string; attemptId?: string }
  ): Promise<boolean> {
    try {
      if (!(await lstat(directory)).isDirectory()) return false
      const marker = await this.readMarker(directory)
      return Boolean(
        marker &&
        marker.kind === kind &&
        marker.agentSessionId === scope.agentSessionId &&
        marker.runtimeBindingId === scope.runtimeBindingId &&
        (kind === 'binding' || marker.attemptId === scope.attemptId)
      )
    } catch {
      return false
    }
  }

  private async readMarker(directory: string): Promise<OwnerMarker | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(directory, OWNER_MARKER), 'utf8')
      ) as Partial<OwnerMarker>
      if (
        parsed.owner !== OWNER_FORMAT ||
        (parsed.kind !== 'binding' && parsed.kind !== 'attempt') ||
        !isSafeSegment(parsed.agentSessionId) ||
        !isSafeSegment(parsed.runtimeBindingId) ||
        typeof parsed.updatedAtMs !== 'number' ||
        !Number.isFinite(parsed.updatedAtMs) ||
        (parsed.kind === 'attempt' && !isSafeSegment(parsed.attemptId))
      ) {
        return undefined
      }
      return parsed as OwnerMarker
    } catch {
      return undefined
    }
  }

  private safeScope(scope: SkillRuntimeStateScope): SkillRuntimeStateScope {
    return {
      agentSessionId: safeSegment(scope.agentSessionId, 'Agent Session id'),
      runtimeBindingId: safeSegment(scope.runtimeBindingId, 'Runtime Binding id'),
      attemptId: safeSegment(scope.attemptId, 'Attempt id')
    }
  }

  private bindingRoot(scope: { agentSessionId: string; runtimeBindingId: string }): string {
    return join(
      this.storageRoot,
      'agent-sessions',
      scope.agentSessionId,
      'runtime-bindings',
      scope.runtimeBindingId
    )
  }

  private attemptRoot(scope: SkillRuntimeStateScope): string {
    return join(this.bindingRoot(scope), 'attempts', scope.attemptId)
  }

  private retain(active: Map<string, number>, root: string): void {
    active.set(root, (active.get(root) ?? 0) + 1)
  }

  private release(active: Map<string, number>, root: string): void {
    const remaining = (active.get(root) ?? 1) - 1
    if (remaining === 0) active.delete(root)
    else active.set(root, remaining)
  }

  private emptyReport(): SkillRuntimeStateCleanupReport {
    return { attemptsRemoved: 0, bindingsRemoved: 0, cachesRemoved: 0, bytesRemoved: 0 }
  }
}
