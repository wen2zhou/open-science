import {
  resolveActiveConversationMessages,
  type PersistedConversationGraph
} from '../../shared/conversation-graph'
import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ProjectFileSource } from '../../shared/project-files'
import {
  materializeSessionConversationGraph,
  sanitizeSessionRuntimeContext
} from '../../shared/session-persistence'
import type {
  LoadAllSessionsResult,
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession,
  PersistedSideChat,
  PersistedSideChatRelay,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  UpdateSessionArchiveRequest,
  SessionRuntimeContext,
  SessionLoadFailure,
  SessionLoadWarning,
  DelegatedWorkRecord,
  DelegatedWorkAttemptRecord,
  DelegatedMessageCommand
} from '../../shared/session-persistence'
import type {
  AttachDelegatedMessageArtifactsInput,
  AttemptAgentEventInput,
  ChildRecord,
  CompleteChildTurnInput,
  CreateChildrenInput,
  CreatedChild,
  CreatedNamedChild,
  DelegatedWorkRecordCommands,
  AdmitMessageCommandInput,
  SettleMessageInput,
  StartMessageDispatchInput,
  SessionKey,
  StartContinuationAttemptInput,
  StartAttemptRuntimeInput,
  StartPendingMessageTurnInput,
  TransitionAttemptInput
} from '../delegated-work/session-records'
import { canonicalStructuredOutputEqual } from '../delegated-work/structured-output'
import { allocateDelegateNames } from '../delegated-work/delegated-work-admission'
import type { SessionDeletionReceipt } from '../artifacts/provenance-message-snapshot'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import type { ProjectSessionDeletionState } from './repository'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import {
  SessionPersistenceStateOwner,
  SessionRuntimeContextRevisionConflictError,
  type AppendUserMessageToInteractionCommand,
  type PatchSessionRuntimeContextCommand,
  type SessionMetadata,
  type SessionMetadataSnapshot
} from './state-owner'
import {
  SessionSideChatPersistenceOwner,
  type AppendSideChatRelayCommand,
  type ClearSideChatCommand,
  type CommitSideChatRelaysCommand,
  type SaveSideChatProjectionCommand
} from './side-chat-owner'
import {
  SessionPersistenceDeletionOwner,
  type ProjectSessionDeletionResult
} from './deletion-owner'
import {
  SessionPersistenceReconciliationOwner,
  type ArtifactStorageReconciler,
  type SessionPermissionGrantReconciliation,
  type SessionUploadPersistence
} from './reconciliation-owner'
import {
  DelegatedWorkAttemptConflictError,
  SessionMessageDeliveryPersistenceOwner
} from './message-delivery-owner'

type SessionMutationRepository = {
  loadAllWithDiagnostics(options?: { mode?: 'repair' | 'read-only' }): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
    warnings?: SessionLoadWarning[]
    failure?: SessionLoadFailure
  }>
  loadProjectWithDiagnostics(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  loadCommittedProjectWithDiagnostics(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  saveSession(session: PersistedChatSession): Promise<void>
  saveCommittedProjectSession(session: PersistedChatSession): Promise<void>
  deleteSession(projectId: string, sessionId: string): Promise<void>
  deleteProjectSessions(projectId: string): Promise<void>
  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState>
  markCommittedProjectSessionsPrepared(projectId: string): Promise<void>
  completeProjectSessionDeletion(projectId: string): Promise<void>
  listLegacyProjectSessionTombstones(): Promise<string[]>
  saveManifest(request: SaveSessionManifestRequest): Promise<void>
}

type SessionFileIndex = {
  syncSession(
    session: PersistedChatSession,
    options?: { force?: boolean }
  ): Promise<ProjectFileSource[]>
  softDeleteSession(projectId: string, sessionId: string): Promise<ManagedFileSoftDeleteToken>
  restoreSession(
    projectId: string,
    sessionId: string,
    token: ManagedFileSoftDeleteToken
  ): Promise<void>
  softDeleteProject(projectId: string): Promise<ManagedFileSoftDeleteToken>
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
  markReconciliationIncomplete(): void
}

type SessionProvenancePersistence = {
  validateFinalizedMessageBindings(session: PersistedChatSession): Promise<void>
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
  reconcileSessionDeletions(activeSessions: PersistedChatSession[]): Promise<void>
  prepareSessionDeletion(session: PersistedChatSession): Promise<SessionDeletionReceipt>
  completeSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
  abortSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
}

type SessionDeletionHandlers = {
  commit(sessionIds: string[]): Promise<void>
  reconcile(existingSessionIds: string[], archivedSessionIds: string[]): Promise<void>
}

const emptySessionRuntimeContext = (): SessionRuntimeContext => ({ version: 1, revision: 0 })

const delegatedRecords = (context: SessionRuntimeContext): DelegatedWorkRecord[] =>
  structuredClone(context.delegatedWork?.records ?? []) as DelegatedWorkRecord[]

const currentAttempt = (record: DelegatedWorkRecord): DelegatedWorkAttemptRecord => {
  const attempt = record.attempts.at(-1)
  if (!attempt) throw new Error(`Delegate Frame ${record.agentFrameId} has no Attempt.`)
  return attempt
}

const assertCurrentRunningAttempt = (
  records: readonly DelegatedWorkRecord[],
  frameId: string,
  attemptId: string
): { record: DelegatedWorkRecord; attempt: DelegatedWorkAttemptRecord } => {
  const record = records.find((candidate) => candidate.agentFrameId === frameId)
  if (!record) throw new Error(`Delegate Frame not found: ${frameId}`)
  const attempt = currentAttempt(record)
  if (attempt.id !== attemptId || attempt.status !== 'running') {
    throw new DelegatedWorkAttemptConflictError()
  }
  return { record, attempt }
}

const recoverInterruptedDelegatedWorkSession = (
  session: PersistedChatSession,
  endedAt = Math.max(session.updatedAt + 1, Date.now())
): {
  session: PersistedChatSession
  interrupted: readonly { frameId: string; attemptId: string }[]
} => {
  const current = session.runtimeContext
  if (!current?.delegatedWork) return { session, interrupted: [] }
  const records = delegatedRecords(current)
  const running = records.filter((record) => currentAttempt(record).status === 'running')
  if (running.length === 0) return { session, interrupted: [] }
  const materialized = materializeSessionConversationGraph(session)
  const graph = structuredClone(materialized.conversationGraph)
  if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
  const interrupted: Array<{ frameId: string; attemptId: string }> = []
  for (const record of running) {
    const attempt = currentAttempt(record)
    const attempts = record.attempts as DelegatedWorkAttemptRecord[]
    attempts[attempts.length - 1] = {
      ...attempt,
      status: 'cancelled',
      endedAt,
      cancellationReason: 'runtime_interrupted'
    }
    const frame = graph.frames.find((candidate) => candidate.id === record.agentFrameId)
    if (!frame) throw new Error(`Delegate Frame not found: ${record.agentFrameId}`)
    frame.status = 'cancelled'
    frame.completedAt = endedAt
    for (const segmentId of attempt.runtimeSegmentIds) {
      const segment = graph.runtimeSegments.find((candidate) => candidate.id === segmentId)
      if (segment && segment.endedAt === undefined) segment.endedAt = endedAt
    }
    interrupted.push({ frameId: record.agentFrameId, attemptId: attempt.id })
  }
  const runtimeContext = sanitizeSessionRuntimeContext({
    ...current,
    revision: current.revision + 1,
    delegatedWork: { records }
  })
  if (!runtimeContext) throw new Error('Delegated Work recovery produced invalid state.')
  return {
    session: { ...materialized, conversationGraph: graph, runtimeContext, updatedAt: endedAt },
    interrupted
  }
}

const persistedArtifactsEqual = (left: PersistedArtifact, right: PersistedArtifact): boolean =>
  Object.entries(right).every(([field, value]) => left[field as keyof PersistedArtifact] === value)

const appendUnique = (existing: string[] | undefined, incoming: readonly string[]): string[] => {
  const result = [...(existing ?? [])]
  const seen = new Set(result)
  for (const value of incoming) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

const emitRecoverableDiagnostic = (
  log: Logger,
  message: string,
  fields: Record<string, string | number | boolean | null | undefined>
): void => {
  try {
    log.warn(message, fields)
  } catch {
    // Diagnostics must never change Session durability or recovery behavior.
  }
}

// Serializes authoritative session JSON and derived file-index mutations through one queue. This is
// the consistency boundary that prevents a late save from racing or reviving a durable deletion.
class SessionPersistenceCoordinator implements DelegatedWorkRecordCommands {
  private readonly messageDeliveryOwner = new SessionMessageDeliveryPersistenceOwner()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly deletedSessions = new Set<string>()
  private readonly deletedProjects = new Set<string>()
  private readonly stateOwner: SessionPersistenceStateOwner
  private readonly sideChatOwner: SessionSideChatPersistenceOwner
  private readonly deletionOwner: SessionPersistenceDeletionOwner
  private readonly reconciliationOwner: SessionPersistenceReconciliationOwner
  private destructiveStartupWindowOpen = true
  private sessionDeletionHandlers: SessionDeletionHandlers | undefined

  constructor(
    private readonly repository: SessionMutationRepository,
    private readonly fileIndex: SessionFileIndex,
    private readonly onFilesChanged?: (event: ProjectFilesChangedEvent) => void,
    provenance?: SessionProvenancePersistence,
    uploads?: SessionUploadPersistence,
    artifactStorage?: ArtifactStorageReconciler,
    permissionGrants?: SessionPermissionGrantReconciliation,
    private readonly log: Logger = createLogger('session-persistence')
  ) {
    const assertMutable = (
      projectId: string,
      sessionId: string,
      operation: 'save' | 'mutate'
    ): void => {
      if (this.deletedProjects.has(projectId)) {
        throw new Error(`Cannot ${operation} a session whose project has been deleted.`)
      }
      if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
        throw new Error(`Cannot ${operation} a session that has been deleted.`)
      }
    }
    this.stateOwner = new SessionPersistenceStateOwner({
      repository,
      fileIndex,
      provenance,
      uploads,
      log,
      assertMutable,
      notifyFilesChanged: (event) => this.notifyFilesChanged(event)
    })
    this.sideChatOwner = new SessionSideChatPersistenceOwner({
      repository,
      assertMutable: (projectId, sessionId) => assertMutable(projectId, sessionId, 'mutate'),
      recordSession: (session) => this.stateOwner.recordSession(session)
    })
    this.deletionOwner = new SessionPersistenceDeletionOwner({
      repository,
      fileIndex,
      stateOwner: this.stateOwner,
      provenance,
      uploads,
      assertArchiveMutable: (projectId, sessionId) => {
        if (this.deletedProjects.has(projectId)) {
          throw new Error('Cannot archive a Session whose project has been deleted.')
        }
        if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
          throw new Error('Cannot archive a Session that has been deleted.')
        }
      },
      notifyFilesChanged: (event) => this.notifyFilesChanged(event),
      notifySessionsDeleted: (sessionIds) => this.notifySessionsDeleted(sessionIds)
    })
    this.reconciliationOwner = new SessionPersistenceReconciliationOwner({
      repository,
      fileIndex,
      provenance,
      uploads,
      artifactStorage,
      permissionGrants
    })
  }

  containsMessageOnActiveBranch(
    projectId: string,
    sessionId: string,
    messageId: string
  ): Promise<boolean> {
    return this.enqueue(() =>
      this.stateOwner.containsMessageOnActiveBranch(projectId, sessionId, messageId)
    )
  }

  loadSessionForPermissionReplay(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession> {
    return this.enqueue(async () => {
      const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
      if (loaded.status !== 'found') {
        throw new Error(`Cannot build permission replay for a ${loaded.status} Session.`)
      }
      return structuredClone(loaded.session)
    })
  }

  // Binds unread cleanup to authoritative Session mutations. Reconciliation is called only with a
  // complete live Session catalog, while commit runs only after deletion succeeds.
  setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void {
    this.sessionDeletionHandlers = handlers
  }

  sessionMetadataSnapshot(): Promise<SessionMetadataSnapshot> {
    return this.enqueue(async () => this.stateOwner.metadataSnapshot())
  }

  /**
   * Reads the Session authority without running recovery or derived-state reconciliation. This is
   * the degraded path used when an earlier startup prerequisite failed: healthy transcripts remain
   * navigable, while the incomplete marker keeps writes blocked until a full retry succeeds.
   */
  loadAllReadOnly(): Promise<LoadAllSessionsResult> {
    return this.enqueue(async () => {
      this.stateOwner.beginHydration()
      // Once any renderer has observed a degraded snapshot, later loads are no longer allowed to
      // treat the process as an untouched startup boundary for destructive cleanup.
      this.destructiveStartupWindowOpen = false
      this.fileIndex.markReconciliationIncomplete()
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
        fields: { mode: 'read-only', startupCleanupEligible: false }
      })
      operation.phase('load-authority')
      let scan: Awaited<ReturnType<SessionMutationRepository['loadAllWithDiagnostics']>>
      try {
        scan = await this.repository.loadAllWithDiagnostics({ mode: 'read-only' })
      } catch (error) {
        operation.fail(error, { status: 'failed', hydrationAvailable: false })
        throw error
      }
      this.stateOwner.replaceMetadata(scan.result.sessions, false)
      operation.complete({
        status: 'degraded',
        sessionCount: scan.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0
      })

      return {
        ...scan.result,
        diagnostics: {
          isComplete: false,
          warnings: scan.warnings ?? [],
          failure: 'startup-reconciliation-failed'
        }
      }
    })
  }

  /**
   * Loads durable sessions, reconciles Upload storage, and backfills the file projection only after a
   * complete scan has restored active ownership. Chat hydration remains available on any failure.
   */
  loadAll(): Promise<LoadAllSessionsResult> {
    return this.enqueue(async () => {
      this.stateOwner.beginHydration()
      // Public loadAll can be called by multiple renderers/tasks. Only the first invocation in this
      // process is a startup boundary; consume it before any await so failures and partial scans cannot
      // reopen destructive cleanup while live clients may already hold the legacy projection.
      const mayRunDestructiveStartupCleanup = this.destructiveStartupWindowOpen
      this.destructiveStartupWindowOpen = false
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
        fields: {
          mode: 'reconcile',
          startupCleanupEligible: mayRunDestructiveStartupCleanup
        }
      })
      operation.phase('load-authority')
      let scan: Awaited<ReturnType<SessionMutationRepository['loadAllWithDiagnostics']>>
      try {
        scan = await this.repository.loadAllWithDiagnostics()
      } catch (error) {
        operation.fail(error, { status: 'failed', hydrationAvailable: false })
        throw error
      }
      this.stateOwner.replaceMetadata(scan.result.sessions, scan.isComplete)
      scan.result.diagnostics = {
        isComplete: scan.isComplete,
        warnings: scan.warnings ?? [],
        failure: scan.failure
      }
      let result = scan.result
      let sessions = scan.result.sessions

      if (!scan.isComplete) {
        // Without the full active-session set, syncing could let a readable duplicate steal a row from
        // a soft-deleted owner whose JSON was merely unreadable during this scan.
        this.fileIndex.markReconciliationIncomplete()
        operation.complete({
          status: 'partial',
          sessionCount: sessions.length,
          warningCount: scan.warnings?.length ?? 0
        })
        return result
      }

      if (mayRunDestructiveStartupCleanup) {
        operation.phase('recover-delegated-work')
        for (let index = 0; index < sessions.length; index += 1) {
          const recovery = recoverInterruptedDelegatedWorkSession(sessions[index])
          if (recovery.interrupted.length === 0) continue
          await this.repository.saveSession(recovery.session)
          sessions = sessions.map((candidate, candidateIndex) =>
            candidateIndex === index ? recovery.session : candidate
          )
          result = { ...result, sessions }
        }
      }

      let degradedReconciliationCount = 0
      operation.phase('reconcile-unread-sessions')
      try {
        await this.sessionDeletionHandlers?.reconcile(
          sessions.map((session) => session.id),
          sessions
            .filter((session) => session.archivedAt !== undefined)
            .map((session) => session.id)
        )
      } catch (error) {
        degradedReconciliationCount += 1
        // Unread metadata is a recoverable projection and must not block Session hydration.
        emitRecoverableDiagnostic(this.log, 'unread Session reconciliation failed', {
          operation: 'session-hydration',
          phase: 'reconcile-unread-sessions',
          outcome: 'degraded',
          ...diagnosticErrorFields(error)
        })
      }

      const reconciliation = await this.reconciliationOwner.reconcileLoadedSessions({
        result,
        allowDestructiveCleanup: mayRunDestructiveStartupCleanup,
        phase: (name) => operation.phase(name),
        onPermissionFailure: (error) => {
          degradedReconciliationCount += 1
          // Chat hydration remains available. The Registry is still fail-closed by exact live scope
          // matching, and the complete scan will retry cleanup on the next process startup.
          emitRecoverableDiagnostic(this.log, 'permission grant reconciliation failed', {
            operation: 'session-hydration',
            phase: 'reconcile-permission-grants',
            outcome: 'degraded',
            ...diagnosticErrorFields(error)
          })
        }
      })

      if (reconciliation.status === 'degraded') {
        this.stateOwner.markMetadataIncomplete()
        this.fileIndex.markReconciliationIncomplete()
        operation.fail(reconciliation.failure, {
          status: 'degraded',
          hydrationAvailable: true,
          sessionCount: reconciliation.result.sessions.length,
          warningCount: scan.warnings?.length ?? 0,
          degradedReconciliationCount
        })
        // Keep chat hydration available while Files remains explicitly incomplete and retryable.
        reconciliation.result.diagnostics = {
          isComplete: false,
          warnings: scan.warnings ?? [],
          failure: 'startup-reconciliation-failed'
        }
        return reconciliation.result
      }

      operation.complete({
        status: degradedReconciliationCount > 0 ? 'degraded' : 'ready',
        sessionCount: reconciliation.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0,
        degradedReconciliationCount
      })
      return reconciliation.result
    })
  }

  readSessionRuntimeContext(projectId: string, sessionId: string): Promise<SessionRuntimeContext> {
    return this.enqueue(() => this.stateOwner.readRuntimeContext(projectId, sessionId))
  }

  loadPersistedSideChats(): Promise<{
    sideChats: Array<{
      projectId: string
      parentSessionId: string
      sideChat: PersistedSideChat
    }>
    relays: Array<{
      projectId: string
      parentSessionId: string
      relays: readonly PersistedSideChatRelay[]
    }>
    isComplete: boolean
  }> {
    return this.enqueue(() => this.sideChatOwner.loadCatalog())
  }

  saveSideChatProjection(command: SaveSideChatProjectionCommand): Promise<PersistedSideChat> {
    return this.enqueue(() => this.sideChatOwner.saveProjection(command))
  }

  appendSideChatRelay(command: AppendSideChatRelayCommand): Promise<void> {
    return this.enqueue(() => this.sideChatOwner.appendRelay(command))
  }

  commitSideChatRelays(
    command: CommitSideChatRelaysCommand
  ): Promise<readonly PersistedChatMessage[]> {
    return this.enqueue(() => this.sideChatOwner.commitRelays(command))
  }

  clearSideChat(command: ClearSideChatCommand): Promise<boolean> {
    return this.enqueue(() => this.sideChatOwner.clear(command))
  }

  patchSessionRuntimeContext(
    command: PatchSessionRuntimeContextCommand
  ): Promise<SessionRuntimeContext> {
    return this.enqueue(() => this.stateOwner.patchRuntimeContext(command))
  }

  private async loadRuntimeContextSession(
    projectId: string,
    sessionId: string,
    operation: 'read' | 'patch'
  ): Promise<PersistedChatSession> {
    const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status === 'unreadable') {
      throw new Error(
        `Cannot ${operation} Session runtime context because its durable JSON is unreadable.`
      )
    }
    if (loaded.status === 'missing') {
      throw new Error(`Cannot ${operation} runtime context for a missing Session.`)
    }
    return loaded.session
  }

  private mutateDelegatedWork<Result>(
    key: SessionKey,
    expectedRevision: number,
    mutate: (
      graph: PersistedConversationGraph,
      records: DelegatedWorkRecord[],
      session: PersistedChatSession,
      messageCommands: DelegatedMessageCommand[],
      messageCommandsQuarantined: boolean
    ) => Result
  ): Promise<Result> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Session runtime context expected revision must be a non-negative integer.')
      }
      if (this.deletedProjects.has(key.projectId)) {
        throw new Error('Cannot mutate a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(key.projectId, key.sessionId))) {
        throw new Error('Cannot mutate a session that has been deleted.')
      }
      const session = await this.loadRuntimeContextSession(key.projectId, key.sessionId, 'patch')
      const current = session.runtimeContext ?? emptySessionRuntimeContext()
      if (current.revision !== expectedRevision) {
        throw new SessionRuntimeContextRevisionConflictError(expectedRevision, current.revision)
      }
      const materialized = materializeSessionConversationGraph(session)
      const graph = structuredClone(materialized.conversationGraph)
      if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
      const records = delegatedRecords(current)
      const messageCommands = Array.from(
        structuredClone(current.delegatedWork?.messageCommands ?? [])
      )
      const messageCommandsQuarantined =
        current.delegatedWork?.messageCommandsQuarantine !== undefined
      const result = mutate(
        graph,
        records,
        materialized,
        messageCommands,
        messageCommandsQuarantined
      )
      const runtimeContext = sanitizeSessionRuntimeContext({
        ...current,
        revision: current.revision + 1,
        delegatedWork: messageCommandsQuarantined
          ? {
              records,
              messageCommandsQuarantine: current.delegatedWork?.messageCommandsQuarantine
            }
          : { records, messageCommands }
      })
      if (!runtimeContext) throw new Error('Delegated Work mutation produced invalid state.')
      const updatedAt = Math.max(session.updatedAt + 1, Date.now())
      await this.repository.saveSession({
        ...materialized,
        conversationGraph: graph,
        runtimeContext,
        updatedAt
      })
      return result
    })
  }

  createChildren(
    key: SessionKey,
    input: CreateChildrenInput
  ): Promise<readonly CreatedNamedChild[]> {
    return this.mutateDelegatedWork(key, input.expectedRevision, (graph, records) => {
      if (input.children.length === 0)
        throw new Error('Child creation requires at least one child.')
      const parent = graph.frames.find((frame) => frame.id === input.parentFrameId)
      if (!parent || parent.kind !== 'root') {
        throw new Error('Delegate children must be created by the root Main Agent Frame.')
      }
      const parentPath = resolveActiveConversationMessages({ ...graph, activeFrameId: parent.id })
      if (!parentPath.some((message) => message.id === input.originMessageId)) {
        throw new Error('Delegate origin Message is not on the parent current Branch.')
      }
      const parentPathMessageIds = new Set(parentPath.map((message) => message.id))
      const existingIds = new Set([
        ...graph.frames.map(({ id }) => id),
        ...graph.branches.map(({ id }) => id),
        ...graph.messages.map(({ id }) => id),
        ...records.flatMap((record) => record.attempts.map(({ id }) => id))
      ])
      const batchIds = input.children.flatMap((child) => [
        child.frameId,
        child.branchId,
        child.messageId,
        child.attemptId
      ])
      if (
        new Set(batchIds).size !== batchIds.length ||
        batchIds.some((id) => existingIds.has(id))
      ) {
        throw new Error('Delegate child creation contains a duplicate durable identity.')
      }
      const finalNames = allocateDelegateNames(
        input.children.map((child) => child.name),
        graph.frames
          .filter(
            (frame) =>
              frame.kind === 'delegate' &&
              frame.parentFrameId === input.parentFrameId &&
              frame.originMessageId !== undefined &&
              parentPathMessageIds.has(frame.originMessageId)
          )
          .map((frame) => frame.delegateName ?? frame.agentName ?? frame.id)
      )
      for (const [index, child] of input.children.entries()) {
        if (child.initiatingTurnMessageId !== input.originMessageId) {
          throw new Error('Initial delegated Attempt must belong to its admitting root Turn.')
        }
        const finalName = finalNames[index]
        graph.frames.push({
          id: child.frameId,
          parentFrameId: input.parentFrameId,
          originMessageId: input.originMessageId,
          originBindingState: 'validated',
          kind: 'delegate',
          ...(child.resolvedAgent.kind === 'specialist'
            ? { agentName: child.resolvedAgent.displayName }
            : {}),
          delegateName: finalName,
          status: 'running',
          activeBranchId: child.branchId,
          createdAt: child.startedAt
        })
        graph.branches.push({
          id: child.branchId,
          agentFrameId: child.frameId,
          headMessageId: child.messageId,
          createdAt: child.startedAt,
          updatedAt: child.startedAt
        })
        graph.messages.push({
          id: child.messageId,
          role: 'user',
          content: child.task,
          delegatedTask: child.task,
          ...(child.inputs?.length ? { delegatedInputVersionIds: [...child.inputs] } : {}),
          delegatedCallerSource: child.callerSource,
          ...(child.structuredOutputEvidence
            ? { structuredOutputEvidence: structuredClone(child.structuredOutputEvidence) }
            : {}),
          status: 'complete',
          eventIds: [],
          agentFrameId: child.frameId,
          introducedOnBranchId: child.branchId,
          revisionRootMessageId: child.messageId,
          createdAt: child.startedAt,
          updatedAt: child.startedAt
        })
        records.push({
          agentFrameId: child.frameId,
          attempts: [
            {
              id: child.attemptId,
              initiatingTurnMessageId: child.initiatingTurnMessageId,
              status: 'running',
              resolvedAgent: child.resolvedAgent,
              ...(child.executionModel ? { executionModel: child.executionModel } : {}),
              runtimeSegmentIds: [],
              startedAt: child.startedAt
            }
          ]
        })
      }
      return input.children.map((child, index) => ({
        frameId: child.frameId,
        attemptId: child.attemptId,
        name: finalNames[index],
        status: 'running' as const
      }))
    })
  }

  startContinuationAttempt(
    key: SessionKey,
    input: StartContinuationAttemptInput
  ): Promise<CreatedChild> {
    return this.mutateDelegatedWork(
      key,
      input.expectedRevision,
      (graph, records, _session, commands, quarantined) => {
        if (quarantined) throw new Error('Reliable message owner is quarantined.')
        const record = records.find((candidate) => candidate.agentFrameId === input.frameId)
        if (!record) throw new Error(`Delegate Frame not found: ${input.frameId}`)
        const previous = currentAttempt(record)
        if (previous.id !== input.previousAttemptId || previous.status === 'running') {
          throw new DelegatedWorkAttemptConflictError()
        }
        if (
          records.some((candidate) =>
            candidate.attempts.some(({ id }) => id === input.attemptId)
          ) ||
          graph.messages.some(({ id }) => id === input.messageId)
        ) {
          throw new Error('Continuation contains a duplicate durable identity.')
        }
        const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
        if (!frame) throw new Error(`Delegate Frame not found: ${input.frameId}`)
        const rootPath = resolveActiveConversationMessages({
          ...graph,
          activeFrameId: graph.rootFrameId
        })
        if (
          input.initiatingTurnMessageId !== input.callerSource.rootMessageId ||
          !rootPath.some((message) => message.id === input.initiatingTurnMessageId)
        ) {
          throw new Error('Continuation Attempt initiating Turn is outside the active root Branch.')
        }
        const branch = graph.branches.find((candidate) => candidate.id === frame.activeBranchId)
        if (!branch) throw new Error(`Delegate Branch not found: ${frame.activeBranchId}`)
        graph.messages.push({
          id: input.messageId,
          role: 'user',
          content: input.message,
          status: 'complete',
          eventIds: [],
          agentFrameId: input.frameId,
          introducedOnBranchId: branch.id,
          ...(branch.headMessageId ? { parentMessageId: branch.headMessageId } : {}),
          revisionRootMessageId: input.messageId,
          delegatedCallerSource: input.callerSource,
          createdAt: input.startedAt,
          updatedAt: input.startedAt
        })
        branch.headMessageId = input.messageId
        branch.updatedAt = input.startedAt
        ;(record.attempts as DelegatedWorkAttemptRecord[]).push({
          id: input.attemptId,
          initiatingTurnMessageId: input.initiatingTurnMessageId,
          status: 'running',
          resolvedAgent: input.resolvedAgent,
          ...(input.executionModel ? { executionModel: input.executionModel } : {}),
          runtimeSegmentIds: [],
          startedAt: input.startedAt
        })
        frame.status = 'running'
        delete frame.completedAt
        commands.push(structuredClone(input.messageCommand))
        return { frameId: input.frameId, attemptId: input.attemptId, status: 'running' }
      }
    )
  }

  startAttemptRuntime(key: SessionKey, input: StartAttemptRuntimeInput): Promise<void> {
    return this.mutateDelegatedWork(key, input.expectedRevision, (graph, records) => {
      const { record, attempt } = assertCurrentRunningAttempt(
        records,
        input.frameId,
        input.attemptId
      )
      if (graph.runtimeSegments.some((segment) => segment.id === input.runtimeSegmentId)) {
        throw new Error(`Runtime Segment already exists: ${input.runtimeSegmentId}`)
      }
      const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
      const branch = graph.branches.find((candidate) => candidate.id === frame?.activeBranchId)
      const promptMessage = graph.messages.find(
        (message) => message.id === branch?.headMessageId && message.role === 'user'
      )
      if (!frame || !branch || !promptMessage) {
        throw new Error('Delegated runtime has no current Frame, Branch, or prompt Message.')
      }
      graph.runtimeSegments.push({
        id: input.runtimeSegmentId,
        agentFrameId: input.frameId,
        frameworkId: input.frameworkId,
        ...(input.backendId ? { backendId: input.backendId } : {}),
        ...(input.agentName ? { agentName: input.agentName } : {}),
        ...(input.model ? { model: input.model } : {}),
        startedAt: input.startedAt
      })
      promptMessage.runtimeSegmentId = input.runtimeSegmentId
      const attempts = record.attempts as DelegatedWorkAttemptRecord[]
      attempts[attempts.length - 1] = {
        ...attempt,
        runtimeSegmentIds: [...attempt.runtimeSegmentIds, input.runtimeSegmentId]
      }
    })
  }

  applyAgentEvent(key: SessionKey, input: AttemptAgentEventInput): Promise<void> {
    return this.mutateDelegatedWork(key, input.expectedRevision, (graph, records) => {
      assertCurrentRunningAttempt(records, input.frameId, input.attemptId)
      const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
      if (!frame) throw new Error(`Delegate Frame not found: ${input.frameId}`)
      const branch = graph.branches.find((candidate) => candidate.id === frame.activeBranchId)
      if (!branch) throw new Error(`Delegate Branch not found: ${frame.activeBranchId}`)
      const event = input.event
      if (event.kind === 'message') {
        const segment = graph.runtimeSegments.find(
          (candidate) =>
            candidate.id === event.runtimeSegmentId && candidate.agentFrameId === input.frameId
        )
        if (!segment) throw new Error('Agent event Runtime Segment is outside the Attempt Frame.')
        const nextMessage: PersistedConversationGraph['messages'][number] = {
          ...event.message,
          agentFrameId: input.frameId,
          introducedOnBranchId: branch.id,
          ...(branch.headMessageId ? { parentMessageId: branch.headMessageId } : {}),
          ...(event.message.role === 'user' ? { revisionRootMessageId: event.message.id } : {}),
          runtimeSegmentId: event.runtimeSegmentId
        }
        const existing = graph.messages.find((message) => message.id === event.message.id)
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(nextMessage)) return
          throw new Error(`Message already exists: ${event.message.id}`)
        }
        graph.messages.push(nextMessage)
        branch.headMessageId = event.message.id
        branch.updatedAt = Math.max(branch.updatedAt, event.message.updatedAt)
      } else if (event.kind === 'activity') {
        if (
          !graph.messages.some(
            (message) =>
              message.id === event.promptMessageId && message.agentFrameId === input.frameId
          ) ||
          !graph.runtimeSegments.some(
            (segment) =>
              segment.id === event.runtimeSegmentId && segment.agentFrameId === input.frameId
          )
        ) {
          throw new Error('Activity provenance is outside the Attempt Frame.')
        }
        const nextActivity: PersistedConversationGraph['activities'][number] = {
          ...event.activity,
          agentFrameId: input.frameId,
          messageBranchId: branch.id,
          promptMessageId: event.promptMessageId,
          runtimeSegmentId: event.runtimeSegmentId
        }
        const existing = graph.activities.find((activity) => activity.id === event.activity.id)
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(nextActivity)) return
          throw new Error(`Activity already exists: ${event.activity.id}`)
        }
        graph.activities.push(nextActivity)
      } else {
        if (
          !graph.messages.some(
            (message) =>
              message.id === event.promptMessageId && message.agentFrameId === input.frameId
          )
        ) {
          throw new Error('Activity Group provenance is outside the Attempt Frame.')
        }
        const nextActivityGroup: PersistedConversationGraph['activityGroups'][number] = {
          ...event.activityGroup,
          agentFrameId: input.frameId,
          messageBranchId: branch.id,
          promptMessageId: event.promptMessageId
        }
        const existing = graph.activityGroups.find((group) => group.id === event.activityGroup.id)
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(nextActivityGroup)) return
          throw new Error(`Activity Group already exists: ${event.activityGroup.id}`)
        }
        graph.activityGroups.push(nextActivityGroup)
      }
    })
  }

  transitionAttempt(key: SessionKey, input: TransitionAttemptInput): Promise<void> {
    return this.mutateDelegatedWork(key, input.expectedRevision, (graph, records) => {
      const { record, attempt } = assertCurrentRunningAttempt(
        records,
        input.frameId,
        input.attemptId
      )
      if (input.endedAt < attempt.startedAt) throw new Error('Attempt end precedes its start.')
      if (input.status === 'completed' && !input.terminalMessageId) {
        throw new Error('A completed Attempt requires a terminal Message.')
      }
      if (input.status === 'cancelled' && !input.cancellationReason) {
        throw new Error('A cancelled Attempt requires a cancellation reason.')
      }
      if (input.status === 'error' && !input.error) {
        throw new Error('An errored Attempt requires error detail.')
      }
      if (
        input.terminalMessageId &&
        !graph.messages.some(
          (message) =>
            message.id === input.terminalMessageId && message.agentFrameId === input.frameId
        )
      ) {
        throw new Error('Terminal Message is outside the Attempt Frame.')
      }
      const attempts = record.attempts as DelegatedWorkAttemptRecord[]
      attempts[attempts.length - 1] = {
        ...attempt,
        status: input.status,
        endedAt: input.endedAt,
        ...(input.terminalMessageId ? { terminalMessageId: input.terminalMessageId } : {}),
        ...(input.cancellationReason ? { cancellationReason: input.cancellationReason } : {}),
        ...(input.error ? { error: input.error } : {})
      }
      const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
      if (!frame) throw new Error(`Delegate Frame not found: ${input.frameId}`)
      frame.status = input.status
      frame.completedAt = input.endedAt
      for (const segmentId of attempt.runtimeSegmentIds) {
        const segment = graph.runtimeSegments.find((candidate) => candidate.id === segmentId)
        if (segment && segment.endedAt === undefined) segment.endedAt = input.endedAt
      }
    })
  }

  submitStructuredOutput(
    key: SessionKey,
    input: import('../delegated-work/session-records').SubmitStructuredOutputInput
  ): Promise<'accepted' | 'idempotent'> {
    return this.mutateDelegatedWork(key, input.expectedRevision, (graph, records) => {
      assertCurrentRunningAttempt(records, input.frameId, input.attemptId)
      const message = graph.messages.find(
        (candidate) =>
          candidate.agentFrameId === input.frameId &&
          candidate.structuredOutputEvidence?.attemptId === input.attemptId
      )
      const evidence = message?.structuredOutputEvidence
      if (!message || !evidence || evidence.schemaDigest !== input.schemaDigest) {
        throw new Error('Structured output contract is unavailable.')
      }
      if (evidence.accepted) {
        if (
          canonicalStructuredOutputEqual(
            evidence.accepted.value as import('../delegated-work/structured-output').JsonValue,
            input.value
          )
        )
          return 'idempotent'
        throw new Error('A different structured output was already accepted.')
      }
      message.structuredOutputEvidence = {
        ...evidence,
        accepted: { value: structuredClone(input.value), acceptedAt: input.acceptedAt }
      }
      return 'accepted'
    })
  }

  admitMessageCommand(
    key: SessionKey,
    input: AdmitMessageCommandInput
  ): Promise<'admitted' | 'idempotent'> {
    return this.mutateDelegatedWork(
      key,
      input.expectedRevision,
      (_graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.admit(commands, quarantined, input)
    )
  }

  startMessageDispatch(
    key: SessionKey,
    input: StartMessageDispatchInput
  ): Promise<'started' | 'terminal' | 'blocked'> {
    return this.mutateDelegatedWork(
      key,
      input.expectedRevision,
      (graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.startDispatch(graph, commands, quarantined, input)
    )
  }

  settleMessage(key: SessionKey, input: SettleMessageInput): Promise<'settled' | 'terminal'> {
    return this.mutateDelegatedWork(
      key,
      input.expectedRevision,
      (_graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.settle(commands, quarantined, input)
    )
  }

  acknowledgeUncertainMessage(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; messageId: string }>
  ): Promise<'acknowledged' | 'terminal'> {
    return this.mutateDelegatedWork(
      key,
      input.expectedRevision,
      (_graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.acknowledge(commands, quarantined, input.messageId)
    )
  }

  startPendingMessageTurn(key: SessionKey, input: StartPendingMessageTurnInput): Promise<void> {
    return this.mutateDelegatedWork(
      key,
      input.expectedRevision,
      (graph, records, _session, commands) =>
        this.messageDeliveryOwner.startChildTurn(graph, records, commands, input)
    )
  }

  completeChildTurn(key: SessionKey, input: CompleteChildTurnInput): Promise<void> {
    return this.mutateDelegatedWork(key, input.expectedRevision, (graph, records) =>
      this.messageDeliveryOwner.completeChildTurn(graph, records, input)
    )
  }

  attachDelegatedMessageArtifacts(
    key: SessionKey,
    input: AttachDelegatedMessageArtifactsInput
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.deletedProjects.has(key.projectId)) {
        throw new Error('Cannot mutate a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(key.projectId, key.sessionId))) {
        throw new Error('Cannot mutate a session that has been deleted.')
      }
      const session = await this.loadRuntimeContextSession(key.projectId, key.sessionId, 'patch')
      const materialized = materializeSessionConversationGraph(session)
      const graph = structuredClone(materialized.conversationGraph)
      if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
      const record = delegatedRecords(session.runtimeContext ?? emptySessionRuntimeContext()).find(
        ({ agentFrameId }) => agentFrameId === input.frameId
      )
      const attempt = record?.attempts.find(({ id }) => id === input.attemptId)
      if (!record || !attempt) throw new Error('Delegated Artifact owner Attempt is missing.')
      const owner = graph.messages.find(
        ({ id, agentFrameId, role, status }) =>
          id === input.messageId &&
          agentFrameId === input.frameId &&
          role === 'agent' &&
          status === 'complete'
      )
      if (
        !owner?.runtimeSegmentId ||
        !attempt.runtimeSegmentIds.includes(owner.runtimeSegmentId) ||
        input.artifacts.length === 0
      ) {
        throw new Error('Delegated Artifact owner is outside the completed Turn.')
      }
      const artifactIds = input.artifacts.map(({ versionId, id }) => versionId ?? id)
      const nextOwnerIds = appendUnique(owner.artifactIds, artifactIds)
      const nextArtifacts = [
        ...(materialized.artifacts ?? []).map((artifact) => structuredClone(artifact))
      ]
      let artifactsChanged = false
      for (const artifact of input.artifacts) {
        const persisted: PersistedArtifact = {
          id: artifact.versionId ?? artifact.id,
          ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
          ...(artifact.versionId ? { versionId: artifact.versionId } : {}),
          ...(artifact.versionNumber !== undefined
            ? { versionNumber: artifact.versionNumber }
            : {}),
          kind: 'managed-file',
          path: artifact.path,
          fileUrl: artifact.fileUrl,
          name: artifact.name,
          ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
          size: artifact.size,
          mtimeMs: artifact.mtimeMs,
          ...(artifact.checksum ? { sha256: artifact.checksum } : {})
        }
        const index = nextArtifacts.findIndex(({ id }) => id === persisted.id)
        if (index < 0) {
          nextArtifacts.push(persisted)
          artifactsChanged = true
        } else if (!persistedArtifactsEqual(nextArtifacts[index], persisted)) {
          nextArtifacts[index] = persisted
          artifactsChanged = true
        }
      }
      const ownerChanged = nextOwnerIds.length !== (owner.artifactIds?.length ?? 0)
      if (!ownerChanged && !artifactsChanged) return
      owner.artifactIds = nextOwnerIds
      await this.repository.saveSession({
        ...materialized,
        conversationGraph: graph,
        artifacts: nextArtifacts,
        filesRevision: (materialized.filesRevision ?? 0) + 1,
        updatedAt: Math.max(materialized.updatedAt + 1, Date.now())
      })
    })
  }

  readChildren(key: SessionKey, parentFrameId: string): Promise<readonly ChildRecord[]> {
    return this.enqueue(async () => {
      const session = await this.loadRuntimeContextSession(key.projectId, key.sessionId, 'read')
      const materialized = materializeSessionConversationGraph(session)
      const graph = materialized.conversationGraph
      if (!graph) return []
      const records = delegatedRecords(session.runtimeContext ?? emptySessionRuntimeContext())
      return records.flatMap((record): ChildRecord[] => {
        const frame = graph.frames.find(
          (candidate) =>
            candidate.id === record.agentFrameId && candidate.parentFrameId === parentFrameId
        )
        if (!frame) return []
        const attempt = currentAttempt(record)
        return [
          {
            frameId: frame.id,
            parentFrameId,
            title: frame.delegateName ?? frame.agentName ?? frame.id,
            status: attempt.status,
            record: structuredClone(record)
          }
        ]
      })
    })
  }

  recoverInterruptedDelegatedWork(): Promise<readonly { frameId: string; attemptId: string }[]> {
    return this.enqueue(async () => {
      const scan = await this.repository.loadAllWithDiagnostics({ mode: 'read-only' })
      if (!scan.isComplete) {
        throw new Error('Cannot recover Delegated Work from an incomplete Session catalog.')
      }
      const interrupted: Array<{ frameId: string; attemptId: string }> = []
      for (const session of scan.result.sessions) {
        const current = session.runtimeContext
        if (!current?.delegatedWork) continue
        const records = delegatedRecords(current)
        const running = records.filter((record) => currentAttempt(record).status === 'running')
        if (running.length === 0) continue
        const materialized = materializeSessionConversationGraph(session)
        const graph = structuredClone(materialized.conversationGraph)
        if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
        const endedAt = Math.max(session.updatedAt + 1, Date.now())
        for (const record of running) {
          const attempt = currentAttempt(record)
          const attempts = record.attempts as DelegatedWorkAttemptRecord[]
          attempts[attempts.length - 1] = {
            ...attempt,
            status: 'cancelled',
            endedAt,
            cancellationReason: 'runtime_interrupted'
          }
          const frame = graph.frames.find((candidate) => candidate.id === record.agentFrameId)
          if (!frame) throw new Error(`Delegate Frame not found: ${record.agentFrameId}`)
          frame.status = 'cancelled'
          frame.completedAt = endedAt
          for (const segmentId of attempt.runtimeSegmentIds) {
            const segment = graph.runtimeSegments.find((candidate) => candidate.id === segmentId)
            if (segment && segment.endedAt === undefined) segment.endedAt = endedAt
          }
          interrupted.push({ frameId: record.agentFrameId, attemptId: attempt.id })
        }
        const runtimeContext = sanitizeSessionRuntimeContext({
          ...current,
          revision: current.revision + 1,
          delegatedWork: { records }
        })
        if (!runtimeContext) throw new Error('Delegated Work recovery produced invalid state.')
        await this.repository.saveSession({
          ...materialized,
          conversationGraph: graph,
          runtimeContext,
          updatedAt: endedAt
        })
      }
      return interrupted
    })
  }

  appendUserMessageToInteraction(
    command: AppendUserMessageToInteractionCommand
  ): Promise<PersistedChatMessage> {
    return this.enqueue(() => this.stateOwner.appendUserMessage(command))
  }

  // Project archive must fail closed when even one child Session cannot be read. A partial catalog
  // cannot prove that an omitted Session is idle, so it is unsafe to hide the whole Project.
  assertProjectArchivable(
    projectId: string,
    isRuntimeBusy: (sessionId: string) => boolean = () => false
  ): Promise<string[]> {
    return this.enqueue(() => this.deletionOwner.assertProjectArchivable(projectId, isRuntimeBusy))
  }

  // Used by runtime admission checks after resolving a known project/session pair. It is intentionally
  // read-only: restoring an item never attaches or resumes an agent session by itself.
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.deletionOwner.assertSessionAvailable(projectId, sessionId))
  }

  // Finds a persisted Session's owner for runtime admission. Fresh, unsaved sessions have no durable
  // archive state and deliberately return undefined.
  sessionProjectId(sessionId: string): Promise<string | undefined> {
    return this.enqueue(async () => this.stateOwner.sessionProjectId(sessionId))
  }

  // Dedicated main-owned archive mutation. Unlike full renderer saves it preserves updatedAt and
  // never allows a stale renderer projection to alter archive state.
  updateArchive(
    request: UpdateSessionArchiveRequest,
    isRuntimeBusy: () => boolean = () => false
  ): Promise<PersistedChatSession> {
    return this.enqueue(() => this.deletionOwner.updateArchive(request, isRuntimeBusy))
  }

  // Persists authoritative JSON before updating the derived index. If indexing fails, the save stays
  // durable, the caller receives the error for its normal retry path, and Files is reset to show its
  // incomplete state rather than silently presenting stale metadata as complete.
  saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {}
  ): Promise<PersistedChatSession> {
    return this.enqueue(() => this.stateOwner.saveSession(session, options))
  }

  // Specialist switching reads the latest durable Session and changes only this safe binding. Keep
  // that intent inside the persistence boundary so every caller receives graph-conflict recovery.
  saveSessionSpecialistBinding(
    session: PersistedChatSession,
    specialistId: string | undefined
  ): Promise<PersistedChatSession> {
    return this.enqueue(() =>
      this.stateOwner.saveSession(
        { ...session, specialistId },
        { conflictRebaseFields: ['specialistId'] }
      )
    )
  }

  // Joins late Session-owned side effects (for example Upload finalization) to the same ordering
  // boundary as JSON save and deletion. The mutation is rejected after a Session/Project tombstone.
  runSessionMutation<Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueue(async () => {
      if (this.deletedProjects.has(projectId)) {
        throw new Error('Cannot mutate a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
        throw new Error('Cannot mutate a session that has been deleted.')
      }
      try {
        return await mutation()
      } finally {
        // Artifact finalization can add a new binding without changing the Session graph. Force the
        // next save to validate that new database scope before reusing a topology fingerprint.
        this.stateOwner.invalidateBindingTopology(projectId, sessionId)
      }
    })
  }

  /**
   * Completes the Session/index phase of an intent-authorized whole-Project deletion.
   *
   * This is deliberately not a general batch-Session delete. A durable Project deletion intent owns
   * eventual cleanup of Project-scoped Versions and provenance after this method atomically removes
   * Session authority. Per-Session deletion retains its stricter fail-closed contract.
   */
  deleteProjectSessions(
    projectId: string,
    options: { requireExistingUploadAuthority?: boolean } = {}
  ): Promise<ProjectSessionDeletionResult> {
    return this.enqueue(async () => {
      this.deletedProjects.add(projectId)
      try {
        return await this.deletionOwner.deleteProjectSessions(projectId, options)
      } catch (error) {
        try {
          const state = await this.deletionOwner.getProjectSessionDeletionState(projectId)
          if (state === 'live' || state === 'absent') {
            this.deletedProjects.delete(projectId)
          }
        } catch {
          // Unknown durable state is treated as committed: retain the in-memory tombstone and intent.
          this.fileIndex.markReconciliationIncomplete()
        }
        throw error
      }
    })
  }

  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    return this.enqueue(() => this.deletionOwner.getProjectSessionDeletionState(projectId))
  }

  markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    return this.enqueue(() => this.deletionOwner.markCommittedProjectSessionsPrepared(projectId))
  }

  completeProjectSessionDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.deletionOwner.completeProjectSessionDeletion(projectId))
  }

  listLegacyProjectSessionTombstones(): Promise<string[]> {
    return this.enqueue(() => this.deletionOwner.listLegacyProjectSessionTombstones())
  }

  /**
   * Explicitly repairs the global file projection from a complete session scan.
   *
   * Every project is synchronized before the global reconciliation marker can be cleared. A second
   * pass handles rows released by reconciliation. Errors are tracked per session so a transient first
   * failure that succeeds on the final pass does not make the repair IPC report a false failure.
   */
  repairProjectFiles(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const scan = await this.repository.loadAllWithDiagnostics()
      if (!scan.isComplete) {
        this.fileIndex.markReconciliationIncomplete()
        this.notifyFilesChanged({
          projectId,
          sources: ['artifact', 'upload'],
          kind: 'reset'
        })
        throw new Error(
          'Project files cannot be repaired until the sessions directory is readable.'
        )
      }

      let repairError: unknown
      try {
        await this.reconciliationOwner.repairFileProjection(scan.result.sessions)
      } catch (error) {
        repairError = error
      }

      // One reset refreshes overview and all cursor layers after the explicit repair attempt.
      this.notifyFilesChanged({
        projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })

      if (repairError) throw repairError
    })
  }

  saveManifest(request: SaveSessionManifestRequest): Promise<void> {
    return this.enqueue(() => this.repository.saveManifest(request))
  }

  /**
   * Deletes one session with reversible index-first ordering.
   *
   * After JSON deletion succeeds, surviving sessions in the project are retried because legacy
   * duplicates may now claim canonical file rows. Their changed sources are broadcast before the
   * deleted-owner event so already loaded renderer pages invalidate in the same operation.
   */
  deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const key = sessionKey(projectId, sessionId)
      this.deletedSessions.add(key)
      try {
        await this.deletionOwner.deleteSession(projectId, sessionId)
      } catch (error) {
        this.deletedSessions.delete(key)
        throw error
      }
    })
  }

  // Rejections are absorbed only by the queue tail, not by the returned task promise. Later mutations
  // therefore continue in order while each caller still receives its own failure.
  private enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // Renderer notifications are derived state. They must never change the result of an authoritative
  // JSON/index mutation that has already committed; the next Files request can refresh if delivery fails.
  private notifyFilesChanged(event: ProjectFilesChangedEvent): void {
    try {
      this.onFilesChanged?.(event)
    } catch {
      // A closed window or test sink may reject synchronously after the durable mutation succeeds.
    }
  }

  // Runs only after authoritative Session deletion commits. Cleanup failures are repaired by the next
  // complete catalog reconciliation and never roll back the user-visible deletion.
  private async notifySessionsDeleted(sessionIds: string[]): Promise<void> {
    try {
      await this.sessionDeletionHandlers?.commit(sessionIds)
    } catch {
      // A later complete Session scan retries the projection cleanup from authoritative JSON state.
    }
  }
}

const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

export { SessionPersistenceCoordinator, SessionRuntimeContextRevisionConflictError }
export type {
  PatchSessionRuntimeContextCommand,
  ProjectSessionDeletionResult,
  SessionDeletionHandlers,
  SessionFileIndex,
  SessionMetadata,
  SessionMetadataSnapshot,
  SessionMutationRepository,
  SessionProvenancePersistence
}
