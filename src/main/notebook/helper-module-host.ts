import type { ExecuteNotebookCodeRequest, NotebookLanguage } from '../../shared/notebook'

const HELPER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type RegisteredNotebookHelperModule = Readonly<{
  id: string
  language: 'python'
  source: string
  exports: readonly string[]
  dependencies?: readonly string[]
  skillId?: string
  origin?: 'builtin' | 'personal' | 'imported'
  interfaceRevision?: number
  generation?: string
  digest?: string
}>

type NotebookHelperModuleCatalog = {
  resolve(
    id: string,
    scope?: Readonly<{
      projectId?: string
      sessionId?: string
      allowedSkillIds?: readonly string[]
    }>
  ): Promise<RegisteredNotebookHelperModule | undefined>
  protectedDirectories?(): readonly string[]
}

type NotebookHelperModuleInjection = Readonly<{
  id: string
  language: 'python'
  exports: readonly string[]
  code: string
  dependencies?: readonly string[]
  skillId?: string
  origin?: 'builtin' | 'personal' | 'imported'
  interfaceRevision?: number
  generation?: string
  digest?: string
}>

const emptyCatalog: NotebookHelperModuleCatalog = { resolve: async () => undefined }

const injectionCode = (helper: RegisteredNotebookHelperModule): string => {
  const filename = `<open-science-helper:${helper.id}>`
  const body = [
    `__os_private = {"__builtins__": __builtins__}`,
    `exec(compile(${JSON.stringify(helper.source)}, ${JSON.stringify(filename)}, "exec"), __os_private, __os_private)`,
    `__os_names = ${JSON.stringify([...helper.exports])}`,
    `__os_missing = [name for name in __os_names if name not in __os_private or not callable(__os_private[name])]`,
    `if __os_missing:`,
    `    raise RuntimeError("missing or non-callable exports: " + ", ".join(__os_missing))`,
    `__os_target = __os_target_globals`,
    `__os_collisions = [name for name in __os_names if name in __os_target]`,
    `if __os_collisions:`,
    `    raise RuntimeError("export collision: " + ", ".join(__os_collisions))`,
    `__os_staged = {name: __os_private[name] for name in __os_names}`,
    `__os_target.update(__os_staged)`
  ].join('\n')

  // The Agent namespace evaluates only this expression. Loader names, imports, constants, and
  // implementation globals remain in a private mapping; update() is the sole publication point.
  return `exec(compile(${JSON.stringify(body)}, ${JSON.stringify(filename)}, "exec"), {"__builtins__": __builtins__, "__os_target_globals": globals()})`
}

class NotebookHelperModuleHost {
  constructor(private readonly catalog: NotebookHelperModuleCatalog = emptyCatalog) {}

  protectedDirectories(): readonly string[] {
    return this.catalog.protectedDirectories?.() ?? []
  }

  resolveRequest(
    request: ExecuteNotebookCodeRequest
  ): Promise<readonly NotebookHelperModuleInjection[]> {
    const trustedSkillIds = request.executionInvocationId
      ? request.registeredHelperSkillIds
      : undefined
    return this.resolve(request.language ?? 'python', request.helperModules, {
      projectId: request.projectId,
      sessionId: request.sessionId,
      ...(trustedSkillIds ? { allowedSkillIds: trustedSkillIds } : {})
    })
  }

  async resolve(
    language: NotebookLanguage,
    requested: readonly string[] | undefined,
    scope?: Readonly<{
      projectId?: string
      sessionId?: string
      allowedSkillIds?: readonly string[]
    }>
  ): Promise<readonly NotebookHelperModuleInjection[]> {
    if (requested === undefined) return []
    if (!Array.isArray(requested)) {
      throw new Error(
        'INVALID_HELPER_MODULES: helperModules must be an array of stable helper IDs.'
      )
    }
    if (language !== 'python' && requested.length > 0) {
      throw new Error('UNSUPPORTED_HELPER_LANGUAGE: helperModules are supported only for Python.')
    }

    const ids = [...new Set(requested)]
    const resolved: NotebookHelperModuleInjection[] = []
    for (const id of ids) {
      if (typeof id !== 'string' || id.length > 128 || !HELPER_ID.test(id)) {
        throw new Error('INVALID_HELPER_ID: helperModules accepts only stable helper IDs.')
      }
      const helper = await this.catalog.resolve(id, scope)
      if (!helper || helper.id !== id) {
        throw new Error(`UNKNOWN_HELPER_MODULE: no registered helper has ID "${id}".`)
      }
      if (helper.language !== 'python') {
        throw new Error(`UNSUPPORTED_HELPER_LANGUAGE: helper "${id}" is not a Python helper.`)
      }
      resolved.push({
        id,
        language: 'python',
        exports: [...helper.exports],
        code: injectionCode(helper),
        ...(helper.dependencies ? { dependencies: [...helper.dependencies] } : {}),
        ...(helper.skillId ? { skillId: helper.skillId } : {}),
        ...(helper.origin ? { origin: helper.origin } : {}),
        ...(helper.interfaceRevision ? { interfaceRevision: helper.interfaceRevision } : {}),
        ...(helper.generation ? { generation: helper.generation } : {}),
        ...(helper.digest ? { digest: helper.digest } : {})
      })
    }
    return resolved
  }
}

export { NotebookHelperModuleHost }
export type {
  NotebookHelperModuleCatalog,
  NotebookHelperModuleInjection,
  RegisteredNotebookHelperModule
}
