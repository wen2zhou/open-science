import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('Compute Job cleanup migration', () => {
  it('installs cleanup JSON checks when upgrading an existing ComputeJob table', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-cleanup-upgrade-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const [{ sql: currentJobDdl }] = await client.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJob'`
    )
    const [{ sql: currentOperationDdl }] = await client.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJobOperation'`
    )
    const legacyJobDdl = currentJobDdl
      .split('\n')
      .filter(
        (line) =>
          !line.includes('"ownerMarker"') &&
          !line.includes('"remoteObjectEvidence"') &&
          !line.includes('"cleanupReceipt"')
      )
      .join('\n')
      .replace(/,\n\)$/, '\n)')
    const legacyOperationDdl = currentOperationDdl
      .split('\n')
      .filter(
        (line) =>
          !line.includes('"requestId"') &&
          !line.includes('"receipt"') &&
          !line.includes('ComputeJobOperation_receiptJson_check')
      )
      .join('\n')
      .replace(/,\n\)$/, '\n)')

    await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await client.$executeRawUnsafe(`DROP TABLE "ComputeJobRemoteReference"`)
    await client.$executeRawUnsafe(`DROP TABLE "ComputeJobOperation"`)
    await client.$executeRawUnsafe(`ALTER TABLE "ComputeJob" RENAME TO "__legacy_ComputeJob"`)
    await client.$executeRawUnsafe(legacyJobDdl)
    const legacyColumns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("ComputeJob")`
    )
    const columnList = legacyColumns.map(({ name }) => `"${name}"`).join(', ')
    await client.$executeRawUnsafe(
      `INSERT INTO "ComputeJob" (${columnList}) SELECT ${columnList} FROM "__legacy_ComputeJob"`
    )
    await client.$executeRawUnsafe(`DROP TABLE "__legacy_ComputeJob"`)
    await client.$executeRawUnsafe(legacyOperationDdl)
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" = '0026_compute_job_cleanup'`
    )
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')

    await migrateApplicationDatabase(client)

    const [{ sql: migratedJobDdl }] = await client.$queryRawUnsafe<Array<{ sql: string }>>(
      `SELECT "sql" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" = 'ComputeJob'`
    )
    expect(migratedJobDdl).toContain('CONSTRAINT "ComputeJob_remoteObjectEvidenceJson_check"')
    expect(migratedJobDdl).toContain('CONSTRAINT "ComputeJob_cleanupReceiptJson_check"')

    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "intent", "command", "commandHash", "status"
    ) VALUES ('cleanup-check-job', 'ssh:test', 'direct_ssh', 'session-1', 'project-1', 'test', 'true', 'hash', 'success')`)
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJob" SET "remoteObjectEvidence" = '{}' WHERE "id" = 'cleanup-check-job'`
      )
    ).rejects.toThrow(/constraint/i)
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJob" SET "cleanupReceipt" = '[]' WHERE "id" = 'cleanup-check-job'`
      )
    ).rejects.toThrow(/constraint/i)
  })
})
