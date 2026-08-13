import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export interface GeneratedSkillRuntimeFile {
  path: string
  content: string | Uint8Array
  mode?: number
}
export interface PackageSkillRuntimeProjectionInput {
  kind: 'package'
  id: string
  name: string
  description: string
  source?: 'connector'
  directory: string
  revision: string
  sourceDir: string
  overrides?: readonly GeneratedSkillRuntimeFile[]
}
export interface GeneratedSkillRuntimeProjectionInput {
  kind: 'generated'
  id: string
  name: string
  description: string
  source?: 'connector'
  directory: string
  revision: string
  files: readonly GeneratedSkillRuntimeFile[]
}
export type SkillRuntimeProjectionInput =
  PackageSkillRuntimeProjectionInput | GeneratedSkillRuntimeProjectionInput
export interface SkillRuntimeCatalogSnapshot {
  inputs: readonly SkillRuntimeProjectionInput[]
}
export interface SkillRuntimeDescriptor {
  id: string
  name: string
  description: string
  path: string
  source?: 'connector'
}
export interface ProjectionGeneration {
  generationId: string
  root: string
  skillsRoot: string
  descriptors: readonly SkillRuntimeDescriptor[]
}
export interface SkillRuntimeBinding extends ProjectionGeneration {
  discoveryRoot: string
  release(): Promise<void>
}
export interface SkillRuntimeBindingScope {
  allowedSkillIds?: readonly string[]
  invocationNameCollisionPolicy?: 'reject' | 'omit-ambiguous'
  preferredSkillIds?: readonly string[]
}
export type SkillRuntimeBindingPolicy =
  | Readonly<{ kind: 'main'; forcedSkillIds?: readonly string[] }>
  | Readonly<{ kind: 'exact'; allowedSkillIds: readonly string[] }>
  | Readonly<{ kind: 'none' }>
export interface SkillRuntimeProjectionOwnerOptions {
  storageRoot: string
  nextGenerationId?: () => string
}

interface ManifestFile {
  path: string
  sha256: string
  executable: boolean
}
interface ManifestSkill {
  id: string
  name: string
  description: string
  source?: 'connector'
  directory: string
  revision: string
  files: ManifestFile[]
}
interface ProjectionManifest {
  schemaVersion: 1
  generationId: string
  skills: ManifestSkill[]
}
const MANIFEST_FILE = '.projection.json'
const CURRENT_FILE = '.current.json'
const CANDIDATE_PREFIX = '.candidate-'
const digest = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex')
const canonicalName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US')
const assertSingleSegment = (value: string, label: string): void => {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    basename(value) !== value
  )
    throw new Error(`${label} must be a single safe path segment`)
}
const assertRelativeFilePath = (value: string): void => {
  const segments = value.split(/[\\/]/)
  if (
    !value ||
    isAbsolute(value) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error(`Skill file must use a non-escaping relative path: ${value}`)
}
const isWithin = (root: string, target: string): boolean => {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}
const assertNoCanonicalCollisions = (values: readonly string[], label: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    const key = canonicalName(value)
    if (seen.has(key)) throw new Error(`${label} collision: ${value}`)
    seen.add(key)
  }
}
const makeWritable = async (path: string): Promise<void> => {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    await chmod(path, 0o755)
    for (const name of await readdir(path)) await makeWritable(join(path, name))
  } else await chmod(path, metadata.mode | 0o600)
}
const removeOwnedTree = async (path: string): Promise<void> => {
  await makeWritable(path)
  await rm(path, { recursive: true, force: true })
}
const childDirectories = async (root: string): Promise<string[]> =>
  (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))

export class SkillRuntimeProjectionOwner {
  private readonly storageRoot: string
  private readonly generationsRoot: string
  private readonly discoveryRoot: string
  private readonly nextGenerationId: () => string
  private readonly leases = new Map<string, number>()
  private readonly activeDiscoveryRoots = new Set<string>()
  private operation: Promise<void> = Promise.resolve()
  constructor(options: SkillRuntimeProjectionOwnerOptions) {
    this.storageRoot = options.storageRoot
    this.generationsRoot = join(options.storageRoot, 'generations')
    this.discoveryRoot = join(options.storageRoot, 'discovery')
    this.nextGenerationId = options.nextGenerationId ?? randomUUID
  }

  publish(snapshot: SkillRuntimeCatalogSnapshot): Promise<ProjectionGeneration> {
    return this.exclusive(async () => {
      this.validateInputs(snapshot.inputs)
      await this.ensureStorage()
      const currentId = await this.readOrRecoverCurrentGenerationId()
      if (currentId) {
        const currentRoot = join(this.generationsRoot, currentId)
        try {
          const manifest = await this.validateGeneration(currentRoot, currentId)
          if (this.matchesSnapshot(manifest, snapshot.inputs))
            return this.generationFromManifest(currentRoot, manifest)
        } catch {
          /* rebuild damaged generation */
        }
      }
      const generationId = this.nextGenerationId()
      assertSingleSegment(generationId, 'Generation id')
      const candidateRoot = join(this.storageRoot, `${CANDIDATE_PREFIX}${generationId}`)
      const finalRoot = join(this.generationsRoot, generationId)
      const skillsRoot = join(candidateRoot, 'skills')
      if (!isWithin(this.storageRoot, candidateRoot) || !isWithin(this.generationsRoot, finalRoot))
        throw new Error('Generation path escapes Skill Runtime Projection storage')
      try {
        await mkdir(candidateRoot)
        await mkdir(skillsRoot)
        const skills: ManifestSkill[] = []
        for (const input of snapshot.inputs)
          skills.push(await this.materializeInput(skillsRoot, input))
        const manifest: ProjectionManifest = { schemaVersion: 1, generationId, skills }
        await writeFile(
          join(candidateRoot, MANIFEST_FILE),
          JSON.stringify(manifest, null, 2),
          'utf8'
        )
        await mkdir(join(candidateRoot, '.claude-plugin'))
        await writeFile(
          join(candidateRoot, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: `open-science-skills-${generationId}`, version: '1.0.0' }),
          'utf8'
        )
        await this.validateGeneration(candidateRoot, generationId, false)
        // Seal the candidate before it becomes a recoverable generation. A crash or chmod failure
        // can then leave only a disposable `.candidate-*` tree, never a writable generation that a
        // restarted owner could adopt as the current immutable snapshot.
        await this.makeImmutable(candidateRoot)
        // macOS requires the moved directory itself to remain writable during rename. Its contents
        // are already sealed; recovery rejects the briefly writable root until the final chmod below.
        await chmod(candidateRoot, 0o755)
        await rename(candidateRoot, finalRoot)
        await chmod(finalRoot, 0o555)
        await this.validateGeneration(finalRoot, generationId)
        await this.publishPointer(generationId)
        await this.collectSuperseded(generationId)
        return this.generationFromManifest(finalRoot, manifest)
      } catch (error) {
        await removeOwnedTree(candidateRoot).catch(() => undefined)
        throw error
      }
    })
  }

  acquire(scope: SkillRuntimeBindingScope = {}): Promise<SkillRuntimeBinding> {
    return this.exclusive(async () => {
      const generationId = await this.readCurrentGenerationId()
      if (!generationId) throw new Error('No Skill Runtime Projection has been published')
      const root = join(this.generationsRoot, generationId)
      const manifest = await this.validateGeneration(root, generationId)
      const generation = this.generationFromManifest(root, manifest, scope)
      const discoveryRoot = await this.createDiscoveryRoot(generation, manifest)
      this.leases.set(generationId, (this.leases.get(generationId) ?? 0) + 1)
      let releaseCompleted = false
      let releaseOperation: Promise<void> | undefined
      let generationLeaseReleased = false
      return {
        ...generation,
        discoveryRoot,
        release: () => {
          if (releaseCompleted) return Promise.resolve()
          releaseOperation ??= this.exclusive(async () => {
            let cleanupFailure: unknown
            try {
              await removeOwnedTree(discoveryRoot)
            } catch (error) {
              cleanupFailure = error
            } finally {
              this.activeDiscoveryRoots.delete(discoveryRoot)
            }
            try {
              if (!generationLeaseReleased) {
                generationLeaseReleased = true
                const count = Math.max(0, (this.leases.get(generationId) ?? 1) - 1)
                if (count === 0) this.leases.delete(generationId)
                else this.leases.set(generationId, count)
              }
              await this.collectSuperseded(await this.readOrRecoverCurrentGenerationId())
            } catch (error) {
              cleanupFailure ??= error
            }
            if (cleanupFailure) throw cleanupFailure
            releaseCompleted = true
          }).catch((error) => {
            releaseOperation = undefined
            throw error
          })
          return releaseOperation
        }
      }
    })
  }
  reconcile(): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureStorage()
      for (const entry of await readdir(this.storageRoot, { withFileTypes: true }))
        if (
          entry.name.startsWith(CANDIDATE_PREFIX) ||
          (entry.name.startsWith('.current-') && entry.name.endsWith('.tmp'))
        )
          await removeOwnedTree(join(this.storageRoot, entry.name))
      for (const path of await childDirectories(this.discoveryRoot))
        if (!this.activeDiscoveryRoots.has(path)) await removeOwnedTree(path)
      await this.collectSuperseded(await this.readOrRecoverCurrentGenerationId())
    })
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private async ensureStorage(): Promise<void> {
    await mkdir(this.storageRoot, { recursive: true })
    await mkdir(this.generationsRoot, { recursive: true })
    await mkdir(this.discoveryRoot, { recursive: true })
  }
  private async createDiscoveryRoot(
    generation: ProjectionGeneration,
    manifest: ProjectionManifest
  ): Promise<string> {
    const root = join(this.discoveryRoot, randomUUID())
    await mkdir(root)
    const allowed = new Set(generation.descriptors.map((descriptor) => descriptor.id))
    try {
      for (const skill of manifest.skills) {
        if (!allowed.has(skill.id)) continue
        const source = join(generation.skillsRoot, skill.directory)
        const target = join(root, skill.directory)
        await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      }
      await chmod(root, 0o555)
      this.activeDiscoveryRoots.add(root)
      return root
    } catch (error) {
      await removeOwnedTree(root).catch(() => undefined)
      throw error
    }
  }
  private validateInputs(inputs: readonly SkillRuntimeProjectionInput[]): void {
    assertNoCanonicalCollisions(
      inputs.map((input) => input.id),
      'Skill id'
    )
    assertNoCanonicalCollisions(
      inputs.map((input) => input.directory),
      'Skill directory'
    )
    for (const input of inputs) {
      if (!input.id || !input.name || !input.description || !input.revision)
        throw new Error('Projected Skills require id, name, description, and revision')
      assertSingleSegment(input.directory, 'Skill directory')
      const generated = input.kind === 'generated' ? input.files : input.overrides
      if (generated) {
        assertNoCanonicalCollisions(
          generated.map((file) => file.path),
          input.kind === 'generated' ? 'Generated file path' : 'Package override path'
        )
        for (const file of generated) assertRelativeFilePath(file.path)
      }
      if (input.kind === 'generated' && !input.files.some((file) => file.path === 'SKILL.md'))
        throw new Error(`Generated Skill ${input.id} is missing SKILL.md`)
    }
  }
  private matchesSnapshot(
    manifest: ProjectionManifest,
    inputs: readonly SkillRuntimeProjectionInput[]
  ): boolean {
    return (
      manifest.skills.length === inputs.length &&
      manifest.skills.every((skill, index) => {
        const input = inputs[index]
        return (
          input !== undefined &&
          skill.id === input.id &&
          skill.name === input.name &&
          skill.description === input.description &&
          skill.source === input.source &&
          skill.directory === input.directory &&
          skill.revision === input.revision
        )
      })
    )
  }
  private async materializeInput(
    skillsRoot: string,
    input: SkillRuntimeProjectionInput
  ): Promise<ManifestSkill> {
    const target = join(skillsRoot, input.directory)
    await mkdir(target)
    const files: ManifestFile[] = []
    if (input.kind === 'package') {
      const metadata = await lstat(input.sourceDir)
      if (metadata.isSymbolicLink()) throw new Error(`Skill ${input.id} source is a symbolic link`)
      if (!metadata.isDirectory()) throw new Error(`Skill ${input.id} source is not a directory`)
      await this.copyPackageDirectory(input.sourceDir, target, '', files)
      if (input.overrides) await this.writeGeneratedFiles(target, input.overrides, files)
    } else await this.writeGeneratedFiles(target, input.files, files)
    files.sort((left, right) => left.path.localeCompare(right.path))
    if (!files.some((file) => file.path === 'SKILL.md'))
      throw new Error(`Skill ${input.id} is missing SKILL.md`)
    return {
      id: input.id,
      name: input.name,
      description: input.description,
      ...(input.source ? { source: input.source } : {}),
      directory: input.directory,
      revision: input.revision,
      files
    }
  }
  private async writeGeneratedFiles(
    target: string,
    generated: readonly GeneratedSkillRuntimeFile[],
    files: ManifestFile[]
  ): Promise<void> {
    for (const file of generated) {
      const normalized = file.path.replaceAll('\\', '/')
      const existing = files.find(
        (candidate) => canonicalName(candidate.path) === canonicalName(normalized)
      )
      if (existing && existing.path !== normalized)
        throw new Error(`Generated file path collision: ${file.path}`)
      const destination = join(target, ...normalized.split('/'))
      if (!isWithin(target, destination))
        throw new Error(`Generated relative path escapes Skill: ${file.path}`)
      const bytes =
        typeof file.content === 'string' ? Buffer.from(file.content) : Buffer.from(file.content)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { mode: file.mode ?? 0o644 })
      const record = {
        path: normalized,
        sha256: digest(bytes),
        executable: ((file.mode ?? 0) & 0o111) !== 0
      }
      if (existing) files.splice(files.indexOf(existing), 1, record)
      else files.push(record)
    }
  }
  private async copyPackageDirectory(
    source: string,
    destination: string,
    relativeDirectory: string,
    files: ManifestFile[]
  ): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true })
    assertNoCanonicalCollisions(
      entries.map((entry) => entry.name),
      `Package entry in ${relativeDirectory || '.'}`
    )
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = join(source, entry.name)
      const metadata = await lstat(sourcePath)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const destinationPath = join(destination, entry.name)
      if (metadata.isSymbolicLink())
        throw new Error(`Skill package contains symbolic link: ${relativePath}`)
      if (metadata.isDirectory()) {
        await mkdir(destinationPath)
        await this.copyPackageDirectory(sourcePath, destinationPath, relativePath, files)
      } else if (metadata.isFile()) {
        if (metadata.nlink > 1) throw new Error(`Skill package contains hard link: ${relativePath}`)
        const bytes = await readFile(sourcePath)
        const executable = (metadata.mode & 0o111) !== 0
        await writeFile(destinationPath, bytes, { mode: executable ? 0o755 : 0o644 })
        files.push({ path: relativePath, sha256: digest(bytes), executable })
      } else throw new Error(`Skill package contains unsupported filesystem entry: ${relativePath}`)
    }
  }
  private async makeImmutable(root: string): Promise<void> {
    const metadata = await lstat(root)
    if (metadata.isDirectory()) {
      for (const name of await readdir(root)) await this.makeImmutable(join(root, name))
      await chmod(root, 0o555)
    } else await chmod(root, (metadata.mode & 0o111) !== 0 ? 0o555 : 0o444)
  }
  private async publishPointer(generationId: string): Promise<void> {
    const temporary = join(this.storageRoot, `.current-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ generationId }), 'utf8')
    await rename(temporary, join(this.storageRoot, CURRENT_FILE))
  }
  private async readOrRecoverCurrentGenerationId(): Promise<string | undefined> {
    try {
      const current = await this.readCurrentGenerationId()
      if (current) {
        await this.validateGeneration(join(this.generationsRoot, current), current)
        return current
      }
    } catch {
      /* recover the newest complete immutable generation below */
    }

    let recovered: { id: string; modifiedAt: number } | undefined
    for (const entry of await readdir(this.generationsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const root = join(this.generationsRoot, entry.name)
      try {
        await this.validateGeneration(root, entry.name)
        const modifiedAt = (await lstat(root)).mtimeMs
        if (!recovered || modifiedAt > recovered.modifiedAt) {
          recovered = { id: entry.name, modifiedAt }
        }
      } catch {
        /* invalid generations are removed by collectSuperseded */
      }
    }
    if (recovered) await this.publishPointer(recovered.id)
    else await rm(join(this.storageRoot, CURRENT_FILE), { force: true })
    return recovered?.id
  }
  private async readCurrentGenerationId(): Promise<string | undefined> {
    let parsed: { generationId: string }
    try {
      parsed = JSON.parse(await readFile(join(this.storageRoot, CURRENT_FILE), 'utf8')) as {
        generationId: string
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Skill Runtime Projection current pointer is invalid', { cause: error })
    }
    assertSingleSegment(parsed.generationId, 'Current generation id')
    return parsed.generationId
  }
  private async validateGeneration(
    root: string,
    expectedId: string,
    requireImmutable = true
  ): Promise<ProjectionManifest> {
    const assertImmutableMode = (metadata: { mode: number }, label: string): void => {
      if (requireImmutable && process.platform !== 'win32' && (metadata.mode & 0o222) !== 0)
        throw new Error(`Skill Runtime Projection ${label} is writable`)
    }
    const rootMetadata = await lstat(root)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
      throw new Error('Skill Runtime Projection root is invalid')
    assertImmutableMode(rootMetadata, 'root')
    const manifestMetadata = await lstat(join(root, MANIFEST_FILE))
    if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile())
      throw new Error('Skill Runtime Projection manifest is not a regular file')
    assertImmutableMode(manifestMetadata, 'manifest')
    const manifest = JSON.parse(
      await readFile(join(root, MANIFEST_FILE), 'utf8')
    ) as ProjectionManifest
    if (
      manifest.schemaVersion !== 1 ||
      manifest.generationId !== expectedId ||
      !Array.isArray(manifest.skills)
    )
      throw new Error('Skill Runtime Projection manifest is invalid')
    const pluginPath = join(root, '.claude-plugin', 'plugin.json')
    const pluginDirectoryMetadata = await lstat(dirname(pluginPath))
    if (!pluginDirectoryMetadata.isDirectory() || pluginDirectoryMetadata.isSymbolicLink())
      throw new Error('Skill Runtime Projection Claude plugin directory is invalid')
    assertImmutableMode(pluginDirectoryMetadata, 'Claude plugin directory')
    const pluginMetadata = await lstat(pluginPath)
    if (pluginMetadata.isSymbolicLink() || !pluginMetadata.isFile())
      throw new Error('Skill Runtime Projection Claude plugin manifest is not a regular file')
    assertImmutableMode(pluginMetadata, 'Claude plugin manifest')
    const plugin = JSON.parse(await readFile(pluginPath, 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (plugin.name !== `open-science-skills-${expectedId}` || plugin.version !== '1.0.0')
      throw new Error('Skill Runtime Projection Claude plugin manifest is invalid')
    assertNoCanonicalCollisions(
      manifest.skills.map((skill) => skill.directory),
      'Manifest Skill directory'
    )
    assertNoCanonicalCollisions(
      manifest.skills.map((skill) => skill.id),
      'Manifest Skill id'
    )
    const skillsRoot = join(root, 'skills')
    const skillsRootMetadata = await lstat(skillsRoot)
    if (!skillsRootMetadata.isDirectory() || skillsRootMetadata.isSymbolicLink())
      throw new Error('Skill Runtime Projection Skills root is invalid')
    assertImmutableMode(skillsRootMetadata, 'Skills root')
    for (const skill of manifest.skills) {
      if (
        typeof skill.id !== 'string' ||
        typeof skill.name !== 'string' ||
        typeof skill.description !== 'string' ||
        (skill.source !== undefined && skill.source !== 'connector') ||
        typeof skill.revision !== 'string' ||
        !Array.isArray(skill.files)
      )
        throw new Error('Skill Runtime Projection manifest Skill is invalid')
      assertSingleSegment(skill.directory, 'Manifest Skill directory')
      if (!skill.files.some((file) => file.path === 'SKILL.md'))
        throw new Error(`Skill Runtime Projection Skill ${skill.id} is missing SKILL.md`)
      const expected = new Set(skill.files.map((file) => canonicalName(file.path)))
      const actual = await this.inspectProjectedTree(
        join(skillsRoot, skill.directory),
        '',
        requireImmutable
      )
      if (
        actual.length !== expected.size ||
        actual.some((file) => !expected.has(canonicalName(file)))
      )
        throw new Error(
          `Skill Runtime Projection contains unexpected or missing files: ${skill.id}`
        )
      for (const file of skill.files) {
        assertRelativeFilePath(file.path)
        const path = join(skillsRoot, skill.directory, ...file.path.split('/'))
        const metadata = await lstat(path)
        if (
          !isWithin(skillsRoot, path) ||
          metadata.isSymbolicLink() ||
          !metadata.isFile() ||
          metadata.nlink > 1
        )
          throw new Error(`Skill Runtime Projection file is unsafe: ${file.path}`)
        assertImmutableMode(metadata, `file ${file.path}`)
        if (((metadata.mode & 0o111) !== 0) !== file.executable)
          throw new Error(`Skill Runtime Projection executable mode changed: ${file.path}`)
        if (digest(await readFile(path)) !== file.sha256)
          throw new Error(`Skill Runtime Projection integrity check failed: ${file.path}`)
      }
    }
    return manifest
  }
  private async inspectProjectedTree(
    root: string,
    relativeDirectory: string,
    requireImmutable: boolean
  ): Promise<string[]> {
    const rootMetadata = await lstat(root)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
      throw new Error(`Skill Runtime Projection directory is unsafe: ${relativeDirectory || '.'}`)
    if (requireImmutable && process.platform !== 'win32' && (rootMetadata.mode & 0o222) !== 0)
      throw new Error(`Skill Runtime Projection directory is writable: ${relativeDirectory || '.'}`)
    const entries = await readdir(root, { withFileTypes: true })
    assertNoCanonicalCollisions(
      entries.map((entry) => entry.name),
      `Projected entry in ${relativeDirectory || '.'}`
    )
    const files: string[] = []
    for (const entry of entries) {
      const path = join(root, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink())
        throw new Error(`Skill Runtime Projection contains unsafe symbolic link: ${relativePath}`)
      if (metadata.isDirectory())
        files.push(...(await this.inspectProjectedTree(path, relativePath, requireImmutable)))
      else if (metadata.isFile() && metadata.nlink === 1) files.push(relativePath)
      else
        throw new Error(
          `Skill Runtime Projection contains unsafe filesystem entry: ${relativePath}`
        )
    }
    return files
  }
  private generationFromManifest(
    root: string,
    manifest: ProjectionManifest,
    scope?: SkillRuntimeBindingScope
  ): ProjectionGeneration {
    const allowedSkillIds = scope?.allowedSkillIds
    const allowed = allowedSkillIds ? new Set(allowedSkillIds) : undefined
    if (allowed) {
      const projectedIds = new Set(manifest.skills.map((skill) => skill.id))
      const unavailable = [...allowed].filter((id) => !projectedIds.has(id))
      if (unavailable.length > 0) {
        throw new Error(
          `Authorized Skill is unavailable in the current projection: ${unavailable.join(', ')}`
        )
      }
    }
    const skillsRoot = join(root, 'skills')
    let selectedSkills = manifest.skills.filter((skill) => !allowed || allowed.has(skill.id))
    if (scope && scope.invocationNameCollisionPolicy !== 'omit-ambiguous') {
      assertNoCanonicalCollisions(
        selectedSkills.map((skill) => skill.name),
        'Skill invocation name'
      )
    } else if (scope) {
      const preferred = new Set(scope.preferredSkillIds ?? [])
      const groups = new Map<string, ManifestSkill[]>()
      for (const skill of selectedSkills) {
        const key = canonicalName(skill.name)
        groups.set(key, [...(groups.get(key) ?? []), skill])
      }
      selectedSkills = [...groups.values()].flatMap((group) => {
        if (group.length === 1) return group
        const preferredSkills = group.filter((skill) => preferred.has(skill.id))
        return preferredSkills.length === 1 ? preferredSkills : []
      })
    }
    return {
      generationId: manifest.generationId,
      root,
      skillsRoot,
      descriptors: selectedSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: join(skillsRoot, skill.directory, 'SKILL.md'),
        ...(skill.source ? { source: skill.source } : {})
      }))
    }
  }
  private async collectSuperseded(currentId: string | undefined): Promise<void> {
    await this.ensureStorage()
    for (const entry of await readdir(this.generationsRoot, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        entry.name !== currentId &&
        (this.leases.get(entry.name) ?? 0) === 0
      )
        await removeOwnedTree(join(this.generationsRoot, entry.name))
  }
}
