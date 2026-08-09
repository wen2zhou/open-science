import { randomUUID } from 'node:crypto'

import type { ArtifactFile } from '../../shared/artifacts'
import type { AcpAgentRuntimeUpdate, AcpPermissionScope } from '../../shared/acp'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { SpecialistProfileView } from '../../shared/specialist'
import {
  DelegateExecutionError,
  type DelegateCapacityReservation,
  type DelegateExecution,
  type DelegateExecutionInput,
  type DelegatePermissionResponse
} from './execution-port'
import { RootDelegatePermissionOwner } from './delegated-work-permissions'
import { DelegatedWorkProjectionOwner } from './delegated-work-projection'
import { DelegatedWorkReadModel } from './delegated-work-read-model'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import { DelegatedWorkAdmissionPolicy } from './delegated-work-admission'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { createInMemoryDelegatedWorkRecords } from './in-memory-delegated-work-records'
import {
  createAttemptRuntimeTranscriptStager,
  terminalizeUnsuccessfulAttempt
} from './attempt-runtime-transcript'
import {
  createDelegatedTurnLifecycle,
  type DelegatedArtifactEvidence,
  type DelegatedArtifactHandle,
  type DelegatedArtifactProjectionScope,
  type DelegatedArtifactScope
} from './delegated-turn-lifecycle'
import type {
  DelegatedWorkDurableRecords,
  DurableAttempt,
  DurableChild,
  DurableChildSummary,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableDelegateOutcome,
  DurableDelegateResult,
  DurablePendingMessage
} from './delegated-work-record-types'
import type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type DurableDelegateRequest = Readonly<{
  task: string
  name?: string
  profile?: string
  context?: string
  inputs?: readonly string[]
}>

type SpecialistDelegationProfile = Readonly<
  Pick<
    SpecialistProfileView,
    'id' | 'name' | 'displayName' | 'enabled' | 'setupPending' | 'revision'
  >
>

type ParentMessageDelivery = Readonly<{
  messageId: string
  session: SessionKey
  sourceFrameId: string
  sourceAttemptId: string
  targetFrameId: string
  originMessageId: string
  text: string
  kind: 'info' | 'question'
}>

type SessionSubagentSummary = Readonly<{
  runningCount: number
  children: readonly Readonly<{
    frameId: string
    title: string
    status: 'running' | 'completed' | 'cancelled' | 'error'
    awaitingPermission?: boolean
  }>[]
}>

type RootDelegatePermissionRequest = Readonly<{
  requestId: string
  frameId: string
  attemptId: string
  childTitle: string
  action: string
  riskScope: string
  options: readonly Readonly<{
    optionId: string
    name: string
    kind: string
    scope?: AcpPermissionScope
  }>[]
}>

type RootDelegatePermissionResponse = DelegatePermissionResponse &
  Readonly<{ frameId: string; attemptId: string }>

type RootDelegatePermissionEvent =
  | Readonly<{ kind: 'requested'; request: RootDelegatePermissionRequest }>
  | Readonly<{ kind: 'settled'; request: RootDelegatePermissionRequest }>

type DurableSendMessageOutcome =
  | Readonly<{
      kind: 'queued'
      messageId: string
      targetFrameId: string
      attemptId?: string
    }>
  | Readonly<{
      kind: 'continued'
      child: Readonly<{ frameId: string; attemptId: string; status: 'running' }>
    }>

type ReadOnlyAgentFrameDetail = Readonly<{
  frameId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  resolvedAgent: DurableAttempt['resolvedAgent']
  messages: readonly Readonly<{
    role: 'user' | 'assistant'
    content: string
    artifacts?: readonly ArtifactFile[]
    // Existing Reviewer projection; renderers reuse ReviewerCard without delegated-only status.
    reviews?: readonly ReviewWithChecks[]
  }>[]
}>

type DelegatedReviewProjectionScope = Readonly<{
  session: SessionKey
  attemptId: string
  agentFrameId: string
  messageBranchId: string
  terminalMessageId: string
  artifactVersionIds: readonly string[]
}>

type DelegatedReviewEvidence = Readonly<{
  project(scope: DelegatedReviewProjectionScope): Promise<readonly ReviewWithChecks[]>
}>

type StopOutcome = Readonly<{
  frameId: string
  status: 'cancelled' | 'already_terminal'
}>

type RecoveryOutcome = Readonly<{ interrupted: readonly DurableDelegateResult[] }>

type DurableDelegatedWork = Readonly<{
  delegate(
    caller: AuthenticatedDelegateCaller,
    requests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    options?: Readonly<{ wait?: boolean }>
  ): Promise<DurableDelegateOutcome>
  children(
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): Promise<readonly DurableChildSummary[]>
  collect(
    caller: AuthenticatedDelegateCaller,
    selectors: readonly DurableCollectSelector[],
    options?: DurableCollectOptions
  ): Promise<readonly DurableDelegateObservation[]>
  sendMessage(
    caller: AuthenticatedDelegateCaller,
    targetFrameId: string | 'parent',
    message: string,
    kind?: 'info' | 'question'
  ): Promise<DurableSendMessageOutcome>
  sessionSummary(session: SessionKey): Promise<SessionSubagentSummary>
  readAgentFrame(
    session: SessionKey,
    frameId: string
  ): Promise<ReadOnlyAgentFrameDetail | undefined>
  rootPermissionRequests(session: SessionKey): Promise<readonly RootDelegatePermissionRequest[]>
  respondToPermission(session: SessionKey, response: RootDelegatePermissionResponse): Promise<void>
  setPermissionProfile(session: SessionKey, profile: PermissionProfileId): Promise<void>
  stopChildren(
    caller: AuthenticatedDelegateCaller,
    frameIds: readonly string[]
  ): Promise<readonly StopOutcome[]>
  stopSession(session: SessionKey): Promise<readonly StopOutcome[]>
  recoverInterrupted(): Promise<RecoveryOutcome>
  deleteSession(session: SessionKey): Promise<void>
}>

const createDurableDelegatedWork = (options: {
  execution: DelegateExecution
  records: DelegatedWorkDurableRecords
  assertAvailable?: (caller: AuthenticatedDelegateCaller) => Promise<void> | void
  resolveSpecialist?: (
    profileId: string
  ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined
  resolveSpecialistReference?: (
    profileReference: string
  ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined
  validateInput?: (identity: string) => Promise<boolean> | boolean
  workspace?: Readonly<{
    prepare(
      session: SessionKey,
      frameId: string,
      inputs: readonly string[]
    ): Promise<{ cwd: string }>
    deleteSession?(session: SessionKey): Promise<void>
  }>
  revokeAttemptWrites?: (scope: {
    session: SessionKey
    frameId: string
    attemptId: string
  }) => Promise<void> | void
  settleAttemptCleanup?: (scope: {
    session: SessionKey
    frameId: string
    attemptId: string
  }) => Promise<void> | void
  deliverToParent?: (delivery: ParentMessageDelivery) => Promise<void>
  artifactEvidence?: DelegatedArtifactEvidence
  reviewEvidence?: DelegatedReviewEvidence
  onRootPermissionEvent?(event: RootDelegatePermissionEvent): void
  onAgentRuntimeUpdate?(update: AcpAgentRuntimeUpdate): void
  now?: () => number
  createId?: (kind: 'frame' | 'attempt' | 'message' | 'runtime') => string
  collectPollIntervalMs?: number
  collectMonotonicNow?: () => number
}): DurableDelegatedWork => {
  const now = options.now ?? Date.now
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const invocationOutcomes = new Map<string, Promise<DurableDelegateOutcome>>()
  const messageOutcomes = new Map<string, Promise<DurableSendMessageOutcome>>()
  const stoppingSessions = new Set<string>()
  const permissionOwner = new RootDelegatePermissionOwner(
    options.records,
    options.onRootPermissionEvent
  )
  const projectionOwner = new DelegatedWorkProjectionOwner(
    options.records,
    options.artifactEvidence,
    options.reviewEvidence
  )
  const readModel = new DelegatedWorkReadModel(
    options.records,
    projectionOwner,
    options.collectPollIntervalMs ?? 10,
    options.collectMonotonicNow
  )
  const admissionPolicy = new DelegatedWorkAdmissionPolicy(
    options.resolveSpecialist,
    options.resolveSpecialistReference,
    options.validateInput
  )
  const running = new Map<
    string,
    {
      attemptId: string
      completion: Promise<void>
      deliver(message: DurablePendingMessage): Promise<void>
      setPermissionProfile(profile: PermissionProfileId): Promise<void>
      cancel(reason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'): Promise<void>
      executionStarted(): boolean
      reservation: DelegateCapacityReservation
      slotId: string
      artifact?: DelegatedArtifactHandle
    }
  >()

  const snapshotChild = async (frameId: string): Promise<DurableChild | undefined> =>
    (await options.records.snapshot()).records.find((child) => child.frameId === frameId) as
      DurableChild | undefined

  const launch = (
    child: DurableChild,
    session: SessionKey,
    reservation: DelegateCapacityReservation,
    slotId: string,
    task = child.task,
    continuation = false
  ): void => {
    const attempt = currentAttempt(child)
    const runtimeSegmentId = createId('runtime')
    let handle: ReturnType<DelegateExecution['run']> | undefined
    let resolveHandle!: (value: ReturnType<DelegateExecution['run']>) => void
    let rejectHandle!: (error: unknown) => void
    const deliveryHandle = new Promise<ReturnType<DelegateExecution['run']>>((resolve, reject) => {
      resolveHandle = resolve
      rejectHandle = reject
    })
    void deliveryHandle.catch(() => undefined)
    const runtimeUpdates: AcpAgentRuntimeUpdate[] = []
    const turnLifecycle = createDelegatedTurnLifecycle({
      records: options.records,
      artifactEvidence: options.artifactEvidence,
      session,
      attemptId: attempt.id,
      agentFrameId: child.frameId,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      runtimeUpdates,
      now,
      createMessageId: () => createId('message')
    })
    let cancelRequested = false
    let cancellationReason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted' =
      'main_agent_stop'
    let context: Awaited<ReturnType<DelegatedWorkDurableRecords['startRuntime']>> | undefined
    const stageRuntimeTranscript = createAttemptRuntimeTranscriptStager({
      records: options.records,
      frameId: child.frameId,
      attemptId: attempt.id,
      updates: runtimeUpdates,
      promptMessageId: () => context?.promptMessageId,
      createMessageId: () => createId('message')
    })
    const completion = (async () => {
      try {
        const workspace = await options.workspace?.prepare(session, child.frameId, child.inputs)
        const startedContext = await options.records.startRuntime(
          child.frameId,
          attempt.id,
          runtimeSegmentId
        )
        context = startedContext
        const latest = await snapshotChild(child.frameId)
        if (cancelRequested || !latest || currentAttempt(latest).status !== 'running') {
          rejectHandle(new Error('delegate execution is no longer running'))
          return
        }
        await turnLifecycle.openInitial(startedContext)
        const artifact = turnLifecycle.currentArtifact()
        const runningAttempt = running.get(child.frameId)
        if (runningAttempt?.attemptId === attempt.id) runningAttempt.artifact = artifact
        const ready = await snapshotChild(child.frameId)
        if (cancelRequested || !ready || currentAttempt(ready).status !== 'running') {
          rejectHandle(new Error('delegate execution is no longer running'))
          return
        }
        const executionInput: DelegateExecutionInput = {
          session,
          frameId: child.frameId,
          attemptId: attempt.id,
          runtimeSegmentId,
          task,
          ...(continuation ? {} : { context: child.context }),
          inputs: child.inputs,
          ...(workspace ? { workspaceCwd: workspace.cwd } : {}),
          ...(attempt.resolvedAgent.kind === 'specialist'
            ? { profile: attempt.resolvedAgent.profileId }
            : {}),
          ...(artifact?.execution
            ? { artifactCurrentRunFile: artifact.execution.currentRunFile }
            : {}),
          continuation,
          turn: turnLifecycle.create(startedContext, true)
        }
        handle = options.execution.run(executionInput, slotId)
        resolveHandle(handle)
        const unsubscribe = handle.subscribe((event) => {
          permissionOwner.observe(child.frameId, attempt.id, child.title, handle!, event)
          if (event.kind !== 'runtime') return
          const { scope: eventScope } = event.update
          if (
            eventScope.projectId !== session.projectId ||
            eventScope.sessionId !== session.sessionId ||
            eventScope.agentFrameId !== child.frameId ||
            eventScope.attemptId !== attempt.id ||
            !eventScope.runtimeSegmentId ||
            !eventScope.promptMessageId
          ) {
            return
          }
          runtimeUpdates.push(event.update)
          options.onAgentRuntimeUpdate?.(event.update)
        })
        void handle.completion.finally(unsubscribe).catch(() => undefined)
        await Promise.race([handle.accepted, handle.completion.then(() => undefined)])
        const outcome = await handle.completion
        const endedAt = now()
        if (outcome.status === 'completed' && !cancelRequested) {
          const lastTurnMessage = turnLifecycle.lastTurnMessage()
          const transcript = lastTurnMessage
            ? undefined
            : await stageRuntimeTranscript({
                terminalStatus: 'completed',
                endedAt,
                fallbackResponse: outcome.response,
                ...(outcome.turnUsage
                  ? { turnUsage: outcome.turnUsage }
                  : outcome.turnUsageUnavailable
                    ? { turnUsageUnavailable: true }
                    : {})
              })
          const terminalMessage = lastTurnMessage ?? transcript?.terminalMessage
          if (!terminalMessage)
            throw new Error('Completed delegated runtime has no terminal Message.')
          if (!lastTurnMessage) await turnLifecycle.finalizeFallback(terminalMessage.id)
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'completed',
            endedAt,
            terminalMessage
          })
        } else {
          await stageRuntimeTranscript({ terminalStatus: 'cancelled', endedAt })
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'cancelled',
            endedAt,
            cancellationReason
          })
        }
      } catch (error) {
        rejectHandle(error)
        const latest = await snapshotChild(child.frameId)
        if (latest && currentAttempt(latest).status === 'running') {
          const endedAt = now()
          await terminalizeUnsuccessfulAttempt(options.records, stageRuntimeTranscript, {
            frameId: child.frameId,
            attemptId: attempt.id,
            endedAt,
            error,
            ...(cancelRequested ? { cancellationReason } : {})
          })
        }
      } finally {
        permissionOwner.clearAttempt(child.frameId, attempt.id)
        await turnLifecycle.dispose()
        await reservation.release(slotId).catch(() => undefined)
        if (running.get(child.frameId)?.attemptId === attempt.id) running.delete(child.frameId)
      }
    })()
    running.set(child.frameId, {
      attemptId: attempt.id,
      completion,
      async deliver(message) {
        if (!context) throw new Error('delegate execution has no active child Turn')
        const pendingContext = {
          rootFrameId: context.rootFrameId,
          messageBranchId: context.messageBranchId,
          promptMessageId: createId('message'),
          runtimeSegmentId: createId('runtime')
        }
        const lifecycle = turnLifecycle.create(pendingContext, false)
        await (
          await deliveryHandle
        ).sendMessage(message.text, {
          ...lifecycle,
          async begin() {
            context = await options.records.startPendingTurn(
              child.frameId,
              attempt.id,
              message.id,
              pendingContext.promptMessageId,
              pendingContext.runtimeSegmentId
            )
            await lifecycle.begin?.()
          }
        })
      },
      async setPermissionProfile(profile) {
        await (await deliveryHandle).setPermissionProfile(profile)
      },
      async cancel(reason) {
        cancelRequested = true
        cancellationReason = reason
        rejectHandle(new Error('delegate execution was cancelled before message delivery'))
        await handle?.cancel()
      },
      executionStarted: () => handle !== undefined,
      reservation,
      slotId
    })
  }

  const stopChild = async (
    child: DurableChild,
    reason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
  ): Promise<StopOutcome> => {
    const attempt = currentAttempt(child)
    if (attempt.status !== 'running') {
      return { frameId: child.frameId, status: 'already_terminal' }
    }
    const snapshot = await options.records.snapshot()
    const session = snapshot.session
    const scope = { session, frameId: child.frameId, attemptId: attempt.id }
    const pendingPermissions = permissionOwner.takeAttempt(child.frameId, attempt.id)
    const evidenceScope = projectionOwner.attemptScope(snapshot, child, attempt)
    try {
      if (evidenceScope) await options.artifactEvidence?.revoke?.(evidenceScope)
      const active = running.get(child.frameId)
      await active?.artifact?.dispose()
      await options.revokeAttemptWrites?.(scope)
      const executionStarted = active?.executionStarted() === true
      await active?.cancel(reason).catch(() => undefined)
      await options.settleAttemptCleanup?.(scope)
      if (executionStarted) await active?.completion
      const latest = await snapshotChild(child.frameId)
      if (latest && currentAttempt(latest).status !== 'running') {
        return currentAttempt(latest).status === 'cancelled'
          ? { frameId: child.frameId, status: 'cancelled' }
          : { frameId: child.frameId, status: 'already_terminal' }
      }
      await options.records.terminalize({
        frameId: child.frameId,
        attemptId: attempt.id,
        status: 'cancelled',
        endedAt: now(),
        cancellationReason: reason
      })
      return { frameId: child.frameId, status: 'cancelled' }
    } catch (error) {
      const latest = await snapshotChild(child.frameId)
      if (latest && currentAttempt(latest).status !== 'running') {
        return { frameId: child.frameId, status: 'already_terminal' }
      }
      permissionOwner.restoreAttempt(pendingPermissions)
      throw error
    }
  }

  const stopSession = async (session: SessionKey): Promise<readonly StopOutcome[]> => {
    const sessionIdentity = `${session.projectId}\u0000${session.sessionId}`
    if (stoppingSessions.has(sessionIdentity)) {
      throw new DurableDelegatedWorkError('conflict', 'the Session is already stopping')
    }
    stoppingSessions.add(sessionIdentity)
    try {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return []
      const runningSnapshot = snapshot.records.filter(
        (child) => currentAttempt(child as DurableChild).status === 'running'
      ) as readonly DurableChild[]
      return await Promise.all(runningSnapshot.map((child) => stopChild(child, 'session_stop')))
    } finally {
      stoppingSessions.delete(sessionIdentity)
    }
  }

  const delegateOnce = async (
    caller: AuthenticatedDelegateCaller,
    requestOrRequests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    delegateOptions: Readonly<{ wait?: boolean }>
  ): Promise<DurableDelegateOutcome> => {
    const sessionIdentity = `${caller.session.projectId}\u0000${caller.session.sessionId}`
    if (stoppingSessions.has(sessionIdentity)) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'the Session is stopping and cannot accept delegated work'
      )
    }
    if (caller.role !== 'main') {
      throw new DurableDelegatedWorkError('authorization', 'only the Main Agent can delegate work')
    }
    const admission = await options.records.snapshot()
    if (
      !sameSession(admission.session, caller.session) ||
      caller.frameId !== admission.rootFrameId ||
      !admission.originMessageIds.includes(caller.originMessageId) ||
      !caller.toolInvocationId.trim()
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegation caller or origin Message is outside the active root conversation'
      )
    }
    try {
      await options.assertAvailable?.(caller)
    } catch (error) {
      if (error instanceof DurableDelegatedWorkError) throw error
      throw new DurableDelegatedWorkError(
        'unsupported_framework',
        error instanceof Error ? error.message : String(error),
        'Delegated work is unavailable for this Agent framework configuration. Open Settings and choose a certified configuration.'
      )
    }
    const { requests, resolvedAgents } = await admissionPolicy.admit(
      requestOrRequests,
      caller.parentSpecialistProfileId
    )
    let reservation: DelegateCapacityReservation
    try {
      reservation = await options.execution.reserve(requests.length)
    } catch (error) {
      if (error instanceof DelegateExecutionError) {
        throw new DurableDelegatedWorkError(error.code, error.message)
      }
      throw new DurableDelegatedWorkError(
        'capacity',
        error instanceof Error ? error.message : String(error)
      )
    }
    const usedTitles = new Set(
      requests.flatMap((request) => (request.name === undefined ? [] : [request.name.trim()]))
    )
    const admissions = requests.map((request, index) => {
      const task = request.task.trim()
      let title = request.name?.trim()
      if (!title) {
        title = task
        for (let suffix = 2; usedTitles.has(title); suffix += 1) title = `${task} (${suffix})`
        usedTitles.add(title)
      }
      return {
        frameId: createId('frame'),
        attemptId: createId('attempt'),
        userMessageId: createId('message'),
        title,
        request: { ...request, task },
        resolvedAgent: resolvedAgents[index],
        startedAt: now()
      }
    })
    try {
      await options.records.admitChildren({
        caller,
        children: admissions
      })
    } catch (error) {
      await reservation.releaseAll()
      throw error
    }
    const children: DurableChild[] = admissions.map((admission) => ({
      frameId: admission.frameId,
      parentFrameId: caller.frameId,
      originMessageId: caller.originMessageId,
      originBindingState: 'validated',
      title: admission.title,
      task: admission.request.task,
      context: admission.request.context,
      inputs: [...(admission.request.inputs ?? [])],
      messageBranchId: `branch-${admission.frameId}`,
      attempts: [
        {
          id: admission.attemptId,
          status: 'running',
          resolvedAgent: structuredClone(admission.resolvedAgent),
          runtimeSegmentIds: [],
          startedAt: admission.startedAt
        }
      ],
      pendingMessages: []
    }))
    const completions = children.map((child, index) => {
      launch(child, caller.session, reservation, reservation.slotIds[index])
      return running.get(child.frameId)!.completion
    })
    const receipts = admissions.map(({ frameId, attemptId, title, resolvedAgent }) => ({
      frameId,
      attemptId,
      name: title,
      agentName: resolvedAgent.kind === 'specialist' ? resolvedAgent.displayName : 'Main Agent',
      status: 'running' as const
    }))
    if (delegateOptions.wait === false) return { kind: 'receipts', children: receipts }
    await Promise.all(completions)
    const results = await Promise.all(
      admissions.map(({ frameId }) => projectionOwner.projectResult(frameId))
    )
    if (results.some((result) => !result)) {
      throw new DurableDelegatedWorkError(
        'durability_failure',
        'delegated work did not reach a durable terminal state'
      )
    }
    return { kind: 'results', children: results as DurableDelegateResult[] }
  }

  return Object.freeze({
    delegate(
      caller: AuthenticatedDelegateCaller,
      request: DurableDelegateRequest | readonly DurableDelegateRequest[],
      delegateOptions: Readonly<{ wait?: boolean }> = {}
    ): Promise<DurableDelegateOutcome> {
      const invocationKey = [
        caller.session.projectId,
        caller.session.sessionId,
        caller.frameId,
        caller.toolInvocationId
      ].join('\u0000')
      const existing = invocationOutcomes.get(invocationKey)
      if (existing) return existing
      const outcome = delegateOnce(caller, request, delegateOptions)
      invocationOutcomes.set(invocationKey, outcome)
      void outcome.catch(() => invocationOutcomes.delete(invocationKey))
      return outcome
    },
    async children(
      caller: AuthenticatedDelegateCaller,
      frameIds?: readonly string[]
    ): Promise<readonly DurableChildSummary[]> {
      return readModel.children(caller, frameIds)
    },
    async collect(
      caller: AuthenticatedDelegateCaller,
      selectors: readonly DurableCollectSelector[],
      collectOptions?: DurableCollectOptions
    ): Promise<readonly DurableDelegateObservation[]> {
      return readModel.collect(caller, selectors, collectOptions)
    },
    sendMessage(
      caller: AuthenticatedDelegateCaller,
      targetFrameId: string | 'parent',
      message: string,
      kind: 'info' | 'question' = 'info'
    ): Promise<DurableSendMessageOutcome> {
      const invocationKey = [
        caller.session.projectId,
        caller.session.sessionId,
        caller.frameId,
        caller.toolInvocationId,
        'send-message'
      ].join('\u0000')
      const existing = messageOutcomes.get(invocationKey)
      if (existing) return existing
      const outcome = (async () => {
        if (typeof message !== 'string' || !message.trim()) {
          throw new DurableDelegatedWorkError('admission_rejection', 'message cannot be empty')
        }
        if (kind !== 'info' && kind !== 'question') {
          throw new DurableDelegatedWorkError(
            'admission_rejection',
            'message kind must be info or question'
          )
        }
        if (targetFrameId === 'parent') {
          const snapshot = await options.records.snapshot()
          const source = snapshot.records.find(
            (candidate) => candidate.frameId === caller.frameId
          ) as DurableChild | undefined
          const sourceAttempt = source && currentAttempt(source)
          if (
            caller.role !== 'delegate' ||
            !sameSession(snapshot.session, caller.session) ||
            !source ||
            source.parentFrameId !== snapshot.rootFrameId ||
            sourceAttempt?.status !== 'running' ||
            sourceAttempt.id !== caller.attemptId ||
            !caller.toolInvocationId.trim()
          ) {
            throw new DurableDelegatedWorkError(
              'authorization',
              'delegate message is outside its authenticated current parent relationship'
            )
          }
          const pendingMessage: DurablePendingMessage = {
            id: createId('message'),
            sourceFrameId: source.frameId,
            sourceAttemptId: sourceAttempt.id,
            targetFrameId: source.parentFrameId,
            text: message.trim(),
            kind,
            callerSource: {
              rootMessageId: caller.originMessageId,
              toolInvocationId: caller.toolInvocationId
            },
            createdAt: now()
          }
          await options.records.appendPendingMessage(
            source.frameId,
            sourceAttempt.id,
            pendingMessage
          )
          if (!options.deliverToParent) {
            throw new DurableDelegatedWorkError(
              'execution_failure',
              'parent app-owned message delivery is unavailable'
            )
          }
          try {
            await options.deliverToParent({
              messageId: pendingMessage.id,
              session: caller.session,
              sourceFrameId: source.frameId,
              sourceAttemptId: sourceAttempt.id,
              targetFrameId: source.parentFrameId,
              originMessageId: caller.originMessageId,
              text: pendingMessage.text,
              kind: pendingMessage.kind
            })
            await options.records.markMessageDelivered(
              source.frameId,
              sourceAttempt.id,
              pendingMessage.id,
              now()
            )
          } catch (error) {
            if (error instanceof DurableDelegatedWorkError) throw error
            throw new DurableDelegatedWorkError(
              'execution_failure',
              `parent message delivery failed: ${error instanceof Error ? error.message : String(error)}`
            )
          }
          return {
            kind: 'queued' as const,
            messageId: pendingMessage.id,
            targetFrameId: source.parentFrameId,
            attemptId: sourceAttempt.id
          }
        }
        if (caller.role !== 'main') {
          throw new DurableDelegatedWorkError(
            'authorization',
            'only the Main Agent can continue delegated work'
          )
        }
        const snapshot = await options.records.snapshot()
        if (
          !sameSession(snapshot.session, caller.session) ||
          caller.frameId !== snapshot.rootFrameId ||
          !snapshot.originMessageIds.includes(caller.originMessageId) ||
          !caller.toolInvocationId.trim()
        ) {
          throw new DurableDelegatedWorkError(
            'authorization',
            'continuation caller is outside the active root conversation'
          )
        }
        let child = snapshot.records.find(
          (candidate) =>
            candidate.frameId === targetFrameId && candidate.parentFrameId === caller.frameId
        ) as DurableChild | undefined
        if (!child) {
          throw new DurableDelegatedWorkError(
            'authorization',
            `caller cannot access child ${targetFrameId}`
          )
        }
        let previous = currentAttempt(child)
        if (previous.status === 'running') {
          const pendingMessage: DurablePendingMessage = {
            id: createId('message'),
            sourceFrameId: caller.frameId,
            targetFrameId: child.frameId,
            targetAttemptId: previous.id,
            text: message.trim(),
            kind,
            callerSource: {
              rootMessageId: caller.originMessageId,
              toolInvocationId: caller.toolInvocationId
            },
            createdAt: now()
          }
          try {
            await options.records.appendPendingMessage(child.frameId, previous.id, pendingMessage)
          } catch (error) {
            const latest = await snapshotChild(child.frameId)
            if (latest && currentAttempt(latest).status !== 'running') {
              child = latest
              previous = currentAttempt(latest)
            } else {
              throw error
            }
          }
          if (previous.status === 'running') {
            const active = running.get(child.frameId)
            if (!active || active.attemptId !== previous.id) {
              throw new DurableDelegatedWorkError(
                'conflict',
                'the target Attempt is no longer available for delivery'
              )
            }
            // The Host result means durably queued. Provider delivery can only begin after the
            // child's current ACP turn yields, so keep that boundary in the background and stamp the
            // record only when RunningDelegateExecution confirms provider acceptance.
            const deliveryFrameId = child.frameId
            const deliveryAttemptId = previous.id
            void active
              .deliver(pendingMessage)
              .then(() =>
                options.records.markMessageDelivered(
                  deliveryFrameId,
                  deliveryAttemptId,
                  pendingMessage.id,
                  now()
                )
              )
              .catch(() => undefined)
            return {
              kind: 'queued' as const,
              messageId: pendingMessage.id,
              targetFrameId: child.frameId,
              attemptId: previous.id
            }
          }
        }
        const priorExecution = running.get(targetFrameId)
        if (priorExecution?.attemptId === previous.id) await priorExecution.completion
        try {
          await options.assertAvailable?.(caller)
        } catch (error) {
          if (error instanceof DurableDelegatedWorkError) throw error
          throw new DurableDelegatedWorkError(
            'unsupported_framework',
            error instanceof Error ? error.message : String(error)
          )
        }
        const resolvedAgent =
          previous.resolvedAgent.kind === 'main'
            ? ({ kind: 'main' } as const)
            : await admissionPolicy.resolveAgent(previous.resolvedAgent.profileId)
        let reservation: DelegateCapacityReservation
        try {
          reservation = await options.execution.reserve(1)
        } catch (error) {
          if (error instanceof DelegateExecutionError) {
            throw new DurableDelegatedWorkError(error.code, error.message)
          }
          throw new DurableDelegatedWorkError(
            'capacity',
            error instanceof Error ? error.message : String(error)
          )
        }
        const attemptId = createId('attempt')
        try {
          await options.records.continueChild({
            frameId: targetFrameId,
            previousAttemptId: previous.id,
            attemptId,
            userMessageId: createId('message'),
            message: message.trim(),
            resolvedAgent,
            startedAt: now(),
            callerSource: {
              rootMessageId: caller.originMessageId,
              toolInvocationId: caller.toolInvocationId
            }
          })
        } catch (error) {
          await reservation.releaseAll()
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'revision-conflict' || error.code === 'attempt-conflict')
          ) {
            throw new DurableDelegatedWorkError(
              'conflict',
              `child ${targetFrameId} changed while continuation was admitted`
            )
          }
          throw error
        }
        const continued = (await snapshotChild(targetFrameId))!
        launch(continued, caller.session, reservation, reservation.slotIds[0], message.trim(), true)
        return {
          kind: 'continued' as const,
          child: { frameId: targetFrameId, attemptId, status: 'running' as const }
        }
      })()
      messageOutcomes.set(invocationKey, outcome)
      void outcome.catch(() => messageOutcomes.delete(invocationKey))
      return outcome
    },
    async sessionSummary(session: SessionKey): Promise<SessionSubagentSummary> {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return { runningCount: 0, children: [] }
      const children = snapshot.records.map((child) => {
        const attempt = currentAttempt(child as DurableChild)
        const awaitingPermission = permissionOwner.hasAwaiting(child.frameId, attempt.id)
        return {
          frameId: child.frameId,
          title: child.title,
          status: attempt.status,
          ...(attempt.status === 'running' && awaitingPermission
            ? { awaitingPermission: true }
            : {})
        }
      })
      return {
        runningCount: children.filter((child) => child.status === 'running').length,
        children
      }
    },
    async readAgentFrame(session: SessionKey, frameId: string) {
      return projectionOwner.readAgentFrame(session, frameId)
    },
    async rootPermissionRequests(session) {
      return permissionOwner.requests(session)
    },
    async respondToPermission(session, response) {
      await permissionOwner.respond(session, response)
    },
    async setPermissionProfile(session, profile) {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return
      const failures = await Promise.all(
        [...running.entries()].map(async ([frameId, attempt]) => {
          try {
            await attempt.setPermissionProfile(profile)
            return undefined
          } catch (error) {
            const child = await snapshotChild(frameId)
            if (
              child &&
              currentAttempt(child).id === attempt.attemptId &&
              currentAttempt(child).status === 'running'
            ) {
              await stopChild(child, 'runtime_interrupted')
            }
            return error
          }
        })
      )
      const failure = failures.find((error) => error !== undefined)
      if (failure !== undefined) throw failure
    },
    async stopChildren(caller, frameIds) {
      return Promise.all(
        frameIds.map(async (frameId) =>
          stopChild(await readModel.findAuthorizedChild(caller, frameId), 'main_agent_stop')
        )
      )
    },
    stopSession,
    async recoverInterrupted() {
      const snapshot = await options.records.snapshot()
      const interrupted: DurableDelegateResult[] = []
      for (const child of snapshot.records as readonly DurableChild[]) {
        const attempt = currentAttempt(child)
        if (attempt.status !== 'running') continue
        const scope = { session: snapshot.session, frameId: child.frameId, attemptId: attempt.id }
        const evidenceScope = projectionOwner.attemptScope(snapshot, child, attempt)
        if (evidenceScope) await options.artifactEvidence?.revoke?.(evidenceScope)
        await options.revokeAttemptWrites?.(scope)
        await options.settleAttemptCleanup?.(scope)
        try {
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'cancelled',
            endedAt: now(),
            cancellationReason: 'runtime_interrupted'
          })
        } catch (error) {
          const latest = await snapshotChild(child.frameId)
          if (!latest || currentAttempt(latest).status === 'running') throw error
          continue
        }
        const result = await projectionOwner.projectResult(child.frameId)
        if (result) interrupted.push(result)
      }
      return { interrupted }
    },
    async deleteSession(session) {
      await stopSession(session)
      if (!options.workspace?.deleteSession) {
        throw new DurableDelegatedWorkError(
          'durability_failure',
          'Delegate workspace deletion is unavailable.'
        )
      }
      await options.workspace.deleteSession(session)
    }
  })
}

export { DurableDelegatedWorkError, createDurableDelegatedWork, createInMemoryDelegatedWorkRecords }
export type {
  DelegatedArtifactEvidence,
  DelegatedArtifactHandle,
  DelegatedArtifactProjectionScope,
  DelegatedArtifactScope,
  DelegatedReviewEvidence,
  DelegatedReviewProjectionScope,
  DurableChildSummary,
  DurableDelegateOutcome,
  DurableDelegateRequest,
  DurableDelegateResult,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableSendMessageOutcome,
  DurableDelegatedWork,
  ParentMessageDelivery,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  RootDelegatePermissionRequest,
  RootDelegatePermissionEvent,
  RootDelegatePermissionResponse,
  SpecialistDelegationProfile,
  SessionSubagentSummary,
  StopOutcome
}
export type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
export type {
  DelegatedWorkDurableRecords,
  DurableMessage,
  DurablePendingMessage,
  DurableSnapshot
} from './delegated-work-record-types'
