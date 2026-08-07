import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import { createProductionDelegatedWorkComposition } from './production-composition'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AuthenticatedDelegateCaller } from './durable-delegated-work'

let root: string | undefined
let server: NotebookLocalRpcServer | undefined

const fileIndex: SessionFileIndex = {
  syncSession: async () => [],
  softDeleteSession: async () => 'delete-session',
  restoreSession: async () => undefined,
  softDeleteProject: async () => 'delete-project',
  reconcileActiveSessions: async () => undefined,
  markReconciliationIncomplete: () => undefined
}

type CompositionHarness = Readonly<{
  composition: ReturnType<typeof createProductionDelegatedWorkComposition>
  execution: ReturnType<typeof createDeterministicDelegateExecution>
  selected: AgentFrameworkId[]
  session: PersistedChatSession
  durable(): PersistedChatSession
  caller: AuthenticatedDelegateCaller
}>

const createCompositionHarness = async (
  dataRoot: string,
  frameworkId: AgentFrameworkId,
  execution = createDeterministicDelegateExecution(),
  admissionError?: Error
): Promise<CompositionHarness> => {
  const rootMessage = {
    id: `root-message-${frameworkId}`,
    role: 'user' as const,
    content: 'Coordinate.',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const session: PersistedChatSession = {
    id: `session-${frameworkId}`,
    projectId: 'project-1',
    title: frameworkId,
    cwd: '/root',
    status: 'idle',
    agentFrameworkId: frameworkId,
    messages: [rootMessage],
    conversationGraph: createLinearConversationGraph({
      sessionId: `session-${frameworkId}`,
      messages: [rootMessage],
      frameworkId,
      createdAt: 1,
      updatedAt: 1
    }),
    filesRevision: 1,
    createdAt: 1,
    updatedAt: 2
  }
  let durable = structuredClone(session)
  const repository: SessionMutationRepository = {
    loadAllWithDiagnostics: async () => ({
      result: { sessions: [structuredClone(durable)], manifest: { version: 1 } },
      isComplete: true
    }),
    loadProjectWithDiagnostics: async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    }),
    loadCommittedProjectWithDiagnostics: async () => ({ sessions: [], isComplete: true }),
    loadSessionWithDiagnostics: async () => ({
      status: 'found',
      session: structuredClone(durable)
    }),
    saveSession: async (next) => {
      durable = structuredClone(next)
    },
    saveCommittedProjectSession: async () => undefined,
    deleteSession: async () => undefined,
    deleteProjectSessions: async () => undefined,
    getProjectSessionDeletionState: async () => 'absent',
    markCommittedProjectSessionsPrepared: async () => undefined,
    completeProjectSessionDeletion: async () => undefined,
    listLegacyProjectSessionTombstones: async () => [],
    saveManifest: async () => undefined
  }
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
  const selected: AgentFrameworkId[] = []
  const composition = createProductionDelegatedWorkComposition({
    dataRoot,
    sessions: {
      commands: coordinator,
      readSession: async () => structuredClone(durable)
    },
    resolveInput: async () => {
      throw new Error('no inputs')
    },
    frameworks: {
      async forSession(current) {
        selected.push(current.agentFrameworkId!)
        if (admissionError) throw admissionError
        return {
          frameworkId: current.agentFrameworkId!,
          execution,
          assertAvailable: async () => undefined
        }
      }
    }
  })
  return {
    composition,
    execution,
    selected,
    session,
    durable: () => durable,
    caller: {
      session: { projectId: session.projectId, sessionId: session.id },
      frameId: session.conversationGraph!.rootFrameId,
      role: 'main' as const,
      originMessageId: rootMessage.id,
      toolInvocationId: `call-${frameworkId}`
    }
  }
}

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('production delegated-work composition', () => {
  it('runs authenticated Host delegation through durable Session records and a staged Frame cwd', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-composition-'))
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'Coordinate evidence.',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Delegation',
      cwd: '/root-workspace',
      status: 'idle',
      agentFrameworkId: 'codex',
      messages: [rootMessage],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [rootMessage],
        frameworkId: 'codex',
        createdAt: 1,
        updatedAt: 1
      }),
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 2
    }
    let durable = structuredClone(session)
    const repository: SessionMutationRepository = {
      loadAllWithDiagnostics: async () => ({
        result: { sessions: [structuredClone(durable)], manifest: { version: 1 } },
        isComplete: true
      }),
      loadProjectWithDiagnostics: async () => ({
        sessions: [structuredClone(durable)],
        isComplete: true
      }),
      loadCommittedProjectWithDiagnostics: async () => ({ sessions: [], isComplete: true }),
      loadSessionWithDiagnostics: async () => ({
        status: 'found',
        session: structuredClone(durable)
      }),
      saveSession: async (next) => {
        durable = structuredClone(next)
      },
      saveCommittedProjectSession: async () => undefined,
      deleteSession: async () => undefined,
      deleteProjectSessions: async () => undefined,
      getProjectSessionDeletionState: async () => 'absent',
      markCommittedProjectSessionsPrepared: async () => undefined,
      completeProjectSessionDeletion: async () => undefined,
      listLegacyProjectSessionTombstones: async () => [],
      saveManifest: async () => undefined
    }
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    const upload = join(root, 'immutable-upload.csv')
    await writeFile(upload, 'sample,value\na,1\n')
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'completed', response: 'staged evidence inspected' })
    const selected: string[] = []
    const composition = createProductionDelegatedWorkComposition({
      dataRoot: root,
      sessions: {
        commands: coordinator,
        readSession: async () => structuredClone(durable)
      },
      resolveInput: async (identity) => {
        if (identity !== 'upload-version:version-1') throw new Error('unknown Version')
        return { path: upload, filename: 'evidence.csv' }
      },
      frameworks: {
        async forSession(durableSession) {
          selected.push(durableSession.agentFrameworkId ?? '')
          return {
            frameworkId: durableSession.agentFrameworkId!,
            execution,
            assertAvailable: async () => undefined
          }
        }
      }
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: composition.host
    })
    const graph = session.conversationGraph!
    const connection = await server.issueControlConnection(
      session.id,
      session.projectId,
      graph.rootFrameId
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'delegate-call',
      originatingUserMessageId: rootMessage.id
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: { task: 'Inspect staged evidence', inputs: ['upload-version:version-1'] }
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        kind: 'results',
        children: [{ status: 'completed', response: 'staged evidence inspected' }]
      }
    })
    expect(selected).toEqual(['codex'])
    const input = execution.controls()[0].input
    expect(input.workspaceCwd).toContain(
      join('delegated-work', 'project-1', 'session-1', 'frames', input.frameId)
    )
    await expect(
      readFile(join(input.workspaceCwd!, 'inputs', '01-evidence.csv'), 'utf8')
    ).resolves.toBe('sample,value\na,1\n')
    expect(durable.runtimeContext?.delegatedWork?.records[0].attempts[0].status).toBe('completed')

    endInvocation()
    connection.release()
    await composition.root.deleteSession('session-1')
  })

  it('routes root permission responses by Attempt and cascades root Stop fail-closed', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-permission-'))
    const harness = await createCompositionHarness(root, 'codex')
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Wait for permission' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'provider-permission-1',
      title: 'Read evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    const projected = harness.composition.root.pendingPermissions()[0]
    expect(projected).toMatchObject({
      sessionId: harness.session.id,
      delegated: {
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId
      }
    })
    await expect(
      harness.composition.root.respondToPermission({
        requestId: projected.requestId,
        optionId: 'allow'
      })
    ).resolves.toBe(true)
    expect(control.permissionResponses()).toEqual([
      { requestId: 'provider-permission-1', optionId: 'allow' }
    ])

    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'provider-permission-stop',
      title: 'Write evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    const stale = harness.composition.root.pendingPermissions()[0]
    await harness.composition.root.stopAll()
    expect(harness.durable().runtimeContext?.delegatedWork?.records[0].attempts[0]).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'session_stop'
    })
    expect(harness.composition.root.pendingPermissions()).toEqual([])
    await expect(
      harness.composition.root.respondToPermission({
        requestId: stale.requestId,
        optionId: 'allow'
      })
    ).rejects.toThrow('no longer active')
  })

  it('selects each advertised production framework from the durable Session identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-frameworks-'))
    for (const frameworkId of ['claude-code', 'opencode', 'codex'] as const) {
      const execution = createDeterministicDelegateExecution()
      execution.plan({ status: 'completed', response: `${frameworkId} complete` })
      const harness = await createCompositionHarness(
        join(root, frameworkId),
        frameworkId,
        execution
      )
      await expect(
        harness.composition.host.delegate(harness.caller, { task: 'Run certified factory' })
      ).resolves.toMatchObject({
        kind: 'results',
        children: [{ status: 'completed', response: `${frameworkId} complete` }]
      })
      expect(harness.selected).toEqual([frameworkId])
      await harness.composition.root.deleteSession(harness.session.id)
    }
  })

  it('rejects unsupported production configuration before durable child mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-admission-'))
    const execution = createDeterministicDelegateExecution()
    const harness = await createCompositionHarness(
      root,
      'opencode',
      execution,
      new Error('native delegation remains enabled')
    )

    await expect(
      harness.composition.host.delegate(harness.caller, { task: 'Must not start' })
    ).rejects.toThrow('native delegation remains enabled')
    expect(harness.selected).toEqual(['opencode'])
    expect(execution.controls()).toEqual([])
    expect(harness.durable().runtimeContext?.delegatedWork).toBeUndefined()
  })
})
