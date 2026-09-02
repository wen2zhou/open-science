const agentResultDeliveryMigration = {
  id: '0026_agent_result_delivery',
  statements: [
    `CREATE TABLE "AgentResultDelivery" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceKind" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "agentFrameId" TEXT,
      "executionType" TEXT NOT NULL,
      "terminalStatus" TEXT NOT NULL,
      "contextJson" TEXT NOT NULL,
      "state" TEXT NOT NULL,
      "attemptCount" INTEGER NOT NULL DEFAULT 0,
      "claimToken" TEXT,
      "claimExpiresAt" DATETIME,
      "continuationMessageId" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      "consumedAt" DATETIME,
      "dismissedAt" DATETIME
    )`,
    `CREATE INDEX "AgentResultDelivery_sessionId_state_createdAt_idx" ON "AgentResultDelivery"("sessionId", "state", "createdAt")`,
    `CREATE INDEX "AgentResultDelivery_state_claimExpiresAt_idx" ON "AgentResultDelivery"("state", "claimExpiresAt")`,
    `CREATE UNIQUE INDEX "AgentResultDelivery_sourceKind_sourceId_key" ON "AgentResultDelivery"("sourceKind", "sourceId")`
  ] as const,
  operations: [] as const,
  verifiers: [{ kind: 'table-exists', version: 1, table: 'AgentResultDelivery' }] as const
}

export { agentResultDeliveryMigration }
