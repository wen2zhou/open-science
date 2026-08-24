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

describe('Compute Job cancellation migration', () => {
  it('adds an ownership-cascading sidecar without rebuilding historical ComputeJob rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-cancellation-migration-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "intent", "command", "commandHash", "status"
    ) VALUES ('historical-job', 'ssh:test', 'direct_ssh', 'session-1', 'project-1', 'old work', 'true', 'hash', 'success')`)
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJobCancellation" (
      "jobId", "state", "revision", "attempt", "requestedAt", "updatedAt"
    ) VALUES ('historical-job', 'requested', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)

    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("ComputeJobCancellation")`
    )
    expect(columns.map(({ name }) => name)).toEqual([
      'jobId',
      'state',
      'revision',
      'attempt',
      'nextAttemptAt',
      'leaseToken',
      'leaseExpiresAt',
      'lastError',
      'requestedAt',
      'claimedAt',
      'confirmedAt',
      'supersededAt',
      'updatedAt'
    ])

    await expect(
      client.$executeRawUnsafe(
        `UPDATE "ComputeJobCancellation" SET "state" = 'invalid' WHERE "jobId" = 'historical-job'`
      )
    ).rejects.toThrow(/constraint/i)

    await client.$executeRawUnsafe(`DELETE FROM "ComputeJob" WHERE "id" = 'historical-job'`)
    const [{ count }] = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS "count" FROM "ComputeJobCancellation"`
    )
    expect(Number(count)).toBe(0)
  })
})
