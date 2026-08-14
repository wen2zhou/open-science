import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'

import { prepareSkillRuntimeEnvironment } from './agent-skill-runtime-environment'

type AgentSkillRuntimeLifecycle = Readonly<{
  sessionId: string
  agentFrameId: string
  runtimeSegmentId: string
}>

type AgentSkillRuntimeScope = Readonly<{
  kind: 'main' | 'specialist' | 'subagent'
}>

type AgentSkillRuntimeFile = Readonly<{
  path: string
  content: string | Uint8Array
  mode?: number
}>

type AgentSkillRuntimeSkillBase = Readonly<{
  id: string
  name: string
  description: string
  revision: string
}>

type AgentSkillRuntimePackageSkill = AgentSkillRuntimeSkillBase &
  Readonly<{
    kind: 'package'
    sourceDir: string
    overrides?: readonly AgentSkillRuntimeFile[]
  }>

type AgentSkillRuntimeGeneratedSkill = AgentSkillRuntimeSkillBase &
  Readonly<{
    kind: 'generated'
    files: readonly AgentSkillRuntimeFile[]
  }>

type AgentSkillRuntimeSkill = AgentSkillRuntimePackageSkill | AgentSkillRuntimeGeneratedSkill

type AgentSkillRuntimeInput = Readonly<{
  storageRoot: string
  lifecycle: AgentSkillRuntimeLifecycle
  scope: AgentSkillRuntimeScope
  skills: readonly AgentSkillRuntimeSkill[]
}>

type AgentSkillRuntimeLeaseSkill = Readonly<{
  id: string
  name: string
  description: string
  packageRoot: string
  skillDocumentPath: string
  packageRevision: string
}>

type AgentSkillRuntimeCatalog = Readonly<{
  catalogRevision: string
  projectionRoot: string
  discoveryRoot: string
  skills: readonly AgentSkillRuntimeLeaseSkill[]
}>

type AgentSkillRuntimeLease = AgentSkillRuntimeCatalog &
  Readonly<{
    cacheRoot: string
    tempRoot: string
    env: Readonly<Record<string, string>>
    release(): Promise<void>
  }>

type AgentSkillRuntimeForkInput = Readonly<{
  lifecycle: AgentSkillRuntimeLifecycle
  scope: AgentSkillRuntimeScope
}>

// Keep rebuildable Agent runtime state under the application's established runtime boundary. Data
// migration and rollback releases already treat storageRoot/runtime as non-authoritative cache/state.
const runtimeRoot = (storageRoot: string): string =>
  join(storageRoot, 'runtime', 'agent-skills', 'v1')

// Existing bundled Connector identities use underscores (for example mcp-clinical_trials), while
// user-authored Skills use hyphens. Both separators are filesystem-safe; path separators, dots,
// empty segments, and other punctuation remain rejected.
const SAFE_SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*$/

const assertSafeRuntimeFilePath = (path: string, source: 'generated' | 'override'): void => {
  const segments = path.split(/[\\/]/)
  if (
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Refusing to project an unsafe ${source} file path: ${path}`)
  }
}

const chmodProjectionTree = async (
  directory: string,
  mode: 'readonly' | 'writable'
): Promise<void> => {
  const directoryMode = mode === 'readonly' ? 0o555 : 0o755
  const applyMode = async (path: string, targetMode: number): Promise<void> => {
    try {
      await chmod(path, targetMode)
    } catch (error) {
      if (process.platform !== 'win32') throw error
    }
  }

  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) await chmodProjectionTree(child, mode)
    else {
      const metadata = await lstat(child)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Refusing to project a Skill catalog containing a non-regular file.')
      }
      const executable = (metadata.mode & 0o111) !== 0
      await applyMode(child, mode === 'readonly' ? (executable ? 0o555 : 0o444) : 0o644)
    }
  }
  await applyMode(directory, directoryMode)
}

const removeProjectionTree = async (directory: string): Promise<void> => {
  const makeDirectoriesWritable = async (path: string): Promise<void> => {
    const metadata = await lstat(path).catch(() => undefined)
    if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) return
    await chmod(path, 0o700).catch((error) => {
      if (process.platform !== 'win32') throw error
    })
    for (const entry of await readdir(path)) await makeDirectoriesWritable(join(path, entry))
  }
  await makeDirectoriesWritable(directory)
  await rm(directory, { recursive: true, force: true })
}

type CatalogTreeEntry = Readonly<{
  path: string
  kind: 'directory' | 'file'
  mode?: number
  digest?: string
}>

const catalogTreeSnapshot = async (root: string): Promise<readonly CatalogTreeEntry[]> => {
  const entries: CatalogTreeEntry[] = []
  const visit = async (path: string, relativePath: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error('Refusing to reuse a Skill catalog containing a symbolic link.')
    }
    const mode = process.platform === 'win32' ? undefined : metadata.mode & 0o7777
    if (metadata.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory', mode })
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath === '.' ? name : `${relativePath}/${name}`)
      }
      return
    }
    if (!metadata.isFile()) {
      throw new Error('Refusing to reuse a Skill catalog containing a non-regular file.')
    }
    entries.push({
      path: relativePath,
      kind: 'file',
      mode,
      digest: createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    })
  }
  await visit(root, '.')
  return entries
}

const assertCatalogMatches = async (expectedRoot: string, existingRoot: string): Promise<void> => {
  const expected = await catalogTreeSnapshot(expectedRoot)
  const existing = await catalogTreeSnapshot(existingRoot)
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error('Refusing to reuse a Skill catalog whose contents or permissions differ.')
  }
}

const writeRuntimeFiles = async (
  packageRoot: string,
  files: readonly AgentSkillRuntimeFile[]
): Promise<void> => {
  for (const file of files) {
    const target = join(packageRoot, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, file.mode === undefined ? {} : { mode: file.mode })
  }
}

const catalogRevision = (skills: AgentSkillRuntimeInput['skills']): string => {
  const entries = skills
    .map(({ kind, id, name, description, revision }) => ({
      kind,
      id,
      name,
      description,
      revision
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`
}

class AgentSkillRuntime {
  private readonly authorizedCatalogs = new WeakMap<
    object,
    Readonly<{ runtimeRoot: string; snapshot: readonly CatalogTreeEntry[] }>
  >()
  private publicationTail: Promise<void> = Promise.resolve()

  async acquire(input: AgentSkillRuntimeInput): Promise<AgentSkillRuntimeLease> {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const skill of input.skills) {
      if (!SAFE_SKILL_NAME.test(skill.id)) {
        throw new Error(`Refusing to project a Skill with an unsafe Skill id: ${skill.id}`)
      }
      if (ids.has(skill.id)) {
        throw new Error(`Refusing to project a duplicate Skill id: ${skill.id}`)
      }
      if (!SAFE_SKILL_NAME.test(skill.name)) {
        throw new Error(`Refusing to project a Skill with an unsafe Skill name: ${skill.name}`)
      }
      if (names.has(skill.name)) {
        throw new Error(`Refusing to project a duplicate Skill name: ${skill.name}`)
      }
      const runtimeFiles = skill.kind === 'generated' ? skill.files : (skill.overrides ?? [])
      for (const file of runtimeFiles) {
        assertSafeRuntimeFilePath(file.path, skill.kind === 'generated' ? 'generated' : 'override')
      }
      ids.add(skill.id)
      names.add(skill.name)
    }

    const root = runtimeRoot(input.storageRoot)
    const revision = catalogRevision(input.skills)
    const catalogRoot = join(root, 'catalogs', revision.slice('sha256:'.length))
    const discoveryRoot = join(catalogRoot, 'skills')
    const stagingRoot = join(root, 'staging', randomUUID())

    try {
      await mkdir(stagingRoot, { recursive: true })
      await mkdir(join(stagingRoot, '.claude-plugin'), { recursive: true })
      await mkdir(join(stagingRoot, 'skills'), { recursive: true })
      await writeFile(
        join(stagingRoot, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({ name: 'open-science-agent-skills' })}\n`,
        'utf8'
      )
      for (const skill of input.skills) {
        const packageRoot = join(stagingRoot, 'skills', `os-${skill.id}`)
        await mkdir(packageRoot, { recursive: true })
        if (skill.kind === 'generated') {
          await writeRuntimeFiles(packageRoot, skill.files)
        } else {
          await cp(skill.sourceDir, packageRoot, {
            recursive: true,
            force: true,
            filter: async (path) => {
              if ((await lstat(path)).isSymbolicLink()) {
                throw new Error('Refusing to project a Skill package containing a symbolic link.')
              }
              return true
            }
          })
          await writeRuntimeFiles(packageRoot, skill.overrides ?? [])
        }
        const skillDocument = await lstat(join(packageRoot, 'SKILL.md')).catch(() => undefined)
        if (!skillDocument?.isFile() || skillDocument.isSymbolicLink()) {
          throw new Error(`Refusing to project Skill "${skill.name}" without a regular SKILL.md.`)
        }
      }
      await chmodProjectionTree(stagingRoot, 'readonly')
      await this.withPublication(async () => {
        await mkdir(join(root, 'catalogs'), { recursive: true })
        try {
          await chmod(stagingRoot, 0o755)
        } catch (error) {
          if (process.platform !== 'win32') throw error
        }
        let published = false
        try {
          await rename(stagingRoot, catalogRoot)
          published = true
        } catch (error) {
          // macOS may report EACCES rather than EEXIST/ENOTEMPTY when the content-addressed,
          // read-only destination already exists. Reuse only a recursively identical catalog;
          // permission failures without a published catalog still fail closed.
          const existingCatalog = await lstat(catalogRoot).catch(() => undefined)
          if (!existingCatalog?.isDirectory() || existingCatalog.isSymbolicLink()) throw error
          try {
            await chmod(stagingRoot, 0o555)
          } catch (chmodError) {
            if (process.platform !== 'win32') throw chmodError
          }
          await assertCatalogMatches(stagingRoot, catalogRoot)
          await removeProjectionTree(stagingRoot)
        }
        if (published) {
          try {
            await chmod(catalogRoot, 0o555)
          } catch (error) {
            await removeProjectionTree(catalogRoot).catch(() => undefined)
            throw error
          }
        }
      })
    } catch (error) {
      await removeProjectionTree(stagingRoot).catch(() => undefined)
      throw error
    }

    const projectedSkills = input.skills.map((skill) => {
      const packageRoot = join(discoveryRoot, `os-${skill.id}`)
      return Object.freeze({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        packageRoot,
        skillDocumentPath: join(packageRoot, 'SKILL.md'),
        packageRevision: skill.revision
      })
    })

    const catalog = Object.freeze({
      catalogRevision: revision,
      projectionRoot: catalogRoot,
      discoveryRoot,
      skills: Object.freeze(projectedSkills)
    })
    this.authorizedCatalogs.set(catalog, {
      runtimeRoot: root,
      snapshot: await catalogTreeSnapshot(catalogRoot)
    })
    return this.fork(catalog, { lifecycle: input.lifecycle, scope: input.scope })
  }

  async fork(
    catalog: AgentSkillRuntimeCatalog,
    input: AgentSkillRuntimeForkInput
  ): Promise<AgentSkillRuntimeLease> {
    const authorization = this.authorizedCatalogs.get(catalog)
    if (!authorization) {
      throw new Error('Refusing to fork an Agent Skill runtime from an unauthorized catalog.')
    }
    const currentSnapshot = await catalogTreeSnapshot(catalog.projectionRoot)
    if (JSON.stringify(currentSnapshot) !== JSON.stringify(authorization.snapshot)) {
      throw new Error('Refusing to fork an Agent Skill runtime from a modified catalog.')
    }

    const ownerId = randomUUID()
    const leasesRoot = join(authorization.runtimeRoot, 'leases')
    const leaseRoot = join(leasesRoot, ownerId)
    try {
      await mkdir(leasesRoot, { recursive: true })
      await mkdir(leaseRoot)
      const environment = await prepareSkillRuntimeEnvironment(leaseRoot)
      await writeFile(
        join(leaseRoot, 'owner.json'),
        `${JSON.stringify({
          version: 1,
          ownerId,
          lifecycle: input.lifecycle,
          scope: input.scope,
          catalogRevision: catalog.catalogRevision
        })}\n`,
        'utf8'
      )

      let released = false
      let releaseInFlight: Promise<void> | undefined
      const lease = Object.freeze({
        ...catalog,
        cacheRoot: environment.env.XDG_CACHE_HOME!,
        tempRoot: environment.env.TMPDIR!,
        env: environment.env,
        release: (): Promise<void> => {
          if (released) return Promise.resolve()
          if (releaseInFlight) return releaseInFlight
          releaseInFlight = removeProjectionTree(leaseRoot)
            .then(() => {
              released = true
            })
            .finally(() => {
              releaseInFlight = undefined
            })
          return releaseInFlight
        }
      })
      this.authorizedCatalogs.set(lease, authorization)
      return lease
    } catch (error) {
      await removeProjectionTree(leaseRoot).catch(() => undefined)
      throw error
    }
  }

  private async withPublication<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.publicationTail
    let release!: () => void
    this.publicationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export { AgentSkillRuntime }
export type {
  AgentSkillRuntimeInput,
  AgentSkillRuntimeCatalog,
  AgentSkillRuntimeForkInput,
  AgentSkillRuntimeLease,
  AgentSkillRuntimeLeaseSkill,
  AgentSkillRuntimeLifecycle,
  AgentSkillRuntimeFile,
  AgentSkillRuntimeGeneratedSkill,
  AgentSkillRuntimePackageSkill,
  AgentSkillRuntimeSkill,
  AgentSkillRuntimeScope
}
