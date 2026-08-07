import { describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import {
  normalizeSessionFile,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import {
  createDurableDelegatedWork,
  type AuthenticatedDelegateCaller
} from './durable-delegated-work'
import { createSessionDelegatedWorkRecords } from './session-record-adapter'

const key = { projectId: 'project-1', sessionId: 'session-1' } as const
const rootPrompt: PersistedChatMessage = {
  id: 'root-prompt',
  role: 'user',
  content: 'Coordinate the work.',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
}

const createSession = (): PersistedChatSession => ({
  id: key.sessionId,
  projectId: key.projectId,
  title: 'Delegated research',
  cwd: '/workspace',
  status: 'idle',
  specialistId: 'currently-bound-specialist',
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

const createHarness = (): Readonly<{
  coordinator: SessionPersistenceCoordinator
  repository: SessionMutationRepository
  readSession(): Promise<PersistedChatSession>
}> => {
  let durable = createSession()
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
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
  return { coordinator, repository, readSession: async () => structuredClone(durable) }
}

describe('Session delegated-work adapter', () => {
  it('does not reject an already-committed mutation when its projection notifier throws', async () => {
    const { coordinator, readSession } = createHarness()
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'notifier-branch',
        onRecordsChanged: () => {
          throw new Error('renderer notification failed')
        }
      },
      key
    )

    await expect(
      records.admitChildren({
        caller: {
          session: key,
          frameId: createSession().conversationGraph!.rootFrameId,
          role: 'main',
          originMessageId: rootPrompt.id,
          toolInvocationId: 'notifier-test'
        },
        children: [
          {
            frameId: 'notifier-frame',
            attemptId: 'notifier-attempt',
            userMessageId: 'notifier-message',
            title: 'Persist despite notifier failure',
            request: { task: 'Persist despite notifier failure', inputs: [] },
            resolvedAgent: { kind: 'main' },
            startedAt: 10
          }
        ]
      })
    ).resolves.toBeUndefined()
    await expect(records.snapshot()).resolves.toMatchObject({
      records: [{ frameId: 'notifier-frame' }]
    })
  })

  it('persists successful running-child delivery against the addressed Attempt', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'child-branch' },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1'],
      message: ['prompt-1', 'pending-1'],
      runtime: ['runtime-1']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 50,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch'
    }
    await work.delegate(caller, { task: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()

    await work.sendMessage(
      { ...caller, toolInvocationId: 'message-call' },
      'child-frame',
      'Additional evidence',
      'info'
    )

    await expect
      .poll(
        async () => (await readSession()).runtimeContext?.delegatedWork?.records[0].pendingMessages
      )
      .toEqual([
        {
          id: 'pending-1',
          sourceFrameId: rootFrameId,
          targetFrameId: 'child-frame',
          targetAttemptId: 'attempt-1',
          text: 'Additional evidence',
          kind: 'info',
          createdAt: 50,
          deliveredAt: 50
        }
      ])
    expect(execution.control('attempt-1').deliveredMessages()).toEqual(['Additional evidence'])
  })
  it('starts an admitted array against revisioned Session records without sibling conflicts', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    let nextBranch = 1
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `child-branch-${nextBranch++}`
      },
      key
    )
    const work = createDurableDelegatedWork({ execution, records })
    const batchCaller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'batch-tool-call'
    }

    const outcome = await work.delegate(
      batchCaller,
      [{ task: 'First durable child' }, { task: 'Second durable child' }],
      { wait: false }
    )

    expect(outcome.children).toHaveLength(2)
    await expect.poll(() => execution.controls()).toHaveLength(2)
    await expect(work.children(batchCaller)).resolves.toMatchObject([
      { title: 'First durable child', status: 'running' },
      { title: 'Second durable child', status: 'running' }
    ])
  })

  it('executes and projects one blocking child from the durable Session conversation', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'child-branch'
      },
      key
    )
    const workspaceInputs: string[][] = []
    let nextMessage = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: (identity) => identity.startsWith('upload-version:'),
      workspace: {
        async prepare(_session, _frameId, inputs) {
          workspaceInputs.push([...inputs])
          return { cwd: '/stable-child-workspace' }
        }
      },
      createId: (kind) =>
        kind === 'message'
          ? `child-message-${nextMessage++}`
          : { frame: 'child-frame', attempt: 'child-attempt', runtime: 'child-runtime' }[kind]
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'tool-call-1'
    }

    const pending = work.delegate(caller, {
      task: 'Trace the source',
      context: 'Prefer primary evidence.',
      inputs: ['upload-version:one']
    })

    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).toMatchObject({
      task: 'Trace the source',
      context: 'Prefer primary evidence.',
      inputs: ['upload-version:one']
    })
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual({
      kind: 'main'
    })
    expect(workspaceInputs).toEqual([['upload-version:one']])
    execution.controls()[0].accept()
    execution.controls()[0].complete('Durable answer')

    expect(await pending).toMatchObject({
      kind: 'results',
      children: [{ status: 'completed', response: 'Durable answer', artifactsCreated: [] }]
    })
    await expect(work.readAgentFrame(key, 'child-frame')).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Trace the source\n\nContext:\nPrefer primary evidence.' },
        { role: 'assistant', content: 'Durable answer' }
      ]
    })
    const restored = normalizeSessionFile(await readSession())
    expect(
      restored?.conversationGraph?.messages.find(
        (message) => message.agentFrameId === 'child-frame' && message.role === 'user'
      )
    ).toMatchObject({
      delegatedTask: 'Trace the source',
      delegatedContext: 'Prefer primary evidence.',
      delegatedInputVersionIds: ['upload-version:one']
    })
  })

  it('persists and projects the dispatch-time Specialist label independently of Session binding', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'specialist-branch'
      },
      key
    )
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async (profileId) => ({
        id: profileId,
        name: 'SOURCE_AUDITOR',
        displayName: 'Source Auditor',
        enabled: true,
        setupPending: false,
        revision: 4
      }),
      createId: (kind) =>
        ({
          frame: 'specialist-frame',
          attempt: 'specialist-attempt',
          message: 'specialist-message',
          runtime: 'specialist-runtime'
        })[kind]
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'specialist-tool-call'
    }

    await work.delegate(
      caller,
      { task: 'Audit sources', profile: 'stable-specialist-id' },
      { wait: false }
    )

    const expected = {
      kind: 'specialist',
      profileId: 'stable-specialist-id',
      revision: 4,
      displayName: 'Source Auditor'
    }
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual(expected)
    await expect(work.readAgentFrame(key, 'specialist-frame')).resolves.toMatchObject({
      resolvedAgent: expected
    })
    await expect(work.sessionSummary(key)).resolves.toEqual({
      runningCount: 1,
      children: [{ frameId: 'specialist-frame', title: 'Audit sources', status: 'running' }]
    })
    expect(
      (await readSession()).conversationGraph?.frames.find(
        (frame) => frame.id === 'specialist-frame'
      )?.agentName
    ).toBe('Source Auditor')
    await expect
      .poll(
        async () =>
          (await readSession()).conversationGraph?.runtimeSegments.find(
            (segment) => segment.id === 'specialist-runtime'
          )?.agentName
      )
      .toBe('Source Auditor')
  })

  it('preserves detached child identity, title, status, and collect result across Session reopen', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    let nextBranch = 1
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `child-branch-${nextBranch++}`
      },
      key
    )
    let nextMessage = 1
    const dispatchingWork = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) =>
        kind === 'message'
          ? `child-message-${nextMessage++}`
          : { frame: 'child-frame', attempt: 'child-attempt', runtime: 'child-runtime' }[kind]
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'detached-tool-call'
    }

    const receipt = await dispatchingWork.delegate(
      caller,
      { task: 'Detached trace', name: 'Stable trace' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Persisted answer')
    await expect
      .poll(async () => (await dispatchingWork.children(caller))[0]?.status)
      .toBe('completed')

    const reopenedRecords = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex' },
      key
    )
    const reopenedWork = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records: reopenedRecords
    })

    await expect(reopenedWork.children(caller)).resolves.toEqual([
      {
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId,
        title: 'Stable trace',
        status: 'completed'
      }
    ])
    await expect(reopenedWork.collect(caller, [receipt.children[0].frameId])).resolves.toEqual([
      {
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId,
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'Persisted answer',
        artifactsCreated: []
      }
    ])
  })

  it('atomically appends a continuation Attempt and Message to the existing Frame branch', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    let nextBranch = 1
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `child-branch-${nextBranch++}`
      },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1', 'attempt-2'],
      message: ['prompt-1', 'answer-1', 'prompt-2'],
      runtime: ['runtime-1', 'runtime-2']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch-call'
    }
    const dispatched = await work.delegate(caller, { task: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()
    execution.control('attempt-1').complete('Initial answer')
    await expect.poll(async () => (await work.sessionSummary(key)).runningCount).toBe(0)
    const before = await readSession()
    const frameBefore = before.conversationGraph!.frames.find(({ id }) => id === 'child-frame')!

    await work.sendMessage(
      { ...caller, toolInvocationId: 'continuation-call' },
      dispatched.children[0].frameId,
      'Follow up in place'
    )

    const after = await readSession()
    const frameAfter = after.conversationGraph!.frames.find(({ id }) => id === 'child-frame')!
    expect(after.conversationGraph!.frames.filter(({ kind }) => kind === 'delegate')).toHaveLength(
      1
    )
    expect(frameAfter).toMatchObject({
      id: frameBefore.id,
      parentFrameId: frameBefore.parentFrameId,
      originMessageId: frameBefore.originMessageId,
      activeBranchId: frameBefore.activeBranchId,
      delegateName: frameBefore.delegateName,
      status: 'running'
    })
    expect(after.runtimeContext?.delegatedWork?.records[0].attempts).toMatchObject([
      { id: 'attempt-1', status: 'completed', terminalMessageId: 'answer-1' },
      { id: 'attempt-2', status: 'running', resolvedAgent: { kind: 'main' } }
    ])
    expect(
      after.conversationGraph!.messages.filter(({ agentFrameId }) => agentFrameId === 'child-frame')
    ).toMatchObject([
      { id: 'prompt-1', role: 'user', content: 'Initial task' },
      { id: 'answer-1', role: 'agent', content: 'Initial answer' },
      { id: 'prompt-2', role: 'user', content: 'Follow up in place', parentMessageId: 'answer-1' }
    ])
  })

  it('reports a clear conflict when concurrent callers continue the same terminal Attempt', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'child-branch'
      },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1', 'attempt-2', 'attempt-3'],
      message: ['prompt-1', 'answer-1', 'prompt-2', 'prompt-3'],
      runtime: ['runtime-1', 'runtime-2', 'runtime-3']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch-call'
    }
    await work.delegate(caller, { task: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()
    execution.control('attempt-1').complete('Initial answer')
    await expect.poll(async () => (await work.sessionSummary(key)).runningCount).toBe(0)

    const outcomes = await Promise.allSettled([
      work.sendMessage(
        { ...caller, toolInvocationId: 'continuation-a' },
        'child-frame',
        'First continuation'
      ),
      work.sendMessage(
        { ...caller, toolInvocationId: 'continuation-b' },
        'child-frame',
        'Competing continuation'
      )
    ])

    expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' }
    })
    expect((await records.snapshot()).records[0].attempts).toHaveLength(2)
    expect(
      (await records.snapshot()).messages.filter(
        ({ frameId, role }) => frameId === 'child-frame' && role === 'user'
      )
    ).toHaveLength(2)
    expect(execution.reservationCounts()).toEqual([1, 1, 1])
  })

  it('publishes no running continuation when its atomic admission save fails', async () => {
    const { coordinator, repository, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'child-branch' },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1', 'attempt-2'],
      message: ['prompt-1', 'answer-1', 'prompt-2'],
      runtime: ['runtime-1', 'runtime-2']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch-call'
    }
    await work.delegate(caller, { task: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()
    execution.control('attempt-1').complete('Stable evidence')
    await expect.poll(async () => (await work.sessionSummary(key)).runningCount).toBe(0)
    const before = await readSession()
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('continuation save failed'))

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'failed-continuation' },
        'child-frame',
        'Do not publish this message'
      )
    ).rejects.toThrow('continuation save failed')

    expect(await readSession()).toEqual(before)
    await expect(work.sessionSummary(key)).resolves.toMatchObject({
      runningCount: 0,
      children: [{ frameId: 'child-frame', status: 'completed' }]
    })
    expect(execution.controls()).toHaveLength(1)
  })
})
