import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type { SpecialistPackageSkillPlan } from '../../shared/specialist-package'
import type { SpecialistPackageSkillPort } from '../specialist/package/skill-port'

const SAFE_SLUG = /^[a-z0-9-]+$/

export const SPECIALIST_PACKAGE_SKILL_METADATA = '.specialist-package.json'

type PackageSkillMetadata = {
  id: string
  version: string
  contentHash: string
  standalone: boolean
  ownerIds: string[]
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

const readMetadata = async (directory: string): Promise<PackageSkillMetadata | undefined> => {
  try {
    const value = JSON.parse(
      await readFile(join(directory, SPECIALIST_PACKAGE_SKILL_METADATA), 'utf8')
    ) as PackageSkillMetadata
    return value &&
      typeof value.id === 'string' &&
      typeof value.version === 'string' &&
      typeof value.contentHash === 'string' &&
      typeof value.standalone === 'boolean' &&
      Array.isArray(value.ownerIds) &&
      value.ownerIds.every((owner) => typeof owner === 'string')
      ? value
      : undefined
  } catch {
    return undefined
  }
}

const directoryHash = async (directory: string): Promise<string> => {
  const files: Array<{ path: string; bytes: Buffer }> = []
  const visit = async (current: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === SPECIALIST_PACKAGE_SKILL_METADATA || entry.name === '.source.json')
        continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(current, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1)) {
        throw new Error('Unsafe Skill filesystem entry.')
      }
      if (metadata.isDirectory()) await visit(path, relative)
      else if (metadata.isFile()) files.push({ path: relative, bytes: await readFile(path) })
    }
  }
  await visit(directory)
  const hash = createHash('sha256')
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export class UserSkillSpecialistPackageAdapter implements SpecialistPackageSkillPort {
  private readonly importedRoot: string
  private readonly transactionRoot: string

  constructor(storageRoot: string) {
    this.importedRoot = join(storageRoot, 'skills', 'imported')
    this.transactionRoot = join(storageRoot, 'specialist-package-skill-transactions')
  }

  async snapshot(): Promise<PackageSkillMetadata[]> {
    const result: PackageSkillMetadata[] = []
    for (const source of ['imported', 'personal'] as const) {
      const root = join(dirname(this.importedRoot), source)
      let entries: string[] = []
      try {
        entries = await readdir(root)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (!SAFE_SLUG.test(entry)) continue
        const directory = join(root, entry)
        const metadata = await readMetadata(directory)
        if (metadata) result.push(metadata)
        else {
          try {
            result.push({
              id: `${source}-${entry}`,
              version: '0.1.0',
              contentHash: await directoryHash(directory),
              standalone: true,
              ownerIds: []
            })
          } catch {
            // Invalid existing Skills remain visible through the ordinary catalog but cannot be reused.
          }
        }
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id))
  }

  async exportSnapshot(skillIds: readonly string[]): Promise<
    Array<{
      id: string
      version: string
      contentHash: string
      files: Array<{ path: string; bytes: Uint8Array }>
    }>
  > {
    const requested = new Set(skillIds)
    const result: Array<{
      id: string
      version: string
      contentHash: string
      files: Array<{ path: string; bytes: Uint8Array }>
    }> = []
    for (const source of ['imported', 'personal'] as const) {
      const root = join(dirname(this.importedRoot), source)
      let entries: string[] = []
      try {
        entries = await readdir(root)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (!SAFE_SLUG.test(entry)) continue
        const directory = join(root, entry)
        const beforeMetadata = await readMetadata(directory)
        const id = beforeMetadata?.id ?? `${source}-${entry}`
        if (!requested.has(id)) continue
        const beforeHash = await directoryHash(directory)
        const files: Array<{ path: string; bytes: Uint8Array }> = []
        const visit = async (current: string, prefix = ''): Promise<void> => {
          for (const child of (await readdir(current, { withFileTypes: true })).sort(
            (left, right) => left.name.localeCompare(right.name)
          )) {
            if (child.name === SPECIALIST_PACKAGE_SKILL_METADATA || child.name === '.source.json') {
              continue
            }
            const relative = prefix ? `${prefix}/${child.name}` : child.name
            const absolute = join(current, child.name)
            const metadata = await lstat(absolute)
            if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1)) {
              throw new Error('Unsafe Skill filesystem entry.')
            }
            if (metadata.isDirectory()) await visit(absolute, relative)
            else if (metadata.isFile()) {
              files.push({ path: relative, bytes: new Uint8Array(await readFile(absolute)) })
            }
          }
        }
        await visit(directory)
        files.sort((left, right) => left.path.localeCompare(right.path))
        const afterHash = await directoryHash(directory)
        const afterMetadata = await readMetadata(directory)
        if (
          beforeHash !== afterHash ||
          JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)
        ) {
          throw new Error('Skill changed during export. Preview again and retry.')
        }
        result.push({
          id,
          version: beforeMetadata?.version ?? '0.1.0',
          contentHash: afterHash,
          files
        })
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id))
  }

  async prepare(
    transactionId: string,
    specialistId: string,
    skills: readonly SpecialistPackageSkillPlan[]
  ): Promise<void> {
    if (!SAFE_SLUG.test(transactionId) || !SAFE_SLUG.test(specialistId)) {
      throw new Error('Invalid package transaction identity.')
    }
    const root = this.transactionDir(transactionId)
    await rm(root, { recursive: true, force: true })
    try {
      await mkdir(root, { recursive: true })
      await writeFile(
        join(root, 'transaction.json'),
        `${JSON.stringify({ skillIds: skills.map((skill) => skill.id).sort() })}\n`,
        { flag: 'wx' }
      )
      for (const skill of skills) {
        if (!SAFE_SLUG.test(skill.id)) throw new Error('Invalid bundled Skill ID.')
        const staging = join(root, 'staging', skill.id)
        const stagingRoot = resolve(staging)
        await mkdir(staging, { recursive: true })
        for (const file of skill.filesToInstall) {
          const target = resolve(staging, file.path)
          if (
            target === stagingRoot ||
            !target.startsWith(stagingRoot + sep) ||
            file.path === SPECIALIST_PACKAGE_SKILL_METADATA
          ) {
            throw new Error('Unsafe bundled Skill path.')
          }
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, file.bytes, { flag: 'wx' })
        }
        const existing = await readMetadata(join(this.importedRoot, skill.id))
        const ownerIds = [...new Set([...(existing?.ownerIds ?? []), specialistId])].sort()
        const metadata: PackageSkillMetadata = {
          id: skill.id,
          version: skill.version,
          contentHash: skill.contentHash,
          standalone: existing?.standalone ?? false,
          ownerIds
        }
        await writeFile(
          join(staging, SPECIALIST_PACKAGE_SKILL_METADATA),
          `${JSON.stringify(metadata)}\n`,
          { flag: 'wx' }
        )
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async commit(transactionId: string): Promise<void> {
    const root = this.transactionDir(transactionId)
    const stagingRoot = join(root, 'staging')
    let ids: string[] = []
    try {
      ids = (await readdir(stagingRoot)).filter((id) => SAFE_SLUG.test(id)).sort()
    } catch {
      return
    }
    await mkdir(this.importedRoot, { recursive: true })
    await mkdir(join(root, 'backup'), { recursive: true })
    for (const id of ids) {
      const live = join(this.importedRoot, id)
      const backup = join(root, 'backup', id)
      const staging = join(stagingRoot, id)
      if (await exists(live)) await rename(live, backup)
      await rename(staging, live)
    }
  }

  async rollback(transactionId: string): Promise<void> {
    await this.recover(transactionId, 'rollback')
  }

  async recover(transactionId: string | undefined, outcome: 'commit' | 'rollback'): Promise<void> {
    if (transactionId === undefined) {
      let transactions: string[] = []
      try {
        transactions = await readdir(this.transactionRoot)
      } catch {
        return
      }
      for (const id of transactions.filter((entry) => SAFE_SLUG.test(entry))) {
        await this.recover(id, 'rollback')
      }
      return
    }
    const root = this.transactionDir(transactionId)
    const stagingRoot = join(root, 'staging')
    const backupRoot = join(root, 'backup')
    const ids = new Set<string>()
    try {
      const transaction = JSON.parse(await readFile(join(root, 'transaction.json'), 'utf8')) as {
        skillIds?: unknown
      }
      if (Array.isArray(transaction.skillIds)) {
        for (const id of transaction.skillIds)
          if (typeof id === 'string' && SAFE_SLUG.test(id)) ids.add(id)
      }
    } catch {
      // Legacy or partially prepared transaction; directory evidence below remains authoritative.
    }
    for (const directory of [stagingRoot, backupRoot]) {
      try {
        for (const id of await readdir(directory)) if (SAFE_SLUG.test(id)) ids.add(id)
      } catch {
        // A missing phase directory is an expected durable state.
      }
    }
    if (outcome === 'rollback') {
      for (const id of [...ids].sort()) {
        const live = join(this.importedRoot, id)
        const staging = join(stagingRoot, id)
        const backup = join(backupRoot, id)
        if (await exists(backup)) {
          await rm(live, { recursive: true, force: true })
          await mkdir(dirname(live), { recursive: true })
          await rename(backup, live)
        } else if (!(await exists(staging))) {
          await rm(live, { recursive: true, force: true })
        }
      }
    } else {
      for (const id of [...ids].sort()) {
        const live = join(this.importedRoot, id)
        const staging = join(stagingRoot, id)
        const backup = join(backupRoot, id)
        if (await exists(staging)) {
          if ((await exists(live)) && !(await exists(backup))) await rename(live, backup)
          await mkdir(dirname(live), { recursive: true })
          await rename(staging, live)
        }
        await rm(backup, { recursive: true, force: true })
      }
    }
    await rm(root, { recursive: true, force: true })
  }

  private transactionDir(transactionId: string): string {
    if (!SAFE_SLUG.test(transactionId)) throw new Error('Invalid package transaction identity.')
    return join(this.transactionRoot, transactionId)
  }
}

export { readMetadata as readSpecialistPackageSkillMetadata }
