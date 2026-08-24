const partialTurnUsageMigration = {
  id: '0014_partial_turn_usage',
  statements: [
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "incomplete" BOOLEAN NOT NULL DEFAULT false`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionTurnUsage',
      column: 'incomplete'
    }
  ] as const
}

export { partialTurnUsageMigration }
