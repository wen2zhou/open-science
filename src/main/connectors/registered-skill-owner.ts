import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  readSkillHelperDescriptors,
  validateSkillHelperPackage,
  type RegisteredSkillPackage
} from '../skills/registered-helper-catalog'

const SAFE_CONNECTOR_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Canonical, app-owned Connector package catalog. Runtime mcp-* projections are intentionally not
// consulted: they are framework delivery artifacts, not durable registration authority.
class ConnectorRegisteredSkillOwner {
  private readonly root: string
  private onRegistered: (() => Promise<void>) | undefined

  constructor(storageRoot: string) {
    this.root = join(storageRoot, 'connector-registered-skills')
  }

  packageRoot(connectorName: string): string {
    if (!SAFE_CONNECTOR_NAME.test(connectorName)) {
      throw new Error('Invalid canonical Connector name')
    }
    return join(this.root, connectorName)
  }

  setRegistrationObserver(observer: () => Promise<void>): void {
    this.onRegistered = observer
  }

  async packages(): Promise<readonly RegisteredSkillPackage[]> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    const packages: RegisteredSkillPackage[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !SAFE_CONNECTOR_NAME.test(entry.name)) continue
      const packageRoot = this.packageRoot(entry.name)
      const helpers = await readSkillHelperDescriptors(packageRoot)
      if (helpers.length === 0) continue
      packages.push({
        skillId: `mcp-${entry.name}`,
        origin: 'connector',
        packageRoot,
        helpers
      })
    }
    return packages
  }

  async registerPackage(connectorName: string, sourceRoot: string): Promise<void> {
    const target = this.packageRoot(connectorName)
    const helpers = await readSkillHelperDescriptors(sourceRoot)
    if (helpers.length === 0) {
      throw new Error('Connector package does not declare registered helpers')
    }
    await validateSkillHelperPackage(sourceRoot)

    await mkdir(this.root, { recursive: true })
    const staging = join(this.root, `.staging-${connectorName}-${randomUUID()}`)
    await mkdir(staging)
    try {
      await writeFile(
        join(staging, 'open-science.json'),
        JSON.stringify({ schemaVersion: 1, helpers }),
        { flag: 'wx', mode: 0o400 }
      )
      for (const locator of new Set(helpers.map((helper) => helper.implementation))) {
        const target = join(staging, locator)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, await readFile(join(sourceRoot, locator)), {
          flag: 'wx',
          mode: 0o400
        })
      }
      await validateSkillHelperPackage(staging)

      const backup = join(this.root, `.backup-${connectorName}-${randomUUID()}`)
      const replaced = await rename(target, backup)
        .then(() => true)
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        })
      try {
        await rename(staging, target)
        await this.onRegistered?.()
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        if (replaced) await rename(backup, target)
        throw error
      }
      if (replaced) await rm(backup, { recursive: true, force: true })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

export { ConnectorRegisteredSkillOwner }
