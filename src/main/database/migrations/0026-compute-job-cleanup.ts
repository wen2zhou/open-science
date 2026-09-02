const kindExpression = `"kind" IN ('cancel', 'cleanup')`
const receiptExpression = `"receipt" IS NULL OR (json_valid("receipt") AND json_type("receipt") = 'object')`
const remoteObjectEvidenceExpression = `"remoteObjectEvidence" IS NULL OR (json_valid("remoteObjectEvidence") AND json_type("remoteObjectEvidence") = 'array')`
const cleanupReceiptExpression = `"cleanupReceipt" IS NULL OR (json_valid("cleanupReceipt") AND json_type("cleanupReceipt") = 'object')`

const computeJobDdl = `CREATE TABLE IF NOT EXISTS "ComputeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "intent" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "sensitiveDataEncrypted" BOOLEAN,
    "environment" TEXT,
    "resourceRequest" TEXT,
    "inputManifest" TEXT,
    "producerRunId" TEXT,
    "fileEvidence" TEXT,
    "outputManifest" TEXT,
    "harvestConfig" TEXT,
    "timeoutSeconds" INTEGER,
    "remoteWorkdir" TEXT,
    "remoteHandle" TEXT,
    "ownerMarker" TEXT,
    "remoteObjectEvidence" TEXT,
    "cleanupReceipt" TEXT,
    "exitCode" INTEGER,
    "stdoutTail" TEXT,
    "stderrTail" TEXT,
    "errorCode" TEXT,
    "lastPollError" TEXT,
    "harvestError" TEXT,
    "leftOnRemote" TEXT,
    "notifiedAt" DATETIME,
    "notificationConsumedAt" DATETIME,
    "analysisState" TEXT,
    "analysisMessageId" TEXT,
    "analysisUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "harvestedAt" DATETIME,
    CONSTRAINT "ComputeJob_shape_check" CHECK ("shape" IN ('direct_ssh', 'scheduler_cluster', 'bridge_runner')),
    CONSTRAINT "ComputeJob_status_check" CHECK ("status" IN ('queued', 'submitted', 'running', 'success', 'failed', 'timeout', 'error')),
    CONSTRAINT "ComputeJob_errorCode_check" CHECK ("errorCode" IS NULL OR "errorCode" IN ('approval_denied', 'credential_required', 'credential_conflict', 'credential_unavailable', 'secure_storage_unavailable', 'authentication_failed', 'host_key_unknown', 'host_key_changed', 'host_unreachable', 'unsupported_auth_configuration', 'dispatch_failed', 'job_failed', 'timeout', 'process_vanished')),
    CONSTRAINT "ComputeJob_timeoutSeconds_check" CHECK ("timeoutSeconds" IS NULL OR "timeoutSeconds" BETWEEN 1 AND 604800),
    CONSTRAINT "ComputeJob_notification_check" CHECK ("notificationConsumedAt" IS NULL OR "notifiedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_analysisState_check" CHECK ("analysisState" IS NULL OR "analysisState" IN ('dispatched', 'succeeded', 'failed', 'cancelled')),
    CONSTRAINT "ComputeJob_analysisBundle_check" CHECK ((("analysisState" IS NULL AND "analysisMessageId" IS NULL AND "analysisUpdatedAt" IS NULL) OR ("analysisState" IS NOT NULL AND "analysisMessageId" IS NOT NULL AND length(trim("analysisMessageId")) > 0 AND "analysisUpdatedAt" IS NOT NULL))),
    CONSTRAINT "ComputeJob_analysisConsumption_check" CHECK ("analysisState" IS NULL OR "analysisState" <> 'succeeded' OR "notificationConsumedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestPayload_check" CHECK (("harvestError" IS NULL AND "leftOnRemote" IS NULL) OR "harvestedAt" IS NOT NULL),
    CONSTRAINT "ComputeJob_harvestState_check" CHECK ("harvestedAt" IS NULL OR "status" IN ('success', 'failed', 'timeout')),
    CONSTRAINT "ComputeJob_errorState_check" CHECK ((("errorCode" IS NULL OR "status" IN ('failed', 'timeout', 'error')) AND ("status" <> 'error' OR "errorCode" IS NOT NULL))),
    CONSTRAINT "ComputeJob_resourceRequestJson_check" CHECK ("resourceRequest" IS NULL OR (json_valid("resourceRequest") AND json_type("resourceRequest") = 'object')),
    CONSTRAINT "ComputeJob_inputManifestJson_check" CHECK ("inputManifest" IS NULL OR (json_valid("inputManifest") AND json_type("inputManifest") = 'array')),
    CONSTRAINT "ComputeJob_outputManifestJson_check" CHECK ("outputManifest" IS NULL OR (json_valid("outputManifest") AND json_type("outputManifest") = 'array')),
    CONSTRAINT "ComputeJob_harvestConfigJson_check" CHECK ("harvestConfig" IS NULL OR (json_valid("harvestConfig") AND json_type("harvestConfig") = 'object')),
    CONSTRAINT "ComputeJob_remoteHandleJson_check" CHECK ("remoteHandle" IS NULL OR (json_valid("remoteHandle") AND json_type("remoteHandle") = 'object')),
    CONSTRAINT "ComputeJob_leftOnRemoteJson_check" CHECK ("leftOnRemote" IS NULL OR (json_valid("leftOnRemote") AND json_type("leftOnRemote") = 'array')),
    CONSTRAINT "ComputeJob_remoteObjectEvidenceJson_check" CHECK (${remoteObjectEvidenceExpression}),
    CONSTRAINT "ComputeJob_cleanupReceiptJson_check" CHECK (${cleanupReceiptExpression})
)`

const computeJobColumns = [
  'id',
  'providerId',
  'shape',
  'sessionId',
  'projectId',
  'status',
  'intent',
  'command',
  'commandHash',
  'sensitiveDataEncrypted',
  'environment',
  'resourceRequest',
  'inputManifest',
  'producerRunId',
  'fileEvidence',
  'outputManifest',
  'harvestConfig',
  'timeoutSeconds',
  'remoteWorkdir',
  'remoteHandle',
  'exitCode',
  'stdoutTail',
  'stderrTail',
  'errorCode',
  'lastPollError',
  'harvestError',
  'leftOnRemote',
  'notifiedAt',
  'notificationConsumedAt',
  'analysisState',
  'analysisMessageId',
  'analysisUpdatedAt',
  'createdAt',
  'submittedAt',
  'startedAt',
  'finishedAt',
  'harvestedAt'
] as const

const computeJobIndexes = [
  `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status")`
] as const

const operationDdl = `CREATE TABLE IF NOT EXISTS "ComputeJobOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'active',
    "outcome" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleAt" DATETIME,
    "claimToken" TEXT,
    "claimExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    "requestId" TEXT,
    "receipt" TEXT,
    CONSTRAINT "ComputeJobOperation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ComputeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComputeJobOperation_kind_check" CHECK (${kindExpression}),
    CONSTRAINT "ComputeJobOperation_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "ComputeJobOperation_attemptCount_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "ComputeJobOperation_phase_check" CHECK ("phase" IN ('active', 'settled')),
    CONSTRAINT "ComputeJobOperation_lifecycle_check" CHECK (("phase" = 'active' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = 'settled' AND "outcome" IN ('fulfilled', 'superseded') AND "settledAt" IS NOT NULL)),
    CONSTRAINT "ComputeJobOperation_claim_check" CHECK (("claimToken" IS NULL AND "claimExpiresAt" IS NULL) OR ("phase" = 'active' AND "claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)),
    CONSTRAINT "ComputeJobOperation_settled_implementation_check" CHECK ("phase" = 'active' OR ("eligibleAt" IS NULL AND "claimToken" IS NULL AND "claimExpiresAt" IS NULL)),
    CONSTRAINT "ComputeJobOperation_receiptJson_check" CHECK (${receiptExpression})
)`

const operationIndexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeJobOperation_jobId_kind_key" ON "ComputeJobOperation"("jobId", "kind")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_eligibleAt_createdAt_idx" ON "ComputeJobOperation"("kind", "phase", "eligibleAt", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_claimExpiresAt_idx" ON "ComputeJobOperation"("kind", "phase", "claimExpiresAt")`
] as const

const referenceDdl = `CREATE TABLE IF NOT EXISTS "ComputeJobRemoteReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "producerJobId" TEXT NOT NULL,
    "consumerJobId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "remotePath" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "dstFilename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComputeJobRemoteReference_producerJobId_fkey" FOREIGN KEY ("producerJobId") REFERENCES "ComputeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComputeJobRemoteReference_consumerJobId_fkey" FOREIGN KEY ("consumerJobId") REFERENCES "ComputeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`

const referenceIndexes = [
  `CREATE INDEX IF NOT EXISTS "ComputeJobRemoteReference_producerJobId_remotePath_idx" ON "ComputeJobRemoteReference"("producerJobId", "remotePath")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobRemoteReference_consumerJobId_idx" ON "ComputeJobRemoteReference"("consumerJobId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeJobRemoteReference_consumerJobId_remotePath_key" ON "ComputeJobRemoteReference"("consumerJobId", "remotePath")`
] as const

const computeJobCleanupMigration = {
  id: '0026_compute_job_cleanup',
  statements: [referenceDdl, ...referenceIndexes] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ComputeJob',
          canonicalTableDdl: computeJobDdl,
          columns: computeJobColumns,
          optionalLegacyColumns: [
            { name: 'ownerMarker', definition: '"ownerMarker" TEXT' },
            { name: 'remoteObjectEvidence', definition: '"remoteObjectEvidence" TEXT' },
            { name: 'cleanupReceipt', definition: '"cleanupReceipt" TEXT' }
          ]
        },
        {
          tableName: 'ComputeJobOperation',
          canonicalTableDdl: operationDdl,
          columns: [
            'id',
            'jobId',
            'kind',
            'phase',
            'outcome',
            'revision',
            'attemptCount',
            'eligibleAt',
            'claimToken',
            'claimExpiresAt',
            'createdAt',
            'settledAt',
            'updatedAt'
          ],
          optionalLegacyColumns: [
            { name: 'requestId', definition: '"requestId" TEXT' },
            { name: 'receipt', definition: '"receipt" TEXT' }
          ]
        },
        {
          tableName: 'ComputeJobRemoteReference',
          canonicalTableDdl: referenceDdl,
          columns: [
            'id',
            'producerJobId',
            'consumerJobId',
            'providerId',
            'remotePath',
            'uri',
            'dstFilename',
            'createdAt'
          ]
        }
      ],
      dropOrder: ['ComputeJobRemoteReference', 'ComputeJobOperation', 'ComputeJob'],
      indexes: [...computeJobIndexes, ...operationIndexes, ...referenceIndexes]
    }
  ] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'ownerMarker' },
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'remoteObjectEvidence' },
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'cleanupReceipt' },
    { kind: 'table-exists', version: 1, table: 'ComputeJobRemoteReference' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeJobOperation',
          constraints: [
            { name: 'ComputeJobOperation_kind_check', expression: kindExpression },
            { name: 'ComputeJobOperation_receiptJson_check', expression: receiptExpression }
          ]
        },
        {
          table: 'ComputeJob',
          constraints: [
            {
              name: 'ComputeJob_remoteObjectEvidenceJson_check',
              expression: remoteObjectEvidenceExpression
            },
            { name: 'ComputeJob_cleanupReceiptJson_check', expression: cleanupReceiptExpression }
          ]
        }
      ]
    }
  ] as const
}

export { computeJobCleanupMigration }
