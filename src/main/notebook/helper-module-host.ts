import { createHash } from 'node:crypto'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookKernelEpochOwnership } from './session-aggregate'

const HELPER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PYTHON_EXPORT = /^[A-Za-z_][A-Za-z0-9_]*$/

type RegisteredNotebookHelperModule = Readonly<{
  id: string
  language: 'python'
  source: string
  sourceDigest?: string
  exports: readonly string[]
  dependencies?: readonly string[]
  registeredGeneration?: string
  generationRoot?: string
}>

type NotebookHelperModuleCatalog = {
  resolve(id: string): Promise<RegisteredNotebookHelperModule | undefined>
}

type PinnedNotebookHelperModule = Readonly<{
  id: string
  language: 'python'
  source: string
  digest: string
  exports: readonly string[]
  dependencies: readonly string[]
  registeredGeneration: string
  generationRoot?: string
}>

type NotebookHelperModuleRequest = Readonly<{
  language: NotebookLanguage
  requestedIds: readonly string[]
  roots: ReadonlyMap<string, PinnedNotebookHelperModule>
}>

type NotebookHelperModuleInjection = Readonly<{
  id: string
  language: 'python'
  exports: readonly string[]
  digest: string
  registeredGeneration: string
  epochId: string
  code: string
}>

type NotebookHelperModulePlan = Readonly<{
  injections: readonly NotebookHelperModuleInjection[]
  protectedGenerationRoots: readonly string[]
}>

type EpochState = {
  pinned: Map<string, PinnedNotebookHelperModule>
  loaded: Set<string>
}

const emptyCatalog: NotebookHelperModuleCatalog = { resolve: async () => undefined }
const sha256 = (source: string): string => createHash('sha256').update(source).digest('hex')

const assertHelperId: (id: unknown) => asserts id is string = (id) => {
  if (typeof id !== 'string' || id.length > 128 || !HELPER_ID.test(id)) {
    throw new Error('INVALID_HELPER_ID: helperModules accepts only stable helper IDs.')
  }
}

const pinDescriptor = (
  expectedId: string,
  helper: RegisteredNotebookHelperModule | undefined,
  missingError: string
): PinnedNotebookHelperModule => {
  if (!helper || helper.id !== expectedId) throw new Error(missingError)
  if (helper.language !== 'python') {
    throw new Error(`UNSUPPORTED_HELPER_LANGUAGE: helper "${expectedId}" is not a Python helper.`)
  }
  if (typeof helper.source !== 'string') {
    throw new Error(`HELPER_SOURCE_VALIDATION_FAILED: helper "${expectedId}" has invalid source.`)
  }
  const exports = [...helper.exports]
  if (
    exports.length === 0 ||
    exports.some((name) => typeof name !== 'string' || !PYTHON_EXPORT.test(name)) ||
    new Set(exports).size !== exports.length
  ) {
    throw new Error(
      `HELPER_SOURCE_VALIDATION_FAILED: helper "${expectedId}" has invalid or duplicate exports.`
    )
  }
  const dependencies = [...(helper.dependencies ?? [])]
  for (const dependency of dependencies) assertHelperId(dependency)
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error(
      `HELPER_SOURCE_VALIDATION_FAILED: helper "${expectedId}" has duplicate dependencies.`
    )
  }
  const digest = sha256(helper.source)
  if (helper.sourceDigest !== undefined && helper.sourceDigest !== digest) {
    throw new Error(
      `HELPER_GENERATION_MISMATCH: helper "${expectedId}" does not match its registered digest.`
    )
  }
  return {
    id: expectedId,
    language: 'python',
    source: helper.source,
    digest,
    exports,
    dependencies: dependencies.sort(),
    registeredGeneration: helper.registeredGeneration ?? `source-${digest}`,
    ...(helper.generationRoot ? { generationRoot: helper.generationRoot } : {})
  }
}

const injectionCode = (
  helper: PinnedNotebookHelperModule,
  dependencyExports: readonly string[]
): string => {
  const filename = `<open-science-helper:${helper.id}>`
  const body = [
    `__os_target = __os_target_globals`,
    `__os_dependency_names = ${JSON.stringify([...dependencyExports])}`,
    `__os_dependency_missing = [name for name in __os_dependency_names if name not in __os_target]`,
    `if __os_dependency_missing:`,
    `    raise RuntimeError("OPEN_SCIENCE_HELPER_DEPENDENCY_EXPORT_MISSING")`,
    `__os_private = {"__builtins__": __builtins__, **{name: __os_target[name] for name in __os_dependency_names}}`,
    `exec(compile(${JSON.stringify(helper.source)}, ${JSON.stringify(filename)}, "exec"), __os_private, __os_private)`,
    `__os_names = ${JSON.stringify([...helper.exports])}`,
    `__os_missing = [name for name in __os_names if name not in __os_private or not callable(__os_private[name])]`,
    `if __os_missing:`,
    `    raise RuntimeError("OPEN_SCIENCE_HELPER_MISSING_EXPORT")`,
    `__os_collisions = [name for name in __os_names if name in __os_target]`,
    `if __os_collisions:`,
    `    raise RuntimeError("OPEN_SCIENCE_HELPER_EXPORT_COLLISION")`,
    `__os_staged = {name: __os_private[name] for name in __os_names}`,
    `__os_target.update(__os_staged)`
  ].join('\n')

  return `exec(compile(${JSON.stringify(body)}, ${JSON.stringify(filename)}, "exec"), {"__builtins__": __builtins__, "__os_target_globals": globals()})`
}

class NotebookHelperModuleHost {
  private readonly epochs = new WeakMap<NotebookKernelEpochOwnership, EpochState>()

  constructor(private readonly catalog: NotebookHelperModuleCatalog = emptyCatalog) {}

  async preflight(
    language: NotebookLanguage,
    requested: readonly string[] | undefined,
    epoch?: NotebookKernelEpochOwnership
  ): Promise<NotebookHelperModuleRequest> {
    if (requested === undefined) return { language, requestedIds: [], roots: new Map() }
    if (!Array.isArray(requested)) {
      throw new Error(
        'INVALID_HELPER_MODULES: helperModules must be an array of stable helper IDs.'
      )
    }
    if (language !== 'python' && requested.length > 0) {
      throw new Error('UNSUPPORTED_HELPER_LANGUAGE: helperModules are supported only for Python.')
    }

    const ids = [...new Set(requested)].sort()
    const roots = new Map<string, PinnedNotebookHelperModule>()
    const pinned = epoch ? this.epochs.get(epoch)?.pinned : undefined
    for (const id of ids) {
      assertHelperId(id)
      const existing = pinned?.get(id)
      if (existing) {
        roots.set(id, existing)
        continue
      }
      roots.set(
        id,
        pinDescriptor(
          id,
          await this.catalog.resolve(id),
          `UNKNOWN_HELPER_MODULE: no registered helper has ID "${id}".`
        )
      )
    }
    return { language, requestedIds: ids, roots }
  }

  async plan(
    epoch: NotebookKernelEpochOwnership,
    request: NotebookHelperModuleRequest
  ): Promise<NotebookHelperModulePlan> {
    const state = this.epochs.get(epoch) ?? { pinned: new Map(), loaded: new Set() }
    this.epochs.set(epoch, state)

    // Fix roots before following even one dependency. An active epoch ignores a compatible catalog
    // replacement and continues to use its first registered generation.
    for (const id of request.requestedIds) {
      if (!state.pinned.has(id)) {
        state.pinned.set(id, request.roots.get(id) as PinnedNotebookHelperModule)
      }
    }

    const ordered: PinnedNotebookHelperModule[] = []
    const visited = new Set<string>()
    const visiting: string[] = []
    const visit = async (id: string, parent?: string): Promise<void> => {
      if (visited.has(id)) return
      const cycleAt = visiting.indexOf(id)
      if (cycleAt >= 0) {
        throw new Error(`HELPER_DEPENDENCY_CYCLE: ${[...visiting.slice(cycleAt), id].join(' -> ')}`)
      }
      let descriptor = state.pinned.get(id)
      if (!descriptor) {
        descriptor = pinDescriptor(
          id,
          await this.catalog.resolve(id),
          `MISSING_HELPER_DEPENDENCY: helper "${parent ?? id}" requires "${id}".`
        )
        // Fix a dependency before following any of its own dependency edges.
        state.pinned.set(id, descriptor)
      }
      visiting.push(id)
      for (const dependency of descriptor.dependencies) await visit(dependency, id)
      visiting.pop()
      visited.add(id)
      ordered.push(descriptor)
    }
    for (const id of request.requestedIds) await visit(id)

    const roots = new Set<string>()
    for (const helper of state.pinned.values()) {
      if (helper.generationRoot) roots.add(helper.generationRoot)
    }
    const injections = ordered
      .filter(({ id }) => !state.loaded.has(id))
      .map((helper) => ({
        id: helper.id,
        language: helper.language,
        exports: helper.exports,
        digest: helper.digest,
        registeredGeneration: helper.registeredGeneration,
        epochId: epoch.id,
        code: injectionCode(
          helper,
          helper.dependencies.flatMap((dependency) => state.pinned.get(dependency)?.exports ?? [])
        )
      }))
    return { injections, protectedGenerationRoots: [...roots].sort() }
  }

  commitInitialized(epoch: NotebookKernelEpochOwnership, ids: readonly string[]): void {
    const state = this.epochs.get(epoch)
    if (!state) return
    for (const id of ids) {
      if (state.pinned.has(id)) state.loaded.add(id)
    }
  }
}

export { NotebookHelperModuleHost }
export type {
  NotebookHelperModuleCatalog,
  NotebookHelperModuleInjection,
  NotebookHelperModulePlan,
  NotebookHelperModuleRequest,
  RegisteredNotebookHelperModule
}
