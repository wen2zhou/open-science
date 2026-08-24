const stateExpression = `"state" IN ('requested', 'claimed', 'retry_wait', 'confirmed', 'superseded')`
const revisionExpression = `"revision" >= 1`
const attemptExpression = `"attempt" >= 0`
const leaseExpression = `("state" = 'claimed' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR ("state" <> 'claimed' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)`
const terminalTimeExpression = `("state" = 'confirmed' AND "confirmedAt" IS NOT NULL AND "supersededAt" IS NULL) OR ("state" = 'superseded' AND "supersededAt" IS NOT NULL AND "confirmedAt" IS NULL) OR ("state" IN ('requested', 'claimed', 'retry_wait') AND "confirmedAt" IS NULL AND "supersededAt" IS NULL)`

const cancellationDdl = `CREATE TABLE IF NOT EXISTS "ComputeJobCancellation" (
    "jobId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "leaseToken" TEXT,
    "leaseExpiresAt" DATETIME,
    "lastError" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "confirmedAt" DATETIME,
    "supersededAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComputeJobCancellation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ComputeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComputeJobCancellation_state_check" CHECK (${stateExpression}),
    CONSTRAINT "ComputeJobCancellation_revision_check" CHECK (${revisionExpression}),
    CONSTRAINT "ComputeJobCancellation_attempt_check" CHECK (${attemptExpression}),
    CONSTRAINT "ComputeJobCancellation_lease_check" CHECK (${leaseExpression}),
    CONSTRAINT "ComputeJobCancellation_terminal_time_check" CHECK (${terminalTimeExpression})
)`

const indexes = [
  `CREATE INDEX IF NOT EXISTS "ComputeJobCancellation_state_nextAttemptAt_idx" ON "ComputeJobCancellation"("state", "nextAttemptAt")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobCancellation_leaseExpiresAt_idx" ON "ComputeJobCancellation"("leaseExpiresAt")`
] as const

const computeJobCancellationMigration = {
  id: '0013_compute_job_cancellation',
  statements: [cancellationDdl, ...indexes] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ComputeJobCancellation',
          canonicalTableDdl: cancellationDdl,
          columns: [
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
          ]
        }
      ],
      dropOrder: ['ComputeJobCancellation'],
      indexes
    }
  ] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'ComputeJobCancellation' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ComputeJobCancellation',
      column: 'jobId',
      referencedTable: 'ComputeJob',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeJobCancellation',
          constraints: [
            { name: 'ComputeJobCancellation_state_check', expression: stateExpression },
            { name: 'ComputeJobCancellation_revision_check', expression: revisionExpression },
            { name: 'ComputeJobCancellation_attempt_check', expression: attemptExpression },
            { name: 'ComputeJobCancellation_lease_check', expression: leaseExpression },
            {
              name: 'ComputeJobCancellation_terminal_time_check',
              expression: terminalTimeExpression
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: indexes.map((sql) => ({
        name: sql.match(/"(ComputeJobCancellation_[^"]+)"/)![1],
        sql
      }))
    }
  ] as const
}

export { computeJobCancellationMigration }
