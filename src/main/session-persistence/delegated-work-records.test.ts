import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import type { CreateChildRecordInput } from '../delegated-work/session-records'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from './coordinator'

const key = { projectId: 'project-1', sessionId: 'session-1' } as const

const rootPrompt: PersistedChatMessage = {
  id: 'root-prompt',
  role: 'user',
  content: 'Coordinate the research.',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
}

const createRootSession = (): PersistedChatSession => ({
  id: key.sessionId,
  projectId: key.projectId,
  title: 'Delegated research',
  cwd: '/workspace',
  status: 'idle',
  messages: [rootPrompt],
  conversationGraph: createLinearConversationGraph({
    sessionId: key.sessionId,
    messages: [rootPrompt],
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1
  }),
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2
})

type Harness = Readonly<{
  coordinator: SessionPersistenceCoordinator
  repository: SessionMutationRepository
  durable(): PersistedChatSession
}>

const createHarness = (seed = createRootSession()): Harness => {
  let durable = structuredClone(seed)
  const repository: SessionMutationRepository = {
    loadAllWithDiagnostics: vi.fn(async () => ({
      result: { sessions: [structuredClone(durable)], manifest: { version: 1 as const } },
      isComplete: true
    })),
    loadProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    })),
    loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    })),
    loadSessionWithDiagnostics: vi.fn(async () => ({
      status: 'found' as const,
      session: structuredClone(durable)
    })),
    saveSession: vi.fn(async (session) => {
      durable = structuredClone(session)
    }),
    saveCommittedProjectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    deleteProjectSessions: vi.fn(async () => undefined),
    getProjectSessionDeletionState: vi.fn(async () => 'absent' as const),
    markCommittedProjectSessionsPrepared: vi.fn(async () => undefined),
    completeProjectSessionDeletion: vi.fn(async () => undefined),
    listLegacyProjectSessionTombstones: vi.fn(async () => []),
    saveManifest: vi.fn(async () => undefined)
  }
  const fileIndex: SessionFileIndex = {
    syncSession: vi.fn(async () => []),
    softDeleteSession: vi.fn(async () => 'session-delete'),
    restoreSession: vi.fn(async () => undefined),
    softDeleteProject: vi.fn(async () => 'project-delete'),
    reconcileActiveSessions: vi.fn(async () => undefined),
    markReconciliationIncomplete: vi.fn()
  }
  return {
    coordinator: new SessionPersistenceCoordinator(repository, fileIndex),
    repository,
    durable: () => structuredClone(durable)
  }
}

const child = (
  index: number,
  overrides: Partial<{
    task: string
    name: string
  }> = {}
): CreateChildRecordInput => ({
  frameId: `child-frame-${index}`,
  branchId: `child-branch-${index}`,
  messageId: `child-prompt-${index}`,
  attemptId: `attempt-${index}`,
  task: overrides.task ?? `Research part ${index}`,
  ...(overrides.name ? { name: overrides.name } : {}),
  resolvedAgent: { kind: 'main' as const },
  startedAt: 10 + index,
  callerSource: { rootMessageId: 'root-prompt', toolInvocationId: `delegate-${index}` },
  initiatingTurnMessageId: 'root-prompt'
})

describe('delegated-work Session records', () => {
  it('atomically owns the complete delegate subtree across stale Renderer saves', async () => {
    const initial = createRootSession()
    const { coordinator, durable } = createHarness(initial)
    const rootFrameId = initial.conversationGraph!.rootFrameId

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1, { name: 'Evidence' }), child(2, { name: 'Risks' })]
      })
    ).resolves.toEqual([
      { frameId: 'child-frame-1', attemptId: 'attempt-1', status: 'running' },
      { frameId: 'child-frame-2', attemptId: 'attempt-2', status: 'running' }
    ])
    await coordinator.startAttemptRuntime(key, {
      expectedRevision: 1,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      runtimeSegmentId: 'segment-1',
      frameworkId: 'codex',
      startedAt: 20
    })
    expect(
      durable().conversationGraph?.messages.find(({ id }) => id === 'child-prompt-1')
    ).toMatchObject({ runtimeSegmentId: 'segment-1' })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 2,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: {
        kind: 'message',
        runtimeSegmentId: 'segment-1',
        message: {
          id: 'child-answer-1',
          role: 'agent',
          content: 'Evidence found.',
          status: 'complete',
          eventIds: ['event-1'],
          createdAt: 21,
          updatedAt: 21
        }
      }
    })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 3,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: {
        kind: 'activity',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'child-prompt-1',
        activity: {
          id: 'activity-1',
          kind: 'tool',
          title: 'Search evidence',
          activityGroupId: 'activity-group-1',
          status: 'completed',
          sortIndex: 0,
          eventIds: ['event-1'],
          createdAt: 20,
          updatedAt: 21
        }
      }
    })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 4,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: {
        kind: 'activity-group',
        promptMessageId: 'child-prompt-1',
        activityGroup: {
          id: 'activity-group-1',
          title: 'Research',
          sortIndex: 0,
          activityIds: ['activity-1'],
          createdAt: 20,
          updatedAt: 21,
          completedAt: 21
        }
      }
    })

    await coordinator.saveSession({ ...initial, title: 'Renderer rename', updatedAt: 3 })

    const stored = durable()
    expect(stored.title).toBe('Renderer rename')
    expect(stored.runtimeContext).toMatchObject({
      revision: 5,
      delegatedWork: {
        records: [
          { agentFrameId: 'child-frame-1', attempts: [{ id: 'attempt-1' }] },
          { agentFrameId: 'child-frame-2', attempts: [{ id: 'attempt-2' }] }
        ]
      }
    })
    expect(stored.conversationGraph).toMatchObject({
      frames: expect.arrayContaining([
        expect.objectContaining({ id: 'child-frame-1', status: 'running' }),
        expect.objectContaining({ id: 'child-frame-2', status: 'running' })
      ]),
      branches: expect.arrayContaining([expect.objectContaining({ id: 'child-branch-1' })]),
      messages: expect.arrayContaining([expect.objectContaining({ id: 'child-answer-1' })]),
      activities: [expect.objectContaining({ id: 'activity-1' })],
      activityGroups: [expect.objectContaining({ id: 'activity-group-1' })],
      runtimeSegments: expect.arrayContaining([expect.objectContaining({ id: 'segment-1' })])
    })
  })

  it('fences terminal Attempts and admits only one same-Frame continuation', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    await coordinator.startAttemptRuntime(key, {
      expectedRevision: 1,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      runtimeSegmentId: 'segment-1',
      frameworkId: 'codex',
      startedAt: 20
    })
    await coordinator.applyAgentEvent(key, {
      expectedRevision: 2,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      event: {
        kind: 'message',
        runtimeSegmentId: 'segment-1',
        message: {
          id: 'terminal-1',
          role: 'agent',
          content: 'Done.',
          status: 'complete',
          eventIds: [],
          createdAt: 21,
          updatedAt: 21
        }
      }
    })
    await coordinator.transitionAttempt(key, {
      expectedRevision: 3,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      status: 'completed',
      endedAt: 22,
      terminalMessageId: 'terminal-1'
    })

    const attempts = await Promise.allSettled([
      coordinator.startContinuationAttempt(key, {
        expectedRevision: 4,
        frameId: 'child-frame-1',
        previousAttemptId: 'attempt-1',
        attemptId: 'attempt-2',
        messageId: 'continuation-2',
        message: 'Check one more source.',
        resolvedAgent: { kind: 'main' },
        startedAt: 23,
        callerSource: { rootMessageId: 'root-prompt', toolInvocationId: 'continue-2' },
        initiatingTurnMessageId: 'root-prompt'
      }),
      coordinator.startContinuationAttempt(key, {
        expectedRevision: 4,
        frameId: 'child-frame-1',
        previousAttemptId: 'attempt-1',
        attemptId: 'attempt-3',
        messageId: 'continuation-3',
        message: 'Competing continuation.',
        resolvedAgent: { kind: 'main' },
        startedAt: 23,
        callerSource: { rootMessageId: 'root-prompt', toolInvocationId: 'continue-3' },
        initiatingTurnMessageId: 'root-prompt'
      })
    ])

    expect(attempts.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(
      coordinator.applyAgentEvent(key, {
        expectedRevision: 5,
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        event: {
          kind: 'message',
          runtimeSegmentId: 'segment-1',
          message: {
            id: 'late-message',
            role: 'agent',
            content: 'Too late.',
            status: 'complete',
            eventIds: [],
            createdAt: 24,
            updatedAt: 24
          }
        }
      })
    ).rejects.toMatchObject({ code: 'attempt-conflict' })
    await expect(coordinator.readChildren(key, rootFrameId)).resolves.toMatchObject([
      {
        frameId: 'child-frame-1',
        status: 'running',
        record: { attempts: [{ id: 'attempt-1', status: 'completed' }, { status: 'running' }] }
      }
    ])
  })

  it('does not publish partial child state when the atomic Session save fails', async () => {
    const { coordinator, repository, durable } = createHarness()
    const rootFrameId = durable().conversationGraph!.rootFrameId
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('durability unavailable'))

    await expect(
      coordinator.createChildren(key, {
        expectedRevision: 0,
        parentFrameId: rootFrameId,
        originMessageId: rootPrompt.id,
        children: [child(1)]
      })
    ).rejects.toThrow('durability unavailable')

    await expect(coordinator.readChildren(key, rootFrameId)).resolves.toEqual([])
    expect(durable().runtimeContext).toBeUndefined()
    expect(durable().conversationGraph!.frames).toHaveLength(1)
  })

  it('recovers running Attempts as interrupted without replaying pending messages', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    await coordinator.appendPendingMessage(key, {
      expectedRevision: 1,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      message: {
        id: 'pending-1',
        sourceFrameId: rootFrameId,
        targetFrameId: 'child-frame-1',
        targetAttemptId: 'attempt-1',
        text: 'Additional context',
        kind: 'info',
        createdAt: 20
      }
    })

    await expect(coordinator.recoverInterruptedDelegatedWork()).resolves.toEqual([
      { frameId: 'child-frame-1', attemptId: 'attempt-1' }
    ])
    await expect(coordinator.recoverInterruptedDelegatedWork()).resolves.toEqual([])
    const [recovered] = await coordinator.readChildren(key, rootFrameId)
    expect(recovered).toMatchObject({
      status: 'cancelled',
      record: {
        attempts: [
          {
            status: 'cancelled',
            cancellationReason: 'runtime_interrupted'
          }
        ],
        pendingMessages: [{ id: 'pending-1' }]
      }
    })
    expect(recovered.record.pendingMessages[0]).not.toHaveProperty('deliveredAt')
  })

  it('marks only the addressed upward message and fences late delivery after terminal', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })
    for (const [revision, id] of [
      [1, 'question-1'],
      [2, 'question-2']
    ] as const) {
      await coordinator.appendPendingMessage(key, {
        expectedRevision: revision,
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        message: {
          id,
          sourceFrameId: 'child-frame-1',
          sourceAttemptId: 'attempt-1',
          targetFrameId: rootFrameId,
          text: 'Same question',
          kind: 'question',
          createdAt: 20
        }
      })
    }

    await coordinator.markMessageDelivered(key, {
      expectedRevision: 3,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      messageId: 'question-2',
      deliveredAt: 21
    })
    await coordinator.transitionAttempt(key, {
      expectedRevision: 4,
      frameId: 'child-frame-1',
      attemptId: 'attempt-1',
      status: 'cancelled',
      endedAt: 22,
      cancellationReason: 'main_agent_stop'
    })

    await expect(
      coordinator.markMessageDelivered(key, {
        expectedRevision: 5,
        frameId: 'child-frame-1',
        attemptId: 'attempt-1',
        messageId: 'question-1',
        deliveredAt: 23
      })
    ).rejects.toMatchObject({ code: 'attempt-conflict' })
    const [record] = await coordinator.readChildren(key, rootFrameId)
    expect(record.record.pendingMessages).toEqual([
      expect.not.objectContaining({ deliveredAt: expect.any(Number) }),
      expect.objectContaining({ id: 'question-2', deliveredAt: 21 })
    ])
  })

  it('runs delegated-work interruption recovery at the startup hydration boundary', async () => {
    const { coordinator } = createHarness()
    const rootFrameId = createRootSession().conversationGraph!.rootFrameId
    await coordinator.createChildren(key, {
      expectedRevision: 0,
      parentFrameId: rootFrameId,
      originMessageId: rootPrompt.id,
      children: [child(1)]
    })

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].runtimeContext?.delegatedWork?.records[0]).toMatchObject({
      attempts: [{ status: 'cancelled', cancellationReason: 'runtime_interrupted' }]
    })
    expect(loaded.sessions[0].conversationGraph?.frames).toContainEqual(
      expect.objectContaining({ id: 'child-frame-1', status: 'cancelled' })
    )
  })
})
