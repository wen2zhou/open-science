import { randomUUID } from 'node:crypto'

import type { SpecialistProfileView } from '../../shared/specialist'
import {
  DelegateExecutionError,
  type DelegateCapacityReservation,
  type DelegateExecution,
  type DelegateExecutionInput
} from './execution-port'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type AuthenticatedDelegateCaller = Readonly<{
  session: SessionKey
  frameId: string
  role: 'main' | 'delegate' | 'reviewer'
  originMessageId: string
  toolInvocationId: string
  attemptId?: string
}>

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

type DurableResolvedAgent =
  | Readonly<{ kind: 'main' }>
  | Readonly<{
      kind: 'specialist'
      profileId: string
      revision: number
      displayName: string
    }>

type DurableAttempt = {
  id: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  resolvedAgent: DurableResolvedAgent
  runtimeSegmentIds: string[]
  startedAt: number
  endedAt?: number
  terminalMessageId?: string
  cancellationReason?: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
  error?: Readonly<{ code: string; message: string }>
}

type DurableChild = {
  frameId: string
  parentFrameId: string
  originMessageId: string
  title: string
  task: string
  context?: string
  inputs: readonly string[]
  attempts: DurableAttempt[]
  pendingMessages: DurablePendingMessage[]
}

type DurablePendingMessage = Readonly<{
  id: string
  sourceFrameId: string
  sourceAttemptId?: string
  targetFrameId: string
  targetAttemptId?: string
  text: string
  kind: 'info' | 'question'
  createdAt: number
  deliveredAt?: number
}>

type ParentMessageDelivery = Readonly<{
  messageId: string
  session: SessionKey
  sourceFrameId: string
  sourceAttemptId: string
  targetFrameId: string
  text: string
  kind: 'info' | 'question'
}>

type DurableMessage = {
  id: string
  frameId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

type DurableSnapshot = Readonly<{
  session: SessionKey
  rootFrameId: string
  originMessageIds: readonly string[]
  records: readonly DurableChild[]
  messages: readonly DurableMessage[]
}>

type AdmitChildInput = Readonly<{
  caller: AuthenticatedDelegateCaller
  frameId: string
  attemptId: string
  userMessageId: string
  title: string
  request: DurableDelegateRequest
  resolvedAgent: DurableResolvedAgent
  startedAt: number
}>

type AdmitChildrenInput = Readonly<{
  caller: AuthenticatedDelegateCaller
  children: readonly Omit<AdmitChildInput, 'caller'>[]
}>

type TerminalInput =
  | Readonly<{
      frameId: string
      attemptId: string
      status: 'completed'
      endedAt: number
      terminalMessage: DurableMessage
    }>
  | Readonly<{
      frameId: string
      attemptId: string
      status: 'cancelled'
      endedAt: number
      cancellationReason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
    }>
  | Readonly<{
      frameId: string
      attemptId: string
      status: 'error'
      endedAt: number
      error: Readonly<{ code: string; message: string }>
    }>

type ContinueChildInput = Readonly<{
  frameId: string
  previousAttemptId: string
  attemptId: string
  userMessageId: string
  message: string
  resolvedAgent: DurableResolvedAgent
  startedAt: number
}>

type DelegatedWorkDurableRecords = Readonly<{
  admitChildren(input: AdmitChildrenInput): Promise<void>
  continueChild(input: ContinueChildInput): Promise<void>
  startRuntime(frameId: string, attemptId: string, runtimeSegmentId: string): Promise<void>
  terminalize(input: TerminalInput): Promise<void>
  appendPendingMessage(
    frameId: string,
    attemptId: string,
    message: DurablePendingMessage
  ): Promise<void>
  markMessageDelivered(
    frameId: string,
    attemptId: string,
    messageId: string,
    deliveredAt: number
  ): Promise<void>
  snapshot(): Promise<DurableSnapshot>
}>

type SessionSubagentSummary = Readonly<{
  runningCount: number
  children: readonly Readonly<{
    frameId: string
    title: string
    status: 'running' | 'completed' | 'cancelled' | 'error'
  }>[]
}>

type DurableChildSummary = Readonly<{
  frameId: string
  attemptId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
}>

type DurableDelegateResult = Readonly<{
  frameId: string
  attemptId: string
  status: 'completed' | 'cancelled' | 'error'
  terminalMessageId?: string
  response?: string
  artifactsCreated: readonly never[]
  cancellationReason?: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
  error?: Readonly<{ code: string; message: string }>
}>

type DurableDelegateOutcome =
  | Readonly<{
      kind: 'receipts'
      children: readonly Readonly<{ frameId: string; attemptId: string; status: 'running' }>[]
    }>
  | Readonly<{ kind: 'results'; children: readonly DurableDelegateResult[] }>

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
  messages: readonly Readonly<{ role: 'user' | 'assistant'; content: string }>[]
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
    frameIds: readonly string[]
  ): Promise<readonly DurableDelegateResult[]>
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
  stopChildren(
    caller: AuthenticatedDelegateCaller,
    frameIds: readonly string[]
  ): Promise<readonly StopOutcome[]>
  stopSession(session: SessionKey): Promise<readonly StopOutcome[]>
  recoverInterrupted(): Promise<RecoveryOutcome>
  deleteSession(session: SessionKey): Promise<void>
}>

class DurableDelegatedWorkError extends Error {
  constructor(
    readonly code:
      | 'admission_rejection'
      | 'authorization'
      | 'conflict'
      | 'capacity'
      | 'unsupported_framework'
      | 'execution_failure'
      | 'durability_failure',
    message: string
  ) {
    super(message)
    this.name = 'DurableDelegatedWorkError'
  }
}

const sameSession = (left: SessionKey, right: SessionKey): boolean =>
  left.projectId === right.projectId && left.sessionId === right.sessionId

const currentAttempt = (child: DurableChild): DurableAttempt =>
  child.attempts[child.attempts.length - 1]

const createInMemoryDelegatedWorkRecords = (input: {
  session: SessionKey
  rootFrameId: string
  originMessageId: string
}): DelegatedWorkDurableRecords => {
  const state: {
    session: SessionKey
    rootFrameId: string
    originMessageIds: string[]
    records: DurableChild[]
    messages: DurableMessage[]
  } = {
    session: { ...input.session },
    rootFrameId: input.rootFrameId,
    originMessageIds: [input.originMessageId],
    records: [],
    messages: []
  }
  const findRunning = (frameId: string, attemptId: string): DurableAttempt => {
    const child = state.records.find((candidate) => candidate.frameId === frameId)
    const attempt = child && currentAttempt(child)
    if (!attempt || attempt.id !== attemptId || attempt.status !== 'running') {
      throw new Error('Delegated Attempt is not current and running.')
    }
    return attempt
  }
  return {
    async admitChildren(admission) {
      if (
        !sameSession(state.session, admission.caller.session) ||
        admission.caller.frameId !== state.rootFrameId ||
        !state.originMessageIds.includes(admission.caller.originMessageId)
      ) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'delegation caller or origin Message is outside the active root conversation'
        )
      }
      if (admission.children.length === 0) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation requires one or more children'
        )
      }
      const frameIds = admission.children.map((child) => child.frameId)
      const attemptIds = admission.children.map((child) => child.attemptId)
      const messageIds = admission.children.map((child) => child.userMessageId)
      if (
        new Set(frameIds).size !== frameIds.length ||
        new Set(attemptIds).size !== attemptIds.length ||
        new Set(messageIds).size !== messageIds.length ||
        state.records.some((child) => frameIds.includes(child.frameId)) ||
        state.records.some((child) =>
          child.attempts.some((attempt) => attemptIds.includes(attempt.id))
        ) ||
        state.messages.some((message) => messageIds.includes(message.id))
      ) {
        throw new Error('Duplicate delegated-work identity.')
      }
      state.records.push(
        ...admission.children.map((child) => ({
          frameId: child.frameId,
          parentFrameId: admission.caller.frameId,
          originMessageId: admission.caller.originMessageId,
          title: child.title,
          task: child.request.task,
          context: child.request.context,
          inputs: [...(child.request.inputs ?? [])],
          attempts: [
            {
              id: child.attemptId,
              status: 'running' as const,
              resolvedAgent: structuredClone(child.resolvedAgent),
              runtimeSegmentIds: [],
              startedAt: child.startedAt
            }
          ],
          pendingMessages: []
        }))
      )
      state.messages.push(
        ...admission.children.map((child) => ({
          id: child.userMessageId,
          frameId: child.frameId,
          role: 'user' as const,
          content: child.request.context
            ? `${child.request.task}\n\nContext:\n${child.request.context}`
            : child.request.task,
          createdAt: child.startedAt
        }))
      )
    },
    async continueChild(input) {
      const child = state.records.find((candidate) => candidate.frameId === input.frameId)
      const previous = child && currentAttempt(child)
      if (
        !child ||
        !previous ||
        previous.id !== input.previousAttemptId ||
        previous.status === 'running'
      ) {
        throw new DurableDelegatedWorkError(
          'conflict',
          `child ${input.frameId} is not at the expected terminal Attempt`
        )
      }
      if (
        state.records.some((record) =>
          record.attempts.some((attempt) => attempt.id === input.attemptId)
        ) ||
        state.messages.some((message) => message.id === input.userMessageId)
      ) {
        throw new Error('Duplicate continuation identity.')
      }
      child.attempts.push({
        id: input.attemptId,
        status: 'running',
        resolvedAgent: structuredClone(input.resolvedAgent),
        runtimeSegmentIds: [],
        startedAt: input.startedAt
      })
      state.messages.push({
        id: input.userMessageId,
        frameId: input.frameId,
        role: 'user',
        content: input.message,
        createdAt: input.startedAt
      })
    },
    async startRuntime(frameId, attemptId, runtimeSegmentId) {
      findRunning(frameId, attemptId).runtimeSegmentIds.push(runtimeSegmentId)
    },
    async terminalize(terminal) {
      const attempt = findRunning(terminal.frameId, terminal.attemptId)
      attempt.status = terminal.status
      attempt.endedAt = terminal.endedAt
      if (terminal.status === 'completed') {
        state.messages.push({ ...terminal.terminalMessage })
        attempt.terminalMessageId = terminal.terminalMessage.id
      } else if (terminal.status === 'cancelled') {
        attempt.cancellationReason = terminal.cancellationReason
      } else {
        attempt.error = { ...terminal.error }
      }
    },
    async appendPendingMessage(frameId, attemptId, message) {
      const child = state.records.find((candidate) => candidate.frameId === frameId)
      const attempt = child && currentAttempt(child)
      if (!child || !attempt || attempt.id !== attemptId || attempt.status !== 'running') {
        throw new DurableDelegatedWorkError(
          'conflict',
          'Pending Message Attempt is not current and running.'
        )
      }
      if (
        state.records.some((record) => record.pendingMessages.some(({ id }) => id === message.id))
      ) {
        throw new Error(`Pending Message already exists: ${message.id}`)
      }
      child.pendingMessages.push(structuredClone(message))
    },
    async markMessageDelivered(frameId, attemptId, messageId, deliveredAt) {
      const child = state.records.find((candidate) => candidate.frameId === frameId)
      const attempt = child && currentAttempt(child)
      if (!child || !attempt || attempt.id !== attemptId || attempt.status !== 'running') {
        throw new DurableDelegatedWorkError(
          'conflict',
          'Pending Message Attempt is not current and running.'
        )
      }
      const index = child.pendingMessages.findIndex(({ id }) => id === messageId)
      const message = child.pendingMessages[index]
      if (!message) throw new Error(`Pending Message not found: ${messageId}`)
      if (message.deliveredAt !== undefined) return
      child.pendingMessages[index] = { ...message, deliveredAt }
    },
    snapshot: async () => structuredClone(state)
  }
}

const createDurableDelegatedWork = (options: {
  execution: DelegateExecution
  records: DelegatedWorkDurableRecords
  assertAvailable?: (caller: AuthenticatedDelegateCaller) => Promise<void> | void
  resolveSpecialist?: (
    profileId: string
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
  now?: () => number
  createId?: (kind: 'frame' | 'attempt' | 'message' | 'runtime') => string
  collectPollIntervalMs?: number
}): DurableDelegatedWork => {
  const now = options.now ?? Date.now
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const invocationOutcomes = new Map<string, Promise<DurableDelegateOutcome>>()
  const messageOutcomes = new Map<string, Promise<DurableSendMessageOutcome>>()
  const stoppingSessions = new Set<string>()
  const running = new Map<
    string,
    {
      attemptId: string
      completion: Promise<void>
      deliver(message: string): Promise<void>
      cancel(): Promise<void>
      reservation: DelegateCapacityReservation
      slotId: string
    }
  >()

  const resolveAgent = async (profileId: string | undefined): Promise<DurableResolvedAgent> => {
    if (profileId === undefined) return { kind: 'main' }
    if (typeof profileId !== 'string' || !profileId.trim()) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit Specialist profile identity cannot be empty'
      )
    }
    let profile: SpecialistDelegationProfile | undefined
    try {
      profile = await options.resolveSpecialist?.(profileId)
    } catch (error) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (
      !profile ||
      profile.id !== profileId ||
      !profile.enabled ||
      profile.setupPending === true ||
      !Number.isSafeInteger(profile.revision) ||
      profile.revision < 0
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        `Specialist ${profileId} is unavailable for delegated execution`
      )
    }
    const displayName = profile.displayName?.trim() || profile.name.trim()
    if (!displayName) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        `Specialist ${profileId} has no display label`
      )
    }
    return {
      kind: 'specialist',
      profileId: profile.id,
      revision: profile.revision,
      displayName
    }
  }

  const snapshotChild = async (frameId: string): Promise<DurableChild | undefined> =>
    (await options.records.snapshot()).records.find((child) => child.frameId === frameId) as
      DurableChild | undefined

  const authenticatedSnapshot = async (
    caller: AuthenticatedDelegateCaller
  ): Promise<DurableSnapshot> => {
    const snapshot = await options.records.snapshot()
    if (
      caller.role !== 'main' ||
      !sameSession(snapshot.session, caller.session) ||
      caller.frameId !== snapshot.rootFrameId ||
      !snapshot.originMessageIds.includes(caller.originMessageId) ||
      !caller.toolInvocationId.trim()
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegated children are outside the authenticated parent conversation'
      )
    }
    return snapshot
  }

  const selectAuthorizedChildren = (
    snapshot: DurableSnapshot,
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): readonly DurableChild[] => {
    const directChildren = snapshot.records.filter(
      (child) => child.parentFrameId === caller.frameId
    ) as readonly DurableChild[]
    if (!frameIds) return directChildren
    const selected = frameIds.map((frameId) =>
      directChildren.find((child) => child.frameId === frameId)
    )
    if (selected.some((child) => !child)) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'one or more requested children are outside the authenticated parent conversation'
      )
    }
    return selected as readonly DurableChild[]
  }

  const projectSnapshotResult = (
    snapshot: DurableSnapshot,
    child: DurableChild
  ): DurableDelegateResult | undefined => {
    const attempt = currentAttempt(child)
    if (attempt.status === 'running') return undefined
    const terminalMessage = attempt.terminalMessageId
      ? snapshot.messages.find((message) => message.id === attempt.terminalMessageId)
      : undefined
    return {
      frameId: child.frameId,
      attemptId: attempt.id,
      status: attempt.status,
      ...(attempt.terminalMessageId ? { terminalMessageId: attempt.terminalMessageId } : {}),
      ...(terminalMessage ? { response: terminalMessage.content } : {}),
      artifactsCreated: [],
      ...(attempt.cancellationReason ? { cancellationReason: attempt.cancellationReason } : {}),
      ...(attempt.error ? { error: attempt.error } : {})
    }
  }

  const projectResult = async (frameId: string): Promise<DurableDelegateResult | undefined> => {
    const snapshot = await options.records.snapshot()
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    if (!child) return undefined
    return projectSnapshotResult(snapshot, child as DurableChild)
  }

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
    let cancelRequested = false
    const completion = (async () => {
      try {
        await options.workspace?.prepare(session, child.frameId, child.inputs)
        await options.records.startRuntime(child.frameId, attempt.id, runtimeSegmentId)
        const latest = await snapshotChild(child.frameId)
        if (cancelRequested || !latest || currentAttempt(latest).status !== 'running') {
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
          ...(attempt.resolvedAgent.kind === 'specialist'
            ? { profile: attempt.resolvedAgent.profileId }
            : {}),
          continuation
        }
        handle = options.execution.run(executionInput, slotId)
        resolveHandle(handle)
        await Promise.race([handle.accepted, handle.completion.then(() => undefined)])
        const outcome = await handle.completion
        if (outcome.status === 'completed') {
          const endedAt = now()
          const terminalMessage: DurableMessage = {
            id: createId('message'),
            frameId: child.frameId,
            role: 'assistant',
            content: outcome.response,
            createdAt: endedAt
          }
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'completed',
            endedAt,
            terminalMessage
          })
        } else if (!cancelRequested) {
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'cancelled',
            endedAt: now(),
            cancellationReason: 'main_agent_stop'
          })
        }
      } catch (error) {
        rejectHandle(error)
        const latest = await snapshotChild(child.frameId)
        if (latest && currentAttempt(latest).status === 'running') {
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'error',
            endedAt: now(),
            error: {
              code: 'execution_failure',
              message: error instanceof Error ? error.message : String(error)
            }
          })
        }
      } finally {
        await reservation.release(slotId).catch(() => undefined)
        if (running.get(child.frameId)?.attemptId === attempt.id) running.delete(child.frameId)
      }
    })()
    running.set(child.frameId, {
      attemptId: attempt.id,
      completion,
      async deliver(message) {
        await (await deliveryHandle).sendMessage(message)
      },
      async cancel() {
        cancelRequested = true
        rejectHandle(new Error('delegate execution was cancelled before message delivery'))
        await handle?.cancel()
      },
      reservation,
      slotId
    })
  }

  const findAuthorizedChild = async (
    caller: AuthenticatedDelegateCaller,
    frameId: string
  ): Promise<DurableChild> => {
    const snapshot = await options.records.snapshot()
    const child = snapshot.records.find(
      (candidate) =>
        sameSession(snapshot.session, caller.session) &&
        candidate.frameId === frameId &&
        candidate.parentFrameId === caller.frameId
    )
    if (caller.role !== 'main' || !child) {
      throw new DurableDelegatedWorkError('authorization', 'caller cannot access delegated child')
    }
    return child as DurableChild
  }

  const stopChild = async (
    child: DurableChild,
    reason: 'main_agent_stop' | 'session_stop'
  ): Promise<StopOutcome> => {
    const attempt = currentAttempt(child)
    if (attempt.status !== 'running') {
      return { frameId: child.frameId, status: 'already_terminal' }
    }
    const session = (await options.records.snapshot()).session
    const scope = { session, frameId: child.frameId, attemptId: attempt.id }
    await options.revokeAttemptWrites?.(scope)
    await running
      .get(child.frameId)
      ?.cancel()
      .catch(() => undefined)
    await options.settleAttemptCleanup?.(scope)
    try {
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
        error instanceof Error ? error.message : String(error)
      )
    }
    const rawRequests: readonly unknown[] = Array.isArray(requestOrRequests)
      ? requestOrRequests
      : [requestOrRequests]
    if (
      rawRequests.length === 0 ||
      rawRequests.some(
        (request) =>
          typeof request !== 'object' ||
          request === null ||
          Array.isArray(request) ||
          !('task' in request) ||
          typeof request.task !== 'string' ||
          request.task.trim().length === 0
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation requires a non-empty task'
      )
    }
    const requests = rawRequests as readonly DurableDelegateRequest[]
    if (
      requests.some(
        (request) =>
          request.name !== undefined && (typeof request.name !== 'string' || !request.name.trim())
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit delegate name cannot be empty'
      )
    }
    if (
      requests.some(
        (request) =>
          request.context !== undefined &&
          (typeof request.context !== 'string' || !request.context.trim())
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit delegate context cannot be empty'
      )
    }
    const resolvedAgents = await Promise.all(
      requests.map((request) => resolveAgent(request.profile))
    )
    if (
      requests.some(
        (request) =>
          request.inputs !== undefined &&
          (!Array.isArray(request.inputs) ||
            request.inputs.some((input) => typeof input !== 'string' || !input.trim()))
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation inputs must be immutable Version identities'
      )
    }
    const inputs = requests.flatMap((request) => request.inputs ?? [])
    if (inputs.length > 0 && options.validateInput) {
      const validInputs = await Promise.all(inputs.map(options.validateInput))
      if (validInputs.some((valid) => !valid)) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation inputs must be immutable Upload or Artifact Version identities'
        )
      }
    }
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
      title: admission.title,
      task: admission.request.task,
      context: admission.request.context,
      inputs: [...(admission.request.inputs ?? [])],
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
    const receipts = admissions.map(({ frameId, attemptId }) => ({
      frameId,
      attemptId,
      status: 'running' as const
    }))
    if (delegateOptions.wait === false) return { kind: 'receipts', children: receipts }
    await Promise.all(completions)
    const results = await Promise.all(admissions.map(({ frameId }) => projectResult(frameId)))
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
      const snapshot = await authenticatedSnapshot(caller)
      return selectAuthorizedChildren(snapshot, caller, frameIds).map((child) => {
        const attempt = currentAttempt(child)
        return {
          frameId: child.frameId,
          attemptId: attempt.id,
          title: child.title,
          status: attempt.status
        }
      })
    },
    async collect(
      caller: AuthenticatedDelegateCaller,
      frameIds: readonly string[]
    ): Promise<readonly DurableDelegateResult[]> {
      if (!Array.isArray(frameIds) || frameIds.length === 0) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'collect requires at least one child'
        )
      }
      for (;;) {
        const snapshot = await authenticatedSnapshot(caller)
        const children = selectAuthorizedChildren(snapshot, caller, frameIds)
        const results = children.map((child) => projectSnapshotResult(snapshot, child))
        if (results.every((result) => result !== undefined)) {
          return results as readonly DurableDelegateResult[]
        }
        await new Promise((resolve) => setTimeout(resolve, options.collectPollIntervalMs ?? 10))
      }
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
            try {
              await active.deliver(pendingMessage.text)
              await options.records.markMessageDelivered(
                child.frameId,
                previous.id,
                pendingMessage.id,
                now()
              )
            } catch (error) {
              if (error instanceof DurableDelegatedWorkError) throw error
              throw new DurableDelegatedWorkError(
                'execution_failure',
                `message delivery failed: ${error instanceof Error ? error.message : String(error)}`
              )
            }
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
            : await resolveAgent(previous.resolvedAgent.profileId)
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
            startedAt: now()
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
        return {
          frameId: child.frameId,
          title: child.title,
          status: attempt.status
        }
      })
      return {
        runningCount: children.filter((child) => child.status === 'running').length,
        children
      }
    },
    async readAgentFrame(session: SessionKey, frameId: string) {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return undefined
      const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
      if (!child) return undefined
      const attempt = currentAttempt(child as DurableChild)
      return Object.freeze({
        frameId,
        title: child.title,
        status: attempt.status,
        resolvedAgent: Object.freeze(structuredClone(attempt.resolvedAgent)),
        messages: Object.freeze(
          snapshot.messages
            .filter((message) => message.frameId === frameId)
            .map(({ role, content }) => Object.freeze({ role, content }))
        )
      })
    },
    async stopChildren(caller, frameIds) {
      return Promise.all(
        frameIds.map(async (frameId) =>
          stopChild(await findAuthorizedChild(caller, frameId), 'main_agent_stop')
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
        const result = await projectResult(child.frameId)
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
  AuthenticatedDelegateCaller,
  DelegatedWorkDurableRecords,
  DurableChildSummary,
  DurableDelegateOutcome,
  DurableDelegateRequest,
  DurableDelegateResult,
  DurableSendMessageOutcome,
  DurableDelegatedWork,
  DurableMessage,
  DurablePendingMessage,
  DurableSnapshot,
  ParentMessageDelivery,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  SpecialistDelegationProfile,
  SessionSubagentSummary,
  StopOutcome
}
