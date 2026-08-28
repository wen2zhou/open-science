const reviewerTokenUsageMigration = {
  id: '0018_reviewer_token_usage',
  statements: [`ALTER TABLE "Review" ADD COLUMN "tokenUsage" TEXT`],
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'Review',
      column: 'tokenUsage'
    }
  ] as const
}

export { reviewerTokenUsageMigration }
