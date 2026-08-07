import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import {
  createProductionDelegatedWorkComposition,
  type ProductionDelegatedWorkOptions
} from './production-composition'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AuthenticatedDelegateCaller } from './durable-delegated-work'
import type { ArtifactFile } from '../../shared/artifacts'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { DelegatedWorkRecordCommands } from './session-records'

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
  commands: DelegatedWorkRecordCommands
}>

const createCompositionHarness = async (
  dataRoot: string,
  frameworkId: AgentFrameworkId,
  execution = createDeterministicDelegateExecution(),
  admissionError?: Error,
  owners: Pick<
    ProductionDelegatedWorkOptions,
    'artifactEvidence' | 'reviewEvidence' | 'parentMessages'
  > = {}
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
        return {
          frameworkId: current.agentFrameworkId!,
          execution,
          assertAvailable: async () => {
            if (admissionError) throw admissionError
          }
        }
      }
    },
    ...owners
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
    },
    commands: coordinator
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

  it('publishes detached child terminal mutations after the running receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-detached-events-'))
    const harness = await createCompositionHarness(root, 'opencode')
    const revisions: number[] = []
    harness.composition.root.subscribe((event) => {
      if (event.kind === 'records-changed') revisions.push(revisions.length + 1)
    })

    const pendingReceipt = harness.composition.host.delegate(
      harness.caller,
      { task: 'Finish after detached receipt' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    const receipt = await pendingReceipt
    expect(receipt.children[0].status).toBe('running')
    const revisionsAtReceipt = revisions.length

    control.complete('detached terminal result')
    await expect
      .poll(() => harness.durable().runtimeContext?.delegatedWork?.records[0]?.attempts[0]?.status)
      .toBe('completed')
    expect(revisions.length).toBeGreaterThan(revisionsAtReceipt)
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
    expect(harness.composition.root.unavailableReasons?.()).toEqual({
      [harness.session.id]:
        'Delegated work is unavailable for this Agent framework configuration. Open Settings and choose a certified configuration.'
    })
  })

  it('does not project non-configuration delegation failures as Settings guidance', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-non-config-'))
    const harness = await createCompositionHarness(root, 'opencode')
    const unauthorized = { ...harness.caller, frameId: 'frame-outside-root' }

    await expect(
      harness.composition.host.delegate(unauthorized, { task: 'Must not start' })
    ).rejects.toMatchObject({ code: 'authorization' })
    expect(harness.composition.root.unavailableReasons?.()).toEqual({})
  })

  it('composes execution-scoped Artifact evidence into production result and Frame detail', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-artifacts-'))
    const versionsByRun = new Map<string, ArtifactFile[]>()
    const finalized: Array<{
      attemptId: string
      terminalMessageId: string
      artifacts: readonly ArtifactFile[]
    }> = []
    const turns = new ArtifactTurnOwner({
      dataRoot: root,
      repository: new ArtifactRepository(root),
      runRegistry: new ArtifactRunRegistry(),
      now: () => 10,
      provenance: {
        listRunVersions: async ({ artifactRunId }) => versionsByRun.get(artifactRunId) ?? [],
        writeAppGeneratedVersion: async (request) => {
          const file: ArtifactFile = {
            id: `version-${request.artifactRunId}`,
            artifactId: `artifact-${request.agentFrameId}`,
            versionId: `version-${request.artifactRunId}`,
            versionNumber: 1,
            checksum: request.content,
            createdAt: '2026-08-07T00:00:00.000Z',
            projectName: request.projectId,
            sessionId: request.appSessionId,
            runId: request.artifactRunId,
            name: request.filename,
            path: `/managed/${request.filename}`,
            fileUrl: `file:///managed/${request.filename}`,
            size: request.content.length,
            mtimeMs: 1
          }
          versionsByRun.set(request.artifactRunId, [file])
          return file
        }
      }
    })
    const execution = createDeterministicDelegateExecution()
    const harness = await createCompositionHarness(root, 'codex', execution, undefined, {
      artifactEvidence: {
        turns,
        artifactStorageSessionId: ({ sessionId }) => `artifact-${sessionId}`,
        finalizePublication: async (publication, terminalMessageId, scope) => {
          finalized.push({
            attemptId: scope.attemptId,
            terminalMessageId,
            artifacts: publication.artifacts
          })
        },
        project: async (scope) =>
          finalized
            .filter(
              (entry) =>
                entry.attemptId === scope.attemptId &&
                entry.terminalMessageId === scope.terminalMessageId
            )
            .flatMap((entry) => entry.artifacts)
      }
    })

    const pending = harness.composition.host.delegate(harness.caller, { task: 'Create evidence' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    expect(control.input.artifactCurrentRunFile).toMatch(
      /\.pending\/executions\/artifact-run-10-1\.json$/
    )
    const turn = turns.handleForExecution(control.input.attemptId)
    await turns.write(turn, { filename: 'evidence.md', content: 'exact child evidence' })
    control.accept()
    control.complete('Evidence ready')

    const result = await pending
    if (result.kind !== 'results') throw new Error('expected terminal delegated result')
    expect(result).toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          artifactsCreated: [
            {
              versionId: expect.stringMatching(/^version-artifact-run-/),
              name: 'evidence.md',
              checksum: 'exact child evidence'
            }
          ]
        }
      ]
    })
    const child = result.children[0]
    await expect(
      harness.composition.host.readAgentFrame(harness.caller.session, child.frameId)
    ).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'Create evidence' },
        {
          role: 'assistant',
          content: 'Evidence ready',
          artifacts: [{ versionId: result.children[0].artifactsCreated[0].versionId }]
        }
      ]
    })
  })

  it('projects production Reviewer rows only for the exact completed child scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-reviews-'))
    const reviewState: {
      harness?: CompositionHarness
      persistedReview?: ReviewWithChecks
    } = {}
    const harness = await createCompositionHarness(root, 'claude-code', undefined, undefined, {
      reviewEvidence: {
        loadSession: async () => reviewState.harness?.durable(),
        reviews: {
          run: async () => ({ started: true }),
          getForSession: async () =>
            reviewState.persistedReview ? [reviewState.persistedReview] : []
        }
      }
    })
    reviewState.harness = harness
    const pending = harness.composition.host.delegate(harness.caller, { task: 'Review this' })
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.complete('Reviewed answer')
    const result = await pending
    if (result.kind !== 'results') throw new Error('expected terminal delegated result')
    const child = result.children[0]
    const durableChild = harness.durable().runtimeContext!.delegatedWork!.records[0]
    const branchId = harness
      .durable()
      .conversationGraph!.frames.find((frame) => frame.id === child.frameId)!.activeBranchId
    reviewState.persistedReview = {
      id: 'review-exact-child',
      projectId: harness.session.projectId,
      sessionId: harness.session.id,
      turnMessageId: child.terminalMessageId!,
      scope: {
        turnMessageId: child.terminalMessageId!,
        agentFrameId: child.frameId,
        messageBranchId: branchId,
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'complete',
      outcome: 'pass',
      model: 'reviewer-model',
      reviewerLog: [],
      createdAt: 10,
      updatedAt: 11,
      checks: []
    }

    await expect(
      harness.composition.host.readAgentFrame(harness.caller.session, child.frameId)
    ).resolves.toMatchObject({
      status: durableChild.attempts[0].status,
      messages: [{ role: 'user' }, { role: 'assistant', reviews: [reviewState.persistedReview] }]
    })
  })

  it('delivers a child message through the production parent owner before marking it delivered', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-parent-message-'))
    const deliveries: unknown[] = []
    const harness = await createCompositionHarness(root, 'opencode', undefined, undefined, {
      parentMessages: {
        deliver: async (delivery) => {
          deliveries.push(delivery)
        }
      }
    })
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Ask the parent' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.controls()[0].accept()
    const child = receipt.children[0]

    await harness.composition.host.sendMessage(
      {
        ...harness.caller,
        frameId: child.frameId,
        attemptId: child.attemptId,
        role: 'delegate',
        toolInvocationId: 'child-parent-message'
      },
      'parent',
      'Need the cohort definition',
      'question'
    )

    expect(deliveries).toEqual([
      expect.objectContaining({
        session: harness.caller.session,
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: harness.caller.frameId,
        text: 'Need the cohort definition',
        kind: 'question'
      })
    ])
    expect(
      harness.durable().runtimeContext?.delegatedWork?.records[0].pendingMessages[0]
    ).toHaveProperty('deliveredAt')
  })

  it('deletes stable child workspaces after restart without relying on the in-memory work cache', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-restart-delete-'))
    const harness = await createCompositionHarness(root, 'codex')
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Create a stable Frame workspace' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.complete('Done')
    await expect
      .poll(() => harness.durable().runtimeContext?.delegatedWork?.records[0]?.attempts[0]?.status)
      .toBe('completed')
    const stableSessionWorkspace = join(
      root,
      'delegated-work',
      harness.session.projectId,
      harness.session.id
    )
    await expect(access(stableSessionWorkspace)).resolves.toBeUndefined()

    const restarted = createProductionDelegatedWorkComposition({
      dataRoot: root,
      sessions: {
        commands: harness.commands,
        readSession: async () => harness.durable(),
        findSessions: async (sessionId) =>
          sessionId === harness.session.id ? [harness.durable()] : []
      },
      resolveInput: async () => {
        throw new Error('no inputs')
      },
      frameworks: {
        async forSession(current) {
          return {
            frameworkId: current.agentFrameworkId!,
            execution: createDeterministicDelegateExecution(),
            assertAvailable: async () => undefined
          }
        }
      }
    } as ProductionDelegatedWorkOptions)

    expect(receipt.children[0]).toBeDefined()
    await restarted.root.deleteSession(harness.session.id)

    await expect(access(stableSessionWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
