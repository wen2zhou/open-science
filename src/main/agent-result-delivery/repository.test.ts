import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AgentResultDeliveryRepository } from './repository'

describe('AgentResultDeliveryRepository', () => {
  let root: string
  let client: PrismaClient
  let repository: AgentResultDeliveryRepository

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-result-delivery-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    repository = new AgentResultDeliveryRepository(() => Promise.resolve(client))
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('records one pending fact when a background terminal outcome is replayed', async () => {
    const outcome = {
      runId: 'run-1',
      executionType: 'python' as const,
      terminalStatus: 'completed' as const,
      resultSummary: 'stdout: 42',
      projectId: 'project-1',
      sessionId: 'session-1',
      agentFrameId: 'frame-1'
    }

    const first = await repository.recordTerminalOutcome(outcome)
    const replay = await repository.recordTerminalOutcome(outcome)

    expect(replay).toEqual(first)
    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([first])
  })

  it('claims a Session batch once and recovers an expired lease without consuming it', async () => {
    await repository.recordTerminalOutcome({
      runId: 'run-1',
      executionType: 'shell',
      terminalStatus: 'failed',
      resultSummary: 'exit 2',
      errorGuidance: 'Inspect stderr before deciding whether to run again.',
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    const claimed = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 2_000,
      limit: 8,
      now: 1_000
    })

    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ state: 'claimed', claimToken: 'claim-1' })
    await expect(
      repository.claimPending('session-1', {
        token: 'claim-2',
        expiresAt: 2_500,
        limit: 8,
        now: 1_500
      })
    ).resolves.toEqual([])

    await repository.recoverExpiredClaims(2_001)
    await expect(
      repository.claimPending('session-1', {
        token: 'claim-2',
        expiresAt: 3_000,
        limit: 8,
        now: 2_001
      })
    ).resolves.toEqual([
      expect.objectContaining({ state: 'claimed', claimToken: 'claim-2', attemptCount: 2 })
    ])
  })

  it('keeps dismiss separate from consumption and preserves the durable outcome', async () => {
    const delivery = await repository.recordTerminalOutcome({
      runId: 'run-1',
      executionType: 'repl',
      terminalStatus: 'cancelled',
      resultSummary: 'Cancelled before completion.',
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    await repository.dismiss('session-1', delivery.id, 4_000)

    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([])
    await expect(repository.find(delivery.id)).resolves.toMatchObject({
      state: 'dismissed',
      dismissedAt: 4_000,
      context: { runId: 'run-1', terminalStatus: 'cancelled' }
    })
  })
})
