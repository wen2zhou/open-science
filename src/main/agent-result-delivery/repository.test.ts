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

  it('keeps a bounded Project projection without scanning consumed or other-Project history', async () => {
    await repository.registerLocalRun({
      sourceKind: 'local-run',
      runId: 'run-active',
      executionType: 'python',
      terminalStatus: 'waiting-result',
      projectId: 'project-1',
      sessionId: 'session-current',
      title: 'donor_level_qc()',
      lane: 'Kernel · Python 3.12',
      acceptedAt: 100
    })
    const consumed = await repository.recordTerminalOutcome({
      runId: 'run-consumed',
      executionType: 'shell',
      terminalStatus: 'completed',
      resultSummary: 'done',
      projectId: 'project-1',
      sessionId: 'session-old'
    })
    const [claimed] = await repository.claimPending('session-old', {
      token: 'claim',
      expiresAt: 5_000,
      limit: 1,
      now: 1_000
    })
    await repository.markConsumed([consumed.id], 'claim', 'continuation-1', 2_000)
    expect(claimed?.id).toBe(consumed.id)
    await repository.registerComputeJob({
      jobId: 'other-project-job',
      projectId: 'project-2',
      sessionId: 'session-2',
      providerId: 'host-2',
      displayName: 'Other Cluster'
    })

    await expect(repository.listProjectVisible('project-1', 1)).resolves.toEqual([
      expect.objectContaining({
        id: 'local-run:run-active',
        state: 'waiting-result',
        context: expect.objectContaining({ title: 'donor_level_qc()' })
      })
    ])
  })

  it('moves an admitted local Run monotonically from waiting-result to pending', async () => {
    await repository.registerLocalRun({
      sourceKind: 'local-run',
      runId: 'run-1',
      executionType: 'repl',
      terminalStatus: 'waiting-result',
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'await host.llm()',
      lane: 'REPL · project-control',
      acceptedAt: 100
    })

    await expect(
      repository.recordTerminalOutcome({
        runId: 'run-1',
        executionType: 'repl',
        terminalStatus: 'failed',
        resultSummary: 'failed',
        projectId: 'project-1',
        sessionId: 'session-1'
      })
    ).resolves.toMatchObject({ state: 'pending', context: { terminalStatus: 'failed' } })
    await expect(repository.listProjectVisible('project-1')).resolves.toEqual([
      expect.objectContaining({ state: 'pending' })
    ])
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

  it('hides needs-attention without changing delivery state or consuming the outcome', async () => {
    const delivery = await repository.recordTerminalOutcome({
      runId: 'run-1',
      executionType: 'repl',
      terminalStatus: 'cancelled',
      resultSummary: 'Cancelled before completion.',
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    const [claimed] = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 2_000,
      limit: 1,
      now: 1_000
    })
    await repository.releaseClaim([claimed.id], 'claim-1', 'needs-attention')

    await expect(repository.dismiss('session-1', delivery.id, 4_000)).resolves.toBe(true)

    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([])
    await expect(repository.find(delivery.id)).resolves.toMatchObject({
      state: 'needs-attention',
      dismissedAt: 4_000,
      context: { runId: 'run-1', terminalStatus: 'cancelled' }
    })
  })

  it('does not let dismiss hide a delivery before an Agent attempt fails', async () => {
    const delivery = await repository.recordTerminalOutcome({
      runId: 'run-pending',
      executionType: 'repl',
      terminalStatus: 'completed',
      resultSummary: 'done',
      projectId: 'project-1',
      sessionId: 'session-1'
    })

    await expect(repository.dismiss('session-1', delivery.id, 4_000)).resolves.toBe(false)
    await expect(repository.listAwaitingAgent('session-1')).resolves.toHaveLength(1)
  })

  it('registers a nonterminal Compute Job without backfilling an unregistered terminal Job', async () => {
    const registration = {
      jobId: 'job-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      providerId: 'host-1',
      displayName: 'Cluster One'
    }

    const waiting = await repository.registerComputeJob(registration)

    expect(waiting).toMatchObject({
      id: 'compute-job:job-1',
      state: 'waiting-result'
    })
    await expect(repository.hasComputeJobDeliveryPath('job-1')).resolves.toBe(true)
    await expect(repository.hasComputeJobDeliveryPath('old-terminal-job')).resolves.toBe(false)
    await expect(
      repository.recordTerminalOutcome({
        sourceKind: 'compute-job',
        jobId: 'old-terminal-job',
        executionType: 'compute-job',
        terminalStatus: 'success',
        resultSummary: 'Old result',
        projectId: 'project-1',
        sessionId: 'session-1',
        computeHost: { providerId: 'host-1', displayName: 'Cluster One' },
        featuredFiles: [],
        leftOnRemote: []
      })
    ).resolves.toBeUndefined()
  })

  it('moves a registered Compute Job to pending exactly once when its harvested result arrives', async () => {
    await repository.registerComputeJob({
      jobId: 'job-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      providerId: 'host-1',
      displayName: 'Cluster One'
    })
    const outcome = {
      sourceKind: 'compute-job' as const,
      jobId: 'job-1',
      executionType: 'compute-job' as const,
      terminalStatus: 'success' as const,
      resultSummary: 'featured: result.csv',
      projectId: 'project-1',
      sessionId: 'session-1',
      computeHost: { providerId: 'host-1', displayName: 'Cluster One' },
      featuredFiles: ['hpc/job-1/featured/result.csv'],
      leftOnRemote: []
    }

    const first = await repository.recordTerminalOutcome(outcome)
    const replay = await repository.recordTerminalOutcome(outcome)

    expect(first).toMatchObject({ state: 'pending', context: outcome })
    expect(replay).toEqual(first)
    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([first])
    await expect(repository.listWaitingComputeJobIds()).resolves.toEqual([])
  })
})
