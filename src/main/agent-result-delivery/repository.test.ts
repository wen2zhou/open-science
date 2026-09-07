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

    const [claimed] = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 5_000,
      limit: 1,
      now: 1_000
    })
    await repository.prepareContinuation([claimed.id], 'claim-1', 'continuation-1')
    await repository.markConsumed([claimed.id], 'claim-1', 'continuation-1', 2_000)

    const replayAfterConsumption = await repository.recordTerminalOutcome(outcome)
    const presentationReplay = await repository.recordTerminalOutcome({
      ...outcome,
      resultSummary: 'stdout formatting changed without changing the execution fact'
    })

    expect(replayAfterConsumption).toMatchObject({ id: first.id, state: 'consumed' })
    expect(presentationReplay).toEqual(replayAfterConsumption)
    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([])
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
    await repository.prepareContinuation([claimed.id], 'claim', 'continuation-1')
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
    const waiting = {
      sourceKind: 'local-run',
      runId: 'run-1',
      executionType: 'repl' as const,
      terminalStatus: 'waiting-result' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'await host.llm()',
      lane: 'REPL · project-control',
      acceptedAt: 100
    } as const
    await repository.registerLocalRun(waiting)

    await expect(repository.listWaitingLocalRuns()).resolves.toEqual([waiting])

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
    await expect(repository.listWaitingLocalRuns()).resolves.toEqual([])
  })

  it('settles a local Run when admission and terminal recording race', async () => {
    const waiting = {
      sourceKind: 'local-run',
      runId: 'run-racing-admission',
      executionType: 'python' as const,
      terminalStatus: 'waiting-result' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'race()',
      lane: 'Kernel · Python',
      acceptedAt: 100
    } as const
    const terminal = {
      runId: waiting.runId,
      executionType: waiting.executionType,
      terminalStatus: 'completed' as const,
      resultSummary: 'done',
      projectId: waiting.projectId,
      sessionId: waiting.sessionId
    }

    await Promise.all([
      repository.registerLocalRun(waiting),
      repository.recordTerminalOutcome(terminal)
    ])

    await expect(repository.find(`local-run:${waiting.runId}`)).resolves.toMatchObject({
      state: 'pending',
      context: { terminalStatus: 'completed' }
    })
    await expect(repository.listWaitingLocalRuns()).resolves.toEqual([])
  })

  it('lets a direct observation fence a prepared continuation before dispatch begins', async () => {
    const delivery = await repository.recordTerminalOutcome({
      runId: 'run-observed',
      executionType: 'repl',
      terminalStatus: 'completed',
      resultSummary: 'done',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const [claimed] = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 5_000,
      limit: 1,
      now: 1_000
    })
    await repository.prepareContinuation([claimed.id], 'claim-1', 'continuation-stale')
    await expect(repository.markObserved(delivery.id, 'session-1', 2_000)).resolves.toBe(true)
    await expect(
      repository.beginDispatch([delivery.id], 'claim-1', 'continuation-stale')
    ).resolves.toBe(0)

    await expect(repository.find(delivery.id)).resolves.toMatchObject({
      state: 'consumed',
      consumedAt: 2_000
    })
    expect((await repository.find(delivery.id))?.claimToken).toBeUndefined()
    expect((await repository.find(delivery.id))?.continuationMessageId).toBeUndefined()
    await expect(
      repository.markConsumed([delivery.id], 'claim-1', 'continuation-stale', 3_000)
    ).resolves.toBe(0)
    await expect(repository.areConsumed([delivery.id], 'session-1')).resolves.toBe(true)
    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([])
  })

  it('does not let a direct observation consume a continuation after dispatch begins', async () => {
    const delivery = await repository.recordTerminalOutcome({
      runId: 'run-dispatching',
      executionType: 'repl',
      terminalStatus: 'completed',
      resultSummary: 'done',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const [claimed] = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 5_000,
      limit: 1,
      now: 1_000
    })
    await repository.prepareContinuation([claimed.id], 'claim-1', 'continuation-committed')

    await expect(
      repository.beginDispatch([delivery.id], 'claim-1', 'continuation-committed')
    ).resolves.toBe(1)
    await expect(repository.find(delivery.id)).resolves.toMatchObject({ state: 'dispatching' })
    await expect(repository.markObserved(delivery.id, 'session-1', 2_000)).resolves.toBe(false)

    await expect(
      repository.markConsumed([delivery.id], 'claim-1', 'continuation-committed', 3_000)
    ).resolves.toBe(1)
    await expect(repository.find(delivery.id)).resolves.toMatchObject({
      state: 'consumed',
      continuationMessageId: 'continuation-committed',
      consumedAt: 3_000
    })
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

  it('recovers an expired dispatch fence with its stable continuation correlation', async () => {
    const delivery = await repository.recordTerminalOutcome({
      runId: 'run-dispatch-recovery',
      executionType: 'shell',
      terminalStatus: 'completed',
      resultSummary: 'done',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const [claimed] = await repository.claimPending('session-1', {
      token: 'claim-1',
      expiresAt: 2_000,
      limit: 1,
      now: 1_000
    })
    await repository.prepareContinuation([claimed.id], 'claim-1', 'continuation-stable')
    await repository.beginDispatch([claimed.id], 'claim-1', 'continuation-stable')

    await expect(repository.find(delivery.id)).resolves.toMatchObject({ state: 'dispatching' })
    await expect(repository.recoverExpiredClaims(2_001)).resolves.toBe(1)
    await expect(repository.find(delivery.id)).resolves.toMatchObject({
      state: 'pending',
      continuationMessageId: 'continuation-stable'
    })
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
    const presentationReplay = await repository.recordTerminalOutcome({
      ...outcome,
      resultSummary: 'same result with a refreshed projection',
      computeHost: { ...outcome.computeHost, displayName: 'Renamed Cluster' }
    })

    expect(first).toMatchObject({ state: 'pending', context: outcome })
    expect(replay).toEqual(first)
    expect(presentationReplay).toEqual(first)
    await expect(repository.listAwaitingAgent('session-1')).resolves.toEqual([first])
    await expect(repository.listWaitingComputeJobIds()).resolves.toEqual([])
  })

  it('keeps an Agent-observed Compute Job consumed across registration and harvest replays', async () => {
    const registration = {
      jobId: 'job-observed',
      projectId: 'project-1',
      sessionId: 'session-1',
      providerId: 'host-1',
      displayName: 'Cluster One'
    }
    const outcome = {
      sourceKind: 'compute-job' as const,
      jobId: registration.jobId,
      executionType: 'compute-job' as const,
      terminalStatus: 'success' as const,
      resultSummary: 'featured: result.csv',
      projectId: registration.projectId,
      sessionId: registration.sessionId,
      computeHost: { providerId: registration.providerId, displayName: registration.displayName },
      featuredFiles: ['hpc/job-observed/featured/result.csv'],
      leftOnRemote: []
    }

    await repository.registerComputeJob(registration)
    const delivery = await repository.recordTerminalOutcome(outcome)
    expect(delivery).toMatchObject({ state: 'pending' })

    await expect(
      repository.markObserved(delivery!.id, registration.sessionId, 2_000)
    ).resolves.toBe(true)

    await Promise.all([
      repository.registerComputeJob(registration),
      repository.recordTerminalOutcome(outcome),
      repository.recordTerminalOutcome({
        ...outcome,
        resultSummary: 'same harvested result projected again'
      })
    ])

    await expect(repository.find(delivery!.id)).resolves.toMatchObject({
      state: 'consumed',
      consumedAt: 2_000
    })
    await expect(repository.listAwaitingAgent(registration.sessionId)).resolves.toEqual([])
    await expect(repository.listWaitingComputeJobIds()).resolves.toEqual([])
  })
})
