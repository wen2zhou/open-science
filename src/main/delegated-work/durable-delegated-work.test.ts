import { describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ReviewWithChecks } from '../../shared/reviewer'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import {
  createDurableDelegatedWork,
  createInMemoryDelegatedWorkRecords,
  type AuthenticatedDelegateCaller,
  type DelegatedArtifactEvidence,
  type DelegatedReviewEvidence
} from './durable-delegated-work'

const caller: AuthenticatedDelegateCaller = {
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: 'root-frame',
  role: 'main',
  originMessageId: 'origin-message',
  toolInvocationId: 'tool-call-1'
}

type SpecialistFixture = {
  id: string
  name: string
  displayName: string
  enabled: boolean
  setupPending: boolean
  revision: number
}

const specialist = (overrides: Partial<SpecialistFixture> = {}): SpecialistFixture => ({
  id: 'specialist-stable-id',
  name: 'EVIDENCE_ANALYST',
  displayName: 'Evidence Analyst',
  enabled: true,
  setupPending: false,
  revision: 7,
  ...overrides
})

describe('durable delegated work', () => {
  it('publishes live runtime updates only for their trusted running Attempt', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const updates: unknown[] = []
    const ids = {
      frame: ['child-frame'],
      attempt: ['child-attempt'],
      message: ['child-prompt'],
      runtime: ['child-runtime']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!,
      onAgentRuntimeUpdate: (update) => updates.push(update)
    })

    await work.delegate(caller, { task: 'Stream evidence' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.emit({
      kind: 'runtime',
      update: {
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'child-frame',
          attemptId: 'child-attempt',
          runtimeSegmentId: 'child-runtime',
          promptMessageId: 'child-prompt'
        },
        event: {
          id: 'tool-1:start',
          timestamp: 10,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          title: 'Read source',
          status: 'in_progress'
        }
      }
    })

    expect(updates).toEqual([
      expect.objectContaining({
        scope: expect.objectContaining({
          agentFrameId: 'child-frame',
          attemptId: 'child-attempt',
          runtimeSegmentId: 'child-runtime',
          promptMessageId: 'child-prompt'
        }),
        event: expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1' })
      })
    ])

    control.complete('done')
  })

  it('correlates root permission cards to the trusted current Frame and Attempt', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const permissionEvents: unknown[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      onRootPermissionEvent: (event) => permissionEvents.push(event)
    })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'Inspect alpha', name: 'Alpha child' },
        { task: 'Inspect beta', name: 'Beta child' }
      ],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)

    execution.controls()[0].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-alpha',
      title: 'Read alpha.csv',
      options: [{ optionId: 'allow-alpha', name: 'Allow once', kind: 'allow_once' }]
    })
    execution.controls()[1].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-beta',
      title: 'Run beta check',
      options: [{ optionId: 'deny-beta', name: 'Deny', kind: 'reject_once' }]
    })

    expect(permissionEvents).toMatchObject([
      { kind: 'requested', request: { requestId: 'permission-alpha' } },
      { kind: 'requested', request: { requestId: 'permission-beta' } }
    ])

    await expect(work.rootPermissionRequests(caller.session)).resolves.toEqual([
      {
        requestId: 'permission-alpha',
        frameId: dispatched.children[0].frameId,
        attemptId: dispatched.children[0].attemptId,
        childTitle: 'Alpha child',
        action: 'Read alpha.csv',
        riskScope: 'This call only',
        options: [{ optionId: 'allow-alpha', name: 'Allow once', kind: 'allow_once' }]
      },
      {
        requestId: 'permission-beta',
        frameId: dispatched.children[1].frameId,
        attemptId: dispatched.children[1].attemptId,
        childTitle: 'Beta child',
        action: 'Run beta check',
        riskScope: 'This call only',
        options: [{ optionId: 'deny-beta', name: 'Deny', kind: 'reject_once' }]
      }
    ])
    await expect(work.sessionSummary(caller.session)).resolves.toMatchObject({
      children: [
        { status: 'running', awaitingPermission: true },
        { status: 'running', awaitingPermission: true }
      ]
    })

    await work.respondToPermission(caller.session, {
      requestId: 'permission-beta',
      frameId: dispatched.children[1].frameId,
      attemptId: dispatched.children[1].attemptId,
      optionId: 'deny-beta'
    })
    expect(execution.controls()[0].permissionResponses()).toEqual([])
    expect(execution.controls()[1].permissionResponses()).toEqual([
      { requestId: 'permission-beta', optionId: 'deny-beta' }
    ])
    expect(permissionEvents.at(-1)).toMatchObject({
      kind: 'settled',
      request: { requestId: 'permission-beta' }
    })
    await expect(work.rootPermissionRequests(caller.session)).resolves.toMatchObject([
      { requestId: 'permission-alpha' }
    ])

    execution.controls()[0].complete('done')
    execution.controls()[1].complete('denied')
  })

  it('settles permission response, terminal, and Stop races exactly once', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Risky child' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-race',
      title: 'Run command',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })

    const first = work.respondToPermission(caller.session, {
      requestId: 'permission-race',
      frameId: dispatched.children[0].frameId,
      attemptId: dispatched.children[0].attemptId,
      optionId: 'allow'
    })
    const duplicate = work.respondToPermission(caller.session, {
      requestId: 'permission-race',
      frameId: dispatched.children[0].frameId,
      attemptId: dispatched.children[0].attemptId,
      cancelled: true
    })
    await expect(first).resolves.toBeUndefined()
    await expect(duplicate).rejects.toMatchObject({ code: 'conflict' })
    expect(control.permissionResponses()).toEqual([
      { requestId: 'permission-race', optionId: 'allow' }
    ])

    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-stop',
      title: 'Write file',
      options: [{ optionId: 'allow-write', name: 'Allow', kind: 'allow_once' }]
    })
    await work.stopSession(caller.session)
    await expect(
      work.respondToPermission(caller.session, {
        requestId: 'permission-stop',
        frameId: dispatched.children[0].frameId,
        attemptId: dispatched.children[0].attemptId,
        optionId: 'allow-write'
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(work.rootPermissionRequests(caller.session)).resolves.toEqual([])
    await expect(
      work.readAgentFrame(caller.session, dispatched.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'cancelled'
    })
  })

  it('restores unresolved permission cards when Stop submission fails', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      revokeAttemptWrites: async () => {
        throw new Error('stop transport unavailable')
      }
    })
    await work.delegate(caller, { task: 'Permission child' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-retry',
      title: 'Read evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })

    await expect(work.stopSession(caller.session)).rejects.toThrow('stop transport unavailable')
    await expect(work.rootPermissionRequests(caller.session)).resolves.toMatchObject([
      { requestId: 'permission-retry' }
    ])
    await expect(work.sessionSummary(caller.session)).resolves.toMatchObject({
      children: [{ status: 'running', awaitingPermission: true }]
    })
  })

  it('durably delivers each Main message to the current running child Attempt', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 0
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 100 + nextId,
      createId: (kind) => `${kind}-${++nextId}`
    })
    const dispatched = await work.delegate(caller, { task: 'Long investigation' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'message-one' },
        dispatched.children[0].frameId,
        'Use newer evidence',
        'info'
      )
    ).resolves.toMatchObject({ kind: 'queued', messageId: expect.any(String) })
    await work.sendMessage(
      { ...caller, toolInvocationId: 'message-two' },
      dispatched.children[0].frameId,
      'Use newer evidence',
      'info'
    )

    expect(execution.controls()[0].deliveredMessages()).toEqual([
      'Use newer evidence',
      'Use newer evidence'
    ])
    const pending = (await records.snapshot()).records[0].pendingMessages
    expect(pending).toHaveLength(2)
    expect(new Set(pending.map(({ id }) => id)).size).toBe(2)
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFrameId: caller.frameId,
          targetFrameId: dispatched.children[0].frameId,
          targetAttemptId: dispatched.children[0].attemptId,
          text: 'Use newer evidence',
          kind: 'info',
          deliveredAt: expect.any(Number)
        })
      ])
    )
  })

  it('delivers a running Delegate question only to its authenticated parent with attribution', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const deliveries: unknown[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      deliverToParent: async (delivery) => {
        deliveries.push(delivery)
      }
    })
    const dispatched = await work.delegate(caller, { task: 'Investigate' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const child = dispatched.children[0]
    const delegateCaller: AuthenticatedDelegateCaller = {
      session: caller.session,
      frameId: child.frameId,
      attemptId: child.attemptId,
      role: 'delegate',
      originMessageId: caller.originMessageId,
      toolInvocationId: 'child-question'
    }

    await expect(
      work.sendMessage(delegateCaller, 'parent', 'Which cohort?', 'question')
    ).resolves.toMatchObject({
      kind: 'queued',
      targetFrameId: caller.frameId,
      attemptId: child.attemptId
    })
    expect(deliveries).toEqual([
      expect.objectContaining({
        session: caller.session,
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: caller.frameId,
        text: 'Which cohort?',
        kind: 'question'
      })
    ])
    expect((await records.snapshot()).records[0].pendingMessages).toEqual([
      expect.objectContaining({
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: caller.frameId,
        deliveredAt: expect.any(Number)
      })
    ])

    await expect(
      work.sendMessage(
        {
          ...delegateCaller,
          session: { ...caller.session, sessionId: 'forged' },
          toolInvocationId: 'forged'
        },
        'parent',
        'Forged',
        'info'
      )
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.sendMessage(
        { ...delegateCaller, attemptId: 'superseded-attempt', toolInvocationId: 'stale' },
        'parent',
        'Late',
        'info'
      )
    ).rejects.toMatchObject({ code: 'authorization' })
  })

  it('deduplicates one successful message invocation by identity, not by text', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Investigate' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const messageCaller = { ...caller, toolInvocationId: 'stable-message-call' }

    const [first, duplicate] = await Promise.all([
      work.sendMessage(messageCaller, dispatched.children[0].frameId, 'Same text'),
      work.sendMessage(messageCaller, dispatched.children[0].frameId, 'Same text')
    ])

    expect(duplicate).toEqual(first)
    expect(execution.controls()[0].deliveredMessages()).toEqual(['Same text'])
    expect((await records.snapshot()).records[0].pendingMessages).toHaveLength(1)
  })

  it('retains uncertain delivery as undelivered history and does not replay it after restart', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return {
          ...handle,
          sendMessage: async () => Promise.reject(new Error('provider unavailable'))
        }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Investigate' }, { wait: false })
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'failed-message' },
        dispatched.children[0].frameId,
        'Additional context'
      )
    ).resolves.toMatchObject({ kind: 'queued' })
    await Promise.resolve()
    expect((await records.snapshot()).records[0].pendingMessages[0]).not.toHaveProperty(
      'deliveredAt'
    )

    const restartedExecution = createDeterministicDelegateExecution()
    const restarted = createDurableDelegatedWork({ execution: restartedExecution, records })
    await restarted.recoverInterrupted()
    expect(restartedExecution.controls()).toEqual([])
    expect((await records.snapshot()).records[0].pendingMessages[0]).not.toHaveProperty(
      'deliveredAt'
    )
  })

  it('uses same-Frame continuation when the target terminalizes during message admission', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let raced = false
    const records: typeof durableRecords = {
      ...durableRecords,
      async appendPendingMessage(frameId, attemptId, message) {
        if (!raced) {
          raced = true
          await durableRecords.terminalize({
            frameId,
            attemptId,
            status: 'cancelled',
            endedAt: message.createdAt,
            cancellationReason: 'main_agent_stop'
          })
          execution.control(attemptId).cancel()
        }
        await durableRecords.appendPendingMessage(frameId, attemptId, message)
      }
    }
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Investigate' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'racing-message' },
        dispatched.children[0].frameId,
        'Continue after terminal'
      )
    ).resolves.toMatchObject({
      kind: 'continued',
      child: { frameId: dispatched.children[0].frameId, status: 'running' }
    })
    expect((await records.snapshot()).records[0]).toMatchObject({
      attempts: [{ status: 'cancelled' }, { status: 'running' }],
      pendingMessages: []
    })
  })

  it('marks a queued Main-to-child message only after the execution delivery boundary resolves', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    let acceptDelivery!: () => void
    const deliveryBoundary = new Promise<void>((resolve) => {
      acceptDelivery = resolve
    })
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return { ...handle, sendMessage: async () => deliveryBoundary }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Investigate' }, { wait: false })
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'delivery-boundary' },
        dispatched.children[0].frameId,
        'Accepted later'
      )
    ).resolves.toMatchObject({ kind: 'queued' })
    expect((await records.snapshot()).records[0].pendingMessages[0]).not.toHaveProperty(
      'deliveredAt'
    )

    acceptDelivery()

    await expect
      .poll(async () => (await records.snapshot()).records[0].pendingMessages[0].deliveredAt)
      .toEqual(expect.any(Number))
  })

  it('rejects late delivery after cancellation without fabricating deliveredAt', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return { ...handle, sendMessage: async () => deliveryGate }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Investigate' }, { wait: false })
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()
    const delivery = work.sendMessage(
      { ...caller, toolInvocationId: 'late-message' },
      dispatched.children[0].frameId,
      'Too late'
    )
    await expect
      .poll(async () => (await records.snapshot()).records[0].pendingMessages)
      .toHaveLength(1)

    await work.stopChildren(caller, [dispatched.children[0].frameId])
    releaseDelivery()

    await expect(delivery).resolves.toMatchObject({ kind: 'queued' })
    await Promise.resolve()
    expect((await records.snapshot()).records[0].pendingMessages[0]).not.toHaveProperty(
      'deliveredAt'
    )
  })

  it('projects finalized child Artifact evidence from its execution-scoped owner', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const artifacts = [
      {
        id: 'artifact-version-1',
        artifactId: 'artifact-1',
        versionId: 'artifact-version-1',
        versionNumber: 1,
        checksum: 'abc123',
        createdAt: '2026-08-07T00:00:00.000Z',
        projectName: 'project-1',
        sessionId: 'session-1',
        runId: 'artifact-run-1',
        name: 'evidence.md',
        path: '/managed/evidence.md',
        fileUrl: 'file:///managed/evidence.md',
        mimeType: 'text/markdown',
        size: 8,
        mtimeMs: 1
      }
    ]
    const finalize = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ finalize, dispose }))
    const project = vi.fn(async () => artifacts)
    const artifactEvidence: DelegatedArtifactEvidence = { open, project }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = work.delegate(caller, { task: 'Create evidence' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(open).toHaveBeenCalledWith({
      session: caller.session,
      executionId: 'attempt-1',
      attemptId: 'attempt-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-frame-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-1',
      agentName: 'Main Agent'
    })
    execution.controls()[0].accept()
    execution.controls()[0].complete('Evidence is ready')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          terminalMessageId: 'message-2',
          artifactsCreated: artifacts
        }
      ]
    })
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: 'attempt-1',
        runtimeSegmentIds: ['runtime-1'],
        terminalMessageId: 'message-2'
      })
    )
    await expect(work.readAgentFrame(caller.session, 'frame-1')).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'Create evidence' },
        { role: 'assistant', content: 'Evidence is ready', artifacts }
      ]
    })
    expect((await records.snapshot()).records[0].attempts[0]).not.toHaveProperty('artifactsCreated')
  })

  it('reuses existing Review card projection after reopen without changing child lifecycle state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const persistedReview: ReviewWithChecks = {
      id: 'review-child-1',
      projectId: caller.session.projectId,
      sessionId: caller.session.sessionId,
      turnMessageId: 'message-2',
      scope: {
        turnMessageId: 'message-2',
        agentFrameId: 'frame-1',
        messageBranchId: 'branch-frame-1',
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'complete',
      outcome: 'flagged',
      model: 'reviewer-model',
      reviewerLog: [],
      createdAt: 20,
      updatedAt: 21,
      checks: [
        {
          id: 'check-1',
          reviewId: 'review-child-1',
          status: 'warn',
          claim: 'Qualification is missing',
          evidence: 'The terminal response overstates the result.',
          resolution: 'open',
          sortIndex: 0,
          reflagCount: 0
        }
      ]
    }
    const project = vi.fn(async () => [persistedReview])
    const reviewEvidence: DelegatedReviewEvidence = { project }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
    const first = createDurableDelegatedWork({
      execution,
      records,
      reviewEvidence,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = first.delegate(caller, { task: 'Review this child turn' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Child answer')
    await pending

    const beforeProjection = structuredClone((await records.snapshot()).records[0].attempts[0])
    await expect(first.readAgentFrame(caller.session, 'frame-1')).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Review this child turn' },
        { role: 'assistant', content: 'Child answer', reviews: [persistedReview] }
      ]
    })
    expect(project).toHaveBeenCalledWith({
      session: caller.session,
      attemptId: 'attempt-1',
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-frame-1',
      terminalMessageId: 'message-2',
      artifactVersionIds: []
    })

    const reopened = createDurableDelegatedWork({ execution, records, reviewEvidence })
    await expect(reopened.readAgentFrame(caller.session, 'frame-1')).resolves.toMatchObject({
      status: 'completed',
      messages: [{ role: 'user' }, { role: 'assistant', reviews: [persistedReview] }]
    })
    expect((await records.snapshot()).records[0].attempts[0]).toEqual(beforeProjection)
  })

  it('keeps Reviewer authority read-only across delegated lifecycle commands', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const pending = work.delegate(caller, { task: 'Immutable child lifecycle' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Done')
    const completed = await pending
    const frameId = completed.children[0].frameId
    const reviewer = {
      ...caller,
      role: 'reviewer' as const,
      toolInvocationId: 'reviewer-forged-command'
    }
    const before = await records.snapshot()

    await expect(work.delegate(reviewer, { task: 'forged dispatch' })).rejects.toMatchObject({
      code: 'authorization'
    })
    await expect(work.sendMessage(reviewer, frameId, 'forged resume')).rejects.toMatchObject({
      code: 'authorization'
    })
    await expect(work.stopChildren(reviewer, [frameId])).rejects.toMatchObject({
      code: 'authorization'
    })
    expect(await records.snapshot()).toEqual(before)
  })

  it('revokes a cancelled child Artifact handle before cancellation without affecting its sibling', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const lifecycle: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async ({ attemptId }) => ({
          execution: { currentRunFile: `/handoff/${attemptId}.json` },
          finalize: async () => {
            lifecycle.push(`finalize:${attemptId}`)
          },
          dispose: async () => {
            lifecycle.push(`dispose:${attemptId}`)
          }
        }),
        project: async () => []
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })
    const dispatched = await work.delegate(
      caller,
      [{ task: 'cancel me' }, { task: 'keep writing' }],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls().map(({ input }) => input.artifactCurrentRunFile)).toEqual([
      '/handoff/attempt-1.json',
      '/handoff/attempt-2.json'
    ])
    execution.controls()[0].accept()
    execution.controls()[1].accept()

    await work.stopChildren(caller, [dispatched.children[0].frameId])
    expect(lifecycle[0]).toBe('dispose:attempt-1')
    execution.controls()[1].complete('sibling evidence')

    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId)
      )
    ).resolves.toMatchObject([
      { status: 'cancelled' },
      { status: 'completed', response: 'sibling evidence' }
    ])
    expect(lifecycle).toContain('finalize:attempt-2')
  })

  it('keeps parallel child Artifact projections isolated when siblings finalize out of order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const finalized = new Set<string>()
    const evidenceFor = (attemptId: string): ArtifactFile[] => [
      {
        id: `version-${attemptId}`,
        projectName: 'project-1',
        sessionId: 'session-1',
        name: `${attemptId}.md`,
        path: `/managed/${attemptId}.md`,
        fileUrl: `file:///managed/${attemptId}.md`,
        size: 1,
        mtimeMs: 1,
        versionId: `version-${attemptId}`
      }
    ]
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async ({ attemptId }) => ({
          finalize: async () => {
            finalized.add(attemptId)
          },
          dispose: async () => undefined
        }),
        project: async ({ attemptId }) => (finalized.has(attemptId) ? evidenceFor(attemptId) : [])
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })
    const dispatched = await work.delegate(caller, [{ task: 'first' }, { task: 'second' }], {
      wait: false
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.control('attempt-2').complete('second done')
    execution.control('attempt-1').complete('first done')

    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId)
      )
    ).resolves.toMatchObject([
      { attemptId: 'attempt-1', artifactsCreated: [{ versionId: 'version-attempt-1' }] },
      { attemptId: 'attempt-2', artifactsCreated: [{ versionId: 'version-attempt-2' }] }
    ])
  })

  it('fails completion closed when Artifact finalization fails and preserves owner evidence', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const existing = {
      id: 'version-existing',
      projectName: 'project-1',
      sessionId: 'session-1',
      name: 'existing.md',
      path: '/managed/existing.md',
      fileUrl: 'file:///managed/existing.md',
      size: 1,
      mtimeMs: 1,
      versionId: 'version-existing'
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => ({
          finalize: async () => {
            throw new Error('Artifact finalization proof failed')
          },
          dispose: async () => undefined
        }),
        project: async () => [existing]
      }
    })
    const pending = work.delegate(caller, { task: 'fragile Artifact' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('response written before finalize')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'error',
          artifactsCreated: [existing],
          error: { code: 'execution_failure', message: 'Artifact finalization proof failed' }
        }
      ]
    })
    expect((await records.snapshot()).records[0].attempts[0]).not.toHaveProperty('artifactsCreated')
  })

  it('revokes an orphan Artifact capability during restart recovery while preserving durable evidence', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const opened = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => ({ finalize: async () => undefined, dispose: async () => undefined }),
        project: async () => []
      }
    })
    await opened.delegate(caller, { task: 'interrupted Artifact' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)

    const revoke = vi.fn(async () => undefined)
    const preserved = {
      id: 'version-preserved',
      projectName: 'project-1',
      sessionId: 'session-1',
      name: 'preserved.md',
      path: '/managed/preserved.md',
      fileUrl: 'file:///managed/preserved.md',
      size: 1,
      mtimeMs: 1,
      versionId: 'version-preserved'
    }
    const reopened = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => ({ finalize: async () => undefined, dispose: async () => undefined }),
        revoke,
        project: async () => [preserved]
      }
    })

    await expect(reopened.recoverInterrupted()).resolves.toMatchObject({
      interrupted: [
        {
          status: 'cancelled',
          cancellationReason: 'runtime_interrupted',
          artifactsCreated: [preserved]
        }
      ]
    })
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: expect.any(String),
        agentFrameId: expect.any(String),
        runtimeSegmentIds: [expect.any(String)]
      })
    )
  })

  it('disposes a capability that finishes opening after its Attempt was cancelled', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let resolveOpen!: (handle: {
      finalize(terminalMessageId: string): Promise<void>
      dispose(): Promise<void>
    }) => void
    const opening = new Promise<{
      finalize(terminalMessageId: string): Promise<void>
      dispose(): Promise<void>
    }>((resolve) => {
      resolveOpen = resolve
    })
    const dispose = vi.fn(async () => undefined)
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => opening,
        project: async () => []
      }
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'cancel while opening' },
      { wait: false }
    )
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0].runtimeSegmentIds)
      .toHaveLength(1)
    const stopping = work.stopChildren(caller, [dispatched.children[0].frameId])
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0].status)
      .toBe('cancelled')
    resolveOpen({ finalize: async () => undefined, dispose })

    await expect(stopping).resolves.toMatchObject([{ status: 'cancelled' }])
    await expect.poll(() => dispose).toHaveBeenCalled()
    expect(execution.controls()).toEqual([])
  })
  it('defaults an omitted profile to Main Agent without consulting a Specialist resolver', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async () => specialist())
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(caller, { task: 'Use the default agent' }, { wait: false })

    expect(resolveSpecialist).not.toHaveBeenCalled()
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual({
      kind: 'main'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).not.toHaveProperty('profile')
    await expect(
      work.readAgentFrame(caller.session, outcome.children[0].frameId)
    ).resolves.toMatchObject({ resolvedAgent: { kind: 'main' } })
  })

  it('resolves an explicit stable Specialist identity and preserves its dispatch snapshot', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const profile = specialist()
    const resolveSpecialist = vi.fn(async () => profile)
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(
      caller,
      { task: 'Audit the evidence', profile: 'specialist-stable-id' },
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledWith('specialist-stable-id')
    profile.displayName = 'Renamed after dispatch'
    profile.revision = 8
    const expectedSnapshot = {
      kind: 'specialist',
      profileId: 'specialist-stable-id',
      revision: 7,
      displayName: 'Evidence Analyst'
    }
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual(
      expectedSnapshot
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input.profile).toBe('specialist-stable-id')
    await expect(
      work.readAgentFrame(caller.session, outcome.children[0].frameId)
    ).resolves.toMatchObject({ resolvedAgent: expectedSnapshot })
    execution.controls()[0].accept()
    execution.controls()[0].complete('Specialist result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, outcome.children[0].frameId))
      .toMatchObject({ status: 'completed', resolvedAgent: expectedSnapshot })
  })

  it('rejects unknown, disabled, and setup-incomplete Specialists before reservation or mutation', async () => {
    for (const [profileId, resolved] of [
      ['unknown-id', undefined],
      ['disabled-id', specialist({ id: 'disabled-id', enabled: false })],
      ['setup-incomplete-id', specialist({ id: 'setup-incomplete-id', setupPending: true })]
    ] as const) {
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        resolveSpecialist: async () => resolved
      })

      await expect(
        work.delegate(
          { ...caller, toolInvocationId: `tool-call-${profileId}` },
          { task: 'Must not run', profile: profileId },
          { wait: false }
        )
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      expect(execution.reservationCounts()).toEqual([])
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('keeps Specialist history stable when the live profile is renamed, disabled, or deleted', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile: ReturnType<typeof specialist> | undefined = specialist()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => liveProfile
    })
    const first = await work.delegate(
      caller,
      { task: 'Preserve this history', profile: 'specialist-stable-id' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Historical result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, first.children[0].frameId))
      .toMatchObject({ status: 'completed' })

    liveProfile = specialist({ displayName: 'Renamed Specialist', revision: 8 })
    const afterRename = await work.delegate(
      { ...caller, toolInvocationId: 'renamed-redispatch' },
      { task: 'Resolve the renamed profile', profile: 'specialist-stable-id' },
      { wait: false }
    )
    expect((await records.snapshot()).records[1].attempts[0].resolvedAgent).toEqual({
      kind: 'specialist',
      profileId: 'specialist-stable-id',
      revision: 8,
      displayName: 'Renamed Specialist'
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.controls()[1].accept()
    execution.controls()[1].complete('Renamed result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, afterRename.children[0].frameId))
      .toMatchObject({ status: 'completed' })

    liveProfile = specialist({ displayName: 'Renamed Specialist', revision: 8, enabled: false })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'disabled-redispatch' },
        { task: 'Rejected after disable', profile: 'specialist-stable-id' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    liveProfile = undefined
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'deleted-redispatch' },
        { task: 'Rejected after delete', profile: 'specialist-stable-id' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })

    await expect(
      work.readAgentFrame(caller.session, first.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'completed',
      resolvedAgent: {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      }
    })
    expect((await records.snapshot()).records).toHaveLength(2)
    expect(execution.reservationCounts()).toEqual([1, 1])
  })

  it('admits an array atomically and starts every accepted child in request order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const prepared: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare(_session, frameId) {
          prepared.push(frameId)
          return new Promise(() => undefined)
        }
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })

    const outcome = await work.delegate(
      caller,
      [
        { task: 'First investigation', name: 'Explicit title' },
        { task: 'Second investigation' },
        { task: 'Second investigation' }
      ],
      { wait: false }
    )

    expect(execution.reservationCounts()).toEqual([3])
    expect(outcome).toEqual({
      kind: 'receipts',
      children: [
        { frameId: 'frame-1', attemptId: 'attempt-1', status: 'running' },
        { frameId: 'frame-2', attemptId: 'attempt-2', status: 'running' },
        { frameId: 'frame-3', attemptId: 'attempt-3', status: 'running' }
      ]
    })
    expect(prepared).toEqual(['frame-1', 'frame-2', 'frame-3'])
    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 3,
      children: [
        { frameId: 'frame-1', title: 'Explicit title', status: 'running' },
        { frameId: 'frame-2', title: 'Second investigation', status: 'running' },
        { frameId: 'frame-3', title: 'Second investigation (2)', status: 'running' }
      ]
    })
  })

  it('resolves every explicit Specialist in a batch before reserving and preserves each agent snapshot', async () => {
    const rejectedExecution = createDeterministicDelegateExecution()
    const rejectedRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const rejectedWork = createDurableDelegatedWork({
      execution: rejectedExecution,
      records: rejectedRecords,
      resolveSpecialist: async () => undefined
    })

    await expect(
      rejectedWork.delegate(
        caller,
        [{ task: 'Main child' }, { task: 'Unavailable child', profile: 'missing-profile' }],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(rejectedExecution.reservationCounts()).toEqual([])
    expect((await rejectedRecords.snapshot()).records).toEqual([])

    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async (profileId: string) => specialist({ id: profileId }))
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    await work.delegate(
      { ...caller, toolInvocationId: 'mixed-agent-batch' },
      [{ task: 'Default Main child' }, { task: 'Specialist child', profile: 'specialist-id' }],
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledTimes(1)
    expect(resolveSpecialist).toHaveBeenCalledWith('specialist-id')
    expect(execution.reservationCounts()).toEqual([2])
    expect(
      (await records.snapshot()).records.map((child) => child.attempts[0].resolvedAgent)
    ).toEqual([
      { kind: 'main' },
      {
        kind: 'specialist',
        profileId: 'specialist-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls().map((control) => control.input.profile)).toEqual([
      undefined,
      'specialist-id'
    ])
  })

  it('rejects an invalid or over-capacity array without any durable child state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: (identity) => identity.startsWith('upload-version:')
    })

    await expect(
      work.delegate(
        caller,
        [{ task: 'valid' }, { task: 'invalid', inputs: ['mutable/path.csv'] }],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate({ ...caller, toolInvocationId: 'empty-array' }, [], { wait: false })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.reservationCounts()).toEqual([])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })

    execution.rejectNextReservation('capacity', 'batch capacity unavailable')
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'capacity-array' },
        [{ task: 'one' }, { task: 'two' }],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'capacity', message: 'batch capacity unavailable' })
    expect(execution.reservationCounts()).toEqual([2])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })
  })

  it('fails closed when immutable inputs have no validator and passes the prepared Frame cwd to execution', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const unvalidated = createDurableDelegatedWork({ execution, records })

    await expect(
      unvalidated.delegate(
        caller,
        { task: 'inspect', inputs: ['upload-version:one'] },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.controls()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])

    const prepared = createDurableDelegatedWork({
      execution,
      records,
      validateInput: () => true,
      workspace: {
        prepare: async () => ({ cwd: '/stable/frame-workspace' })
      },
      createId: (kind) =>
        ({
          frame: 'cwd-frame',
          attempt: 'cwd-attempt',
          message: 'cwd-message',
          runtime: 'cwd-runtime'
        })[kind]
    })
    const result = prepared.delegate(
      { ...caller, toolInvocationId: 'validated-cwd' },
      { task: 'inspect', inputs: ['upload-version:one'] }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).toMatchObject({
      workspaceCwd: '/stable/frame-workspace'
    })
    execution.control('cwd-attempt').accept()
    execution.control('cwd-attempt').complete('done')
    await result
  })

  it('leaves no partial durable batch when atomic admission rejects after reservation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `duplicate-${kind}`
    })

    await expect(
      work.delegate(caller, [{ task: 'one' }, { task: 'two' }], { wait: false })
    ).rejects.toThrow('Duplicate delegated-work identity')
    expect(execution.reservationCounts()).toEqual([2])
    expect(execution.controls()).toEqual([])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })
  })

  it('isolates sibling terminal outcomes and returns wait results in request order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const pending = work.delegate(caller, [
      { task: 'complete last' },
      { task: 'fail first' },
      { task: 'cancel second' }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(3)
    for (const control of execution.controls()) control.accept()
    execution.controls()[1].fail(new Error('provider startup failed'))
    execution.controls()[2].cancel()

    await expect
      .poll(() => work.children(caller))
      .toEqual([
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'complete last',
          status: 'running'
        },
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'fail first',
          status: 'error'
        },
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'cancel second',
          status: 'cancelled'
        }
      ])
    execution.controls()[0].complete('surviving evidence')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        { status: 'completed', response: 'surviving evidence' },
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'provider startup failed' }
        },
        { status: 'cancelled', cancellationReason: 'main_agent_stop' }
      ]
    })
  })

  it('terminalizes one child finalization failure without cancelling its sibling', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let failFirstCompletion = true
    const records: typeof durableRecords = {
      ...durableRecords,
      async terminalize(input) {
        if (failFirstCompletion && input.frameId === 'frame-1' && input.status === 'completed') {
          failFirstCompletion = false
          throw new Error('terminal assistant Message write failed')
        }
        await durableRecords.terminalize(input)
      }
    }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = work.delegate(caller, [{ task: 'fragile finalization' }, { task: 'sibling' }])
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.controls()[0].complete('lost response')
    execution.controls()[1].complete('preserved response')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          frameId: 'frame-1',
          status: 'error',
          error: {
            code: 'execution_failure',
            message: 'terminal assistant Message write failed'
          }
        },
        { frameId: 'frame-2', status: 'completed', response: 'preserved response' }
      ]
    })
  })

  it('keeps children in admission order and collects selected children in caller order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `${kind}-${nextId++}`
    })

    const dispatched = await work.delegate(caller, [{ task: 'alpha' }, { task: 'beta' }], {
      wait: false
    })
    const [alpha, beta] = dispatched.children
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.control(alpha.attemptId).accept()
    execution.control(beta.attemptId).accept()
    execution.control(beta.attemptId).complete('B')

    const collecting = work.collect(caller, [beta.frameId, alpha.frameId])
    await expect
      .poll(() => work.children(caller))
      .toMatchObject([
        { frameId: alpha.frameId, status: 'running' },
        { frameId: beta.frameId, status: 'completed' }
      ])
    execution.control(alpha.attemptId).complete('A')

    await expect(collecting).resolves.toMatchObject([
      { frameId: beta.frameId, response: 'B' },
      { frameId: alpha.frameId, response: 'A' }
    ])
  })

  it('blocks by default and projects the result from the durable terminal Message', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const pending = work.delegate(caller, { task: 'Trace the source', name: 'Source trace' })

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toEqual({
        runningCount: 1,
        children: [
          {
            frameId: expect.any(String),
            title: 'Source trace',
            status: 'running'
          }
        ]
      })
    execution.controls()[0].accept()
    execution.controls()[0].complete('The durable answer')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          response: 'The durable answer',
          terminalMessageId: expect.any(String),
          artifactsCreated: []
        }
      ]
    })
    const durable = await records.snapshot()
    expect(durable.records[0].attempts[0]).not.toHaveProperty('response')
    expect(durable.messages.find((message) => message.role === 'assistant')?.content).toBe(
      'The durable answer'
    )
  })

  it('returns durable cancelled and error results from the default blocking call', async () => {
    const cancelledExecution = createDeterministicDelegateExecution()
    const cancelledRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const cancelledWork = createDurableDelegatedWork({
      execution: cancelledExecution,
      records: cancelledRecords
    })
    const cancelledPending = cancelledWork.delegate(caller, { task: 'Cancelable work' })
    await expect.poll(() => cancelledExecution.controls()).toHaveLength(1)
    cancelledExecution.controls()[0].accept()
    cancelledExecution.controls()[0].cancel()

    await expect(cancelledPending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'cancelled',
          cancellationReason: 'main_agent_stop',
          artifactsCreated: []
        }
      ]
    })

    const failedExecution = createDeterministicDelegateExecution()
    failedExecution.plan({ status: 'failed', error: new Error('provider startup failed') })
    const failedRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const failedWork = createDurableDelegatedWork({
      execution: failedExecution,
      records: failedRecords
    })

    await expect(
      failedWork.delegate(
        { ...caller, toolInvocationId: 'failed-tool-call' },
        { task: 'Fragile work' }
      )
    ).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'provider startup failed' },
          artifactsCreated: []
        }
      ]
    })
  })

  it('validates authenticated admission before reserving or creating durable state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: async (identity) => identity.startsWith('upload-version:')
    })

    await expect(
      work.delegate(
        { ...caller, originMessageId: 'forged-origin', toolInvocationId: 'forged-call' },
        { task: 'private' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'bad-input-call' },
        { task: 'inspect', inputs: ['workspace/current.csv'] },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'profile-call' },
        { task: 'inspect', profile: '' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    for (const [toolInvocationId, request] of [
      ['blank-task-call', { task: '   ' }],
      ['blank-name-call', { task: 'inspect', name: '   ' }],
      ['blank-context-call', { task: 'inspect', context: '   ' }]
    ] as const) {
      await expect(
        work.delegate({ ...caller, toolInvocationId }, request, { wait: false })
      ).rejects.toMatchObject({ code: 'admission_rejection' })
    }

    expect(execution.controls()).toEqual([])
    expect(execution.reservationCounts()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
  })

  it('rejects unavailable delegated-work capability or framework before reserving durable work', async () => {
    for (const availabilityError of [
      new Error('delegated-work capability is unavailable'),
      new Error('framework cannot isolate delegated execution')
    ]) {
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        assertAvailable: async () => {
          throw availabilityError
        }
      })

      await expect(
        work.delegate(caller, { task: 'Must not be admitted' }, { wait: false })
      ).rejects.toMatchObject({ code: 'unsupported_framework', message: availabilityError.message })
      expect(execution.reservationCounts()).toEqual([])
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('deduplicates the same authenticated delivery and exposes read-only child conversation detail', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const first = await work.delegate(caller, { task: 'One child' }, { wait: false })
    const duplicate = await work.delegate(caller, { task: 'Ignored duplicate' }, { wait: false })

    expect(duplicate).toEqual(first)
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect((await records.snapshot()).records).toHaveLength(1)
    const frameId = first.children[0].frameId
    const detail = await work.readAgentFrame(caller.session, frameId)
    expect(detail).toEqual({
      frameId,
      title: 'One child',
      status: 'running',
      resolvedAgent: { kind: 'main' },
      messages: [{ role: 'user', content: 'One child' }]
    })
    expect(Object.isFrozen(detail)).toBe(true)
    expect(Object.isFrozen(detail?.messages)).toBe(true)
  })

  it('isolates a child workspace startup failure while its accepted sibling continues', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const workspaceSettlers: Array<{
      resolve(value: { cwd: string }): void
      reject(error: Error): void
    }> = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        prepare: async () =>
          new Promise<{ cwd: string }>((resolve, reject) => {
            workspaceSettlers.push({ resolve, reject })
          })
      }
    })

    const receipt = await work.delegate(
      caller,
      [{ task: 'Prepare inputs' }, { task: 'Fragile staging' }],
      { wait: false }
    )
    expect(receipt).toMatchObject({
      kind: 'receipts',
      children: [{ status: 'running' }, { status: 'running' }]
    })
    expect(workspaceSettlers).toHaveLength(2)
    workspaceSettlers[1].reject(new Error('immutable input staging failed'))
    workspaceSettlers[0].resolve({ cwd: '/workspace/first' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 1,
        children: [
          {
            frameId: receipt.children[0].frameId,
            status: 'running'
          },
          {
            frameId: receipt.children[1].frameId,
            status: 'error'
          }
        ]
      })
    execution.controls()[0].complete('sibling completed')
    await expect(work.collect(caller, [receipt.children[0].frameId])).resolves.toMatchObject([
      { status: 'completed', response: 'sibling completed' }
    ])
  })

  it('stops a direct child without changing its running sibling or accepting late completion', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => specialist(),
      createId: (kind) => `${kind}-${nextId++}`
    })
    const first = await work.delegate(
      caller,
      { task: 'Stop me', profile: 'specialist-stable-id' },
      { wait: false }
    )
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Keep running' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)

    await expect(work.stopChildren(caller, [first.children[0].frameId])).resolves.toEqual([
      { frameId: first.children[0].frameId, status: 'cancelled' }
    ])
    execution.controls()[0].complete('too late')

    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 1,
      children: [
        { frameId: first.children[0].frameId, title: 'Stop me', status: 'cancelled' },
        { frameId: second.children[0].frameId, title: 'Keep running', status: 'running' }
      ]
    })
    await expect(work.readAgentFrame(caller.session, first.children[0].frameId)).resolves.toEqual({
      frameId: first.children[0].frameId,
      title: 'Stop me',
      status: 'cancelled',
      resolvedAgent: {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      },
      messages: [{ role: 'user', content: 'Stop me' }]
    })
  })

  it('stops the running Session snapshot while preserving terminal history and rejecting new dispatch', async () => {
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'completed', response: 'Keep this evidence' })
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      settleAttemptCleanup: async () => cleanup,
      createId: (kind) => `${kind}-${nextId++}`
    })
    const completed = await work.delegate(caller, { task: 'Already done' })
    const first = await work.delegate(
      { ...caller, toolInvocationId: 'running-1' },
      { task: 'Running one' },
      { wait: false }
    )
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'running-2' },
      { task: 'Running two' },
      { wait: false }
    )

    const stopping = work.stopSession(caller.session)
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'rejected-during-stop' },
        { task: 'Too late' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    releaseCleanup()

    await expect(stopping).resolves.toEqual([
      { frameId: first.children[0].frameId, status: 'cancelled' },
      { frameId: second.children[0].frameId, status: 'cancelled' }
    ])
    await expect(
      work.readAgentFrame(caller.session, completed.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Already done' },
        { role: 'assistant', content: 'Keep this evidence' }
      ]
    })
  })

  it('recovers persisted running Attempts as interrupted without restarting a child or deleting its workspace', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const deleteSession = vi.fn(async () => undefined)
    const beforeRestart = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => specialist()
    })
    const receipt = await beforeRestart.delegate(
      caller,
      { task: 'Interrupted', profile: 'specialist-stable-id' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)

    const afterRestart = createDurableDelegatedWork({
      execution,
      records,
      workspace: { prepare: async () => ({ cwd: '/stable-frame' }), deleteSession }
    })
    await expect(afterRestart.recoverInterrupted()).resolves.toEqual({
      interrupted: [
        {
          frameId: receipt.children[0].frameId,
          attemptId: receipt.children[0].attemptId,
          status: 'cancelled',
          cancellationReason: 'runtime_interrupted',
          artifactsCreated: []
        }
      ]
    })

    expect(execution.controls()).toHaveLength(1)
    expect(deleteSession).not.toHaveBeenCalled()
    expect((await records.snapshot()).records[0].attempts).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        cancellationReason: 'runtime_interrupted',
        resolvedAgent: {
          kind: 'specialist',
          profileId: 'specialist-stable-id',
          revision: 7,
          displayName: 'Evidence Analyst'
        }
      })
    ])
  })

  it('deletes child workspaces only after Session children have terminal history', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const observedStatuses: string[][] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        prepare: async () => ({ cwd: '/stable-frame' }),
        deleteSession: async () => {
          observedStatuses.push(
            (await records.snapshot()).records.map((child) => child.attempts.at(-1)!.status)
          )
        }
      }
    })
    await work.delegate(caller, { task: 'Delete safely' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)

    await work.deleteSession(caller.session)

    expect(observedStatuses).toEqual([['cancelled']])
  })

  it('lists only the authenticated Main Agent direct children in durable admission order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const first = await work.delegate(
      caller,
      { task: 'First task', name: 'First' },
      { wait: false }
    )
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Second task', name: 'Second' },
      { wait: false }
    )

    await expect(work.children(caller)).resolves.toEqual([
      {
        frameId: first.children[0].frameId,
        attemptId: first.children[0].attemptId,
        title: 'First',
        status: 'running'
      },
      {
        frameId: second.children[0].frameId,
        attemptId: second.children[0].attemptId,
        title: 'Second',
        status: 'running'
      }
    ])
    await expect(
      work.children({ ...caller, session: { ...caller.session, sessionId: 'session-2' } })
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(work.children({ ...caller, frameId: 'other-parent' })).rejects.toMatchObject({
      code: 'authorization'
    })
  })

  it('projects explicitly requested direct children in request order and rejects the whole unauthorized set', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const first = await work.delegate(caller, { task: 'First' }, { wait: false })
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Second' },
      { wait: false }
    )
    const firstId = first.children[0].frameId
    const secondId = second.children[0].frameId

    await expect(work.children(caller, [secondId, firstId])).resolves.toEqual([
      {
        frameId: secondId,
        attemptId: second.children[0].attemptId,
        title: 'Second',
        status: 'running'
      },
      {
        frameId: firstId,
        attemptId: first.children[0].attemptId,
        title: 'First',
        status: 'running'
      }
    ])
    await expect(work.children(caller, [firstId, 'unknown-frame'])).rejects.toMatchObject({
      code: 'authorization'
    })

    const unrelatedParentView = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records: {
        ...records,
        async snapshot() {
          const snapshot = await records.snapshot()
          return {
            ...snapshot,
            records: snapshot.records.map((child) => ({
              ...child,
              parentFrameId: child.frameId === firstId ? 'another-parent' : child.parentFrameId
            }))
          }
        }
      }
    })
    await expect(unrelatedParentView.children(caller, [firstId])).rejects.toMatchObject({
      code: 'authorization'
    })
    await expect(unrelatedParentView.collect(caller, [firstId])).rejects.toMatchObject({
      code: 'authorization'
    })
  })

  it('collects durable terminal results after reopen only when every requested child is terminal', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const dispatchingWork = createDurableDelegatedWork({ execution, records })
    const first = await dispatchingWork.delegate(caller, { task: 'First' }, { wait: false })
    const second = await dispatchingWork.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Second' },
      { wait: false }
    )
    const firstId = first.children[0].frameId
    const secondId = second.children[0].frameId
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.controls()[0].accept()
    execution.controls()[1].accept()

    const reopenedWork = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records
    })
    let settled = false
    const pending = reopenedWork.collect(caller, [secondId, firstId]).finally(() => {
      settled = true
    })
    execution.controls()[1].complete('Second durable answer')
    await expect
      .poll(async () => (await dispatchingWork.children(caller, [secondId]))[0].status)
      .toBe('completed')
    expect(settled).toBe(false)

    execution.controls()[0].complete('First durable answer')
    await expect(pending).resolves.toEqual([
      {
        frameId: secondId,
        attemptId: second.children[0].attemptId,
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'Second durable answer',
        artifactsCreated: []
      },
      {
        frameId: firstId,
        attemptId: first.children[0].attemptId,
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'First durable answer',
        artifactsCreated: []
      }
    ])
    await expect(reopenedWork.children(caller)).resolves.toEqual([
      {
        frameId: firstId,
        attemptId: first.children[0].attemptId,
        title: 'First',
        status: 'completed'
      },
      {
        frameId: secondId,
        attemptId: second.children[0].attemptId,
        title: 'Second',
        status: 'completed'
      }
    ])
  })

  it('treats cancelled and error children as terminal and rejects unauthorized collect targets', async () => {
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'failed', error: new Error('safe provider failure') })
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const failed = await work.delegate(caller, { task: 'Failure' }, { wait: false })
    const cancelled = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Cancellation' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.controls()[1].accept()
    execution.controls()[1].cancel()

    await expect(
      work.collect(caller, [cancelled.children[0].frameId, failed.children[0].frameId])
    ).resolves.toEqual([
      {
        frameId: cancelled.children[0].frameId,
        attemptId: cancelled.children[0].attemptId,
        status: 'cancelled',
        artifactsCreated: [],
        cancellationReason: 'main_agent_stop'
      },
      {
        frameId: failed.children[0].frameId,
        attemptId: failed.children[0].attemptId,
        status: 'error',
        artifactsCreated: [],
        error: { code: 'execution_failure', message: 'safe provider failure' }
      }
    ])
    await expect(work.collect(caller, [])).rejects.toMatchObject({
      code: 'admission_rejection'
    })
    await expect(
      work.collect(caller, [failed.children[0].frameId, 'unknown-frame'])
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.collect({ ...caller, session: { ...caller.session, sessionId: 'session-2' } }, [
        failed.children[0].frameId
      ])
    ).rejects.toMatchObject({ code: 'authorization' })
  })

  it('keeps lifecycle state unchanged when a children query fails and allows a clean retry', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const lifecycleWork = createDurableDelegatedWork({ execution, records })
    const receipt = await lifecycleWork.delegate(caller, { task: 'Keep running' }, { wait: false })
    let failNextRead = true
    const observingWork = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records: {
        ...records,
        async snapshot() {
          if (failNextRead) {
            failNextRead = false
            throw new Error('temporary Session read failure')
          }
          return records.snapshot()
        }
      }
    })

    await expect(observingWork.children(caller)).rejects.toThrow('temporary Session read failure')
    await expect(lifecycleWork.children(caller)).resolves.toMatchObject([
      { frameId: receipt.children[0].frameId, status: 'running' }
    ])
    await expect(observingWork.children(caller)).resolves.toMatchObject([
      { frameId: receipt.children[0].frameId, status: 'running' }
    ])
  })

  it('continues a terminal Main Agent child in the same Frame and conversation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const workspaceFrames: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare(_session, frameId) {
          workspaceFrames.push(frameId)
          return { cwd: `/workspaces/${frameId}` }
        }
      }
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'Inspect the evidence' },
      { wait: false }
    )
    const frameId = dispatched.children[0].frameId
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input.runtimeSegmentId).toBe(
      (await records.snapshot()).records[0].attempts[0].runtimeSegmentIds[0]
    )
    execution.controls()[0].accept()
    execution.controls()[0].complete('Initial finding')
    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 0,
        children: [{ frameId, status: 'completed' }]
      })

    const continued = await work.sendMessage(
      { ...caller, toolInvocationId: 'continuation-call' },
      frameId,
      'Check a counterexample'
    )

    expect(continued).toMatchObject({
      kind: 'continued',
      child: { frameId, status: 'running' }
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input.runtimeSegmentId).toBe(
      (await records.snapshot()).records[0].attempts[1].runtimeSegmentIds[0]
    )
    expect(execution.controls()[1].input).toMatchObject({
      frameId,
      task: 'Check a counterexample',
      continuation: true
    })
    expect(execution.controls()[1].input).not.toHaveProperty('profile')
    expect(workspaceFrames).toEqual([frameId, frameId])
    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 1,
      children: [{ frameId, title: 'Inspect the evidence', status: 'running' }]
    })
    await expect(work.readAgentFrame(caller.session, frameId)).resolves.toMatchObject({
      frameId,
      title: 'Inspect the evidence',
      status: 'running',
      resolvedAgent: { kind: 'main' },
      messages: [
        { role: 'user', content: 'Inspect the evidence' },
        { role: 'assistant', content: 'Initial finding' },
        { role: 'user', content: 'Check a counterexample' }
      ]
    })
    expect((await records.snapshot()).records).toHaveLength(1)
    expect((await records.snapshot()).records[0].attempts).toHaveLength(2)
  })

  it('re-resolves a terminal Specialist by stable identity while retaining its prior snapshot', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile = specialist()
    const resolveSpecialist = vi.fn(async () => liveProfile)
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })
    const dispatched = await work.delegate(
      caller,
      { task: 'Specialist analysis', profile: liveProfile.id },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('First analysis')
    await expect.poll(async () => (await work.sessionSummary(caller.session)).runningCount).toBe(0)
    liveProfile = specialist({ displayName: 'Renamed Evidence Analyst', revision: 8 })

    await work.sendMessage(
      { ...caller, toolInvocationId: 'specialist-continuation' },
      dispatched.children[0].frameId,
      'Recheck the analysis'
    )

    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input.profile).toBe('specialist-stable-id')
    const attempts = (await records.snapshot()).records[0].attempts
    expect(attempts.map(({ resolvedAgent }) => resolvedAgent)).toEqual([
      {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      },
      {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 8,
        displayName: 'Renamed Evidence Analyst'
      }
    ])
    expect(resolveSpecialist).toHaveBeenLastCalledWith('specialist-stable-id')
  })

  it('leaves terminal Specialist history unchanged when continuation re-resolution is unavailable', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile: ReturnType<typeof specialist> | undefined = specialist()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => liveProfile
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'Preserve terminal evidence', profile: 'specialist-stable-id' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Historical evidence')
    await expect.poll(async () => (await work.sessionSummary(caller.session)).runningCount).toBe(0)
    const before = await records.snapshot()

    for (const [toolInvocationId, unavailable] of [
      ['disabled-continuation', specialist({ enabled: false })],
      ['deleted-continuation', undefined]
    ] as const) {
      liveProfile = unavailable
      await expect(
        work.sendMessage(
          { ...caller, toolInvocationId },
          dispatched.children[0].frameId,
          'Must not mutate history'
        )
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      expect(await records.snapshot()).toEqual(before)
    }
    expect(execution.reservationCounts()).toEqual([1])
  })

  it('queues a message without creating a continuation while the latest Attempt is running', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(caller, { task: 'Still running' }, { wait: false })

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'overlapping-continuation' },
        dispatched.children[0].frameId,
        'Do not overlap'
      )
    ).resolves.toMatchObject({
      kind: 'queued',
      targetFrameId: dispatched.children[0].frameId,
      attemptId: dispatched.children[0].attemptId
    })
    expect((await records.snapshot()).records[0].attempts).toHaveLength(1)
    expect((await records.snapshot()).messages).toHaveLength(1)
    expect(execution.reservationCounts()).toEqual([1])
  })

  it('terminalizes only each new Attempt when continuation startup fails', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let prepares = 0
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare() {
          prepares += 1
          if (prepares === 2) throw new Error('continuation workspace failed')
          return { cwd: '/stable-frame-workspace' }
        }
      }
    })
    const dispatched = await work.delegate(caller, { task: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Preserved answer')
    await expect.poll(async () => (await work.sessionSummary(caller.session)).runningCount).toBe(0)

    await work.sendMessage(
      { ...caller, toolInvocationId: 'failed-startup-continuation' },
      dispatched.children[0].frameId,
      'Continuation that cannot start'
    )

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 0,
        children: [{ frameId: dispatched.children[0].frameId, status: 'error' }]
      })
    const snapshot = await records.snapshot()
    expect(snapshot.records[0].attempts).toMatchObject([
      { status: 'completed', terminalMessageId: expect.any(String) },
      {
        status: 'error',
        error: { code: 'execution_failure', message: 'continuation workspace failed' }
      }
    ])
    expect(snapshot.messages.map(({ content }) => content)).toEqual([
      'Initial task',
      'Preserved answer',
      'Continuation that cannot start'
    ])
    expect(execution.controls()).toHaveLength(1)

    execution.plan({ status: 'failed', error: new Error('continuation provider failed') })
    await work.sendMessage(
      { ...caller, toolInvocationId: 'failed-provider-continuation' },
      dispatched.children[0].frameId,
      'Retry after workspace recovery'
    )
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts)
      .toMatchObject([
        { status: 'completed', terminalMessageId: expect.any(String) },
        { status: 'error', error: { message: 'continuation workspace failed' } },
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'continuation provider failed' }
        }
      ])
    expect((await records.snapshot()).messages.map(({ content }) => content)).toEqual([
      'Initial task',
      'Preserved answer',
      'Continuation that cannot start',
      'Retry after workspace recovery'
    ])
  })
})
