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
}

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

type DelegatedWorkDurableRecords = Readonly<{
  admitChildren(input: AdmitChildrenInput): Promise<void>
  startRuntime(frameId: string, attemptId: string, runtimeSegmentId: string): Promise<void>
  terminalize(input: TerminalInput): Promise<void>
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
          ]
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
  now?: () => number
  createId?: (kind: 'frame' | 'attempt' | 'message' | 'runtime') => string
}): DurableDelegatedWork => {
  const now = options.now ?? Date.now
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const invocationOutcomes = new Map<string, Promise<DurableDelegateOutcome>>()
  const stoppingSessions = new Set<string>()
  const running = new Map<
    string,
    {
      completion: Promise<void>
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

  const projectResult = async (frameId: string): Promise<DurableDelegateResult | undefined> => {
    const snapshot = await options.records.snapshot()
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    if (!child) return undefined
    const attempt = currentAttempt(child as DurableChild)
    if (attempt.status === 'running') return undefined
    const terminalMessage = attempt.terminalMessageId
      ? snapshot.messages.find((message) => message.id === attempt.terminalMessageId)
      : undefined
    return {
      frameId,
      attemptId: attempt.id,
      status: attempt.status,
      ...(attempt.terminalMessageId ? { terminalMessageId: attempt.terminalMessageId } : {}),
      ...(terminalMessage ? { response: terminalMessage.content } : {}),
      artifactsCreated: [],
      ...(attempt.cancellationReason ? { cancellationReason: attempt.cancellationReason } : {}),
      ...(attempt.error ? { error: attempt.error } : {})
    }
  }

  const authorizedChildren = async (
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): Promise<readonly DurableChild[]> => {
    if (caller.role !== 'main') {
      throw new DurableDelegatedWorkError(
        'authorization',
        'only the Main Agent can inspect children'
      )
    }
    const snapshot = await options.records.snapshot()
    if (!sameSession(snapshot.session, caller.session) || caller.frameId !== snapshot.rootFrameId) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'caller cannot access delegated children'
      )
    }
    if (!frameIds) {
      return snapshot.records.filter(
        (child) => child.parentFrameId === caller.frameId
      ) as DurableChild[]
    }
    return frameIds.map((frameId) => {
      const child = snapshot.records.find(
        (candidate) => candidate.frameId === frameId && candidate.parentFrameId === caller.frameId
      )
      if (!child) {
        throw new DurableDelegatedWorkError(
          'authorization',
          `caller cannot access child ${frameId}`
        )
      }
      return child as DurableChild
    })
  }

  const launch = (
    child: DurableChild,
    session: SessionKey,
    reservation: DelegateCapacityReservation,
    slotId: string
  ): void => {
    const attempt = currentAttempt(child)
    const runtimeSegmentId = createId('runtime')
    let handle: ReturnType<DelegateExecution['run']> | undefined
    let cancelRequested = false
    const completion = (async () => {
      try {
        await options.workspace?.prepare(session, child.frameId, child.inputs)
        await options.records.startRuntime(child.frameId, attempt.id, runtimeSegmentId)
        const latest = await snapshotChild(child.frameId)
        if (cancelRequested || !latest || currentAttempt(latest).status !== 'running') return
        const executionInput: DelegateExecutionInput = {
          session,
          frameId: child.frameId,
          attemptId: attempt.id,
          task: child.task,
          context: child.context,
          inputs: child.inputs,
          ...(attempt.resolvedAgent.kind === 'specialist'
            ? { profile: attempt.resolvedAgent.profileId }
            : {}),
          continuation: false
        }
        handle = options.execution.run(executionInput, slotId)
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
        running.delete(child.frameId)
      }
    })()
    running.set(child.frameId, {
      completion,
      async cancel() {
        cancelRequested = true
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
      ]
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
    async children(caller, frameIds) {
      const children = await authorizedChildren(caller, frameIds)
      return children.map((child) => {
        const attempt = currentAttempt(child)
        return {
          frameId: child.frameId,
          attemptId: attempt.id,
          title: child.title,
          status: attempt.status
        }
      })
    },
    async collect(caller, frameIds) {
      if (frameIds.length === 0) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'collect requires at least one child'
        )
      }
      const children = await authorizedChildren(caller, frameIds)
      await Promise.all(
        children.map(async (child) => {
          if (currentAttempt(child).status !== 'running') return
          const active = running.get(child.frameId)
          if (!active) {
            if (await projectResult(child.frameId)) return
            throw new DurableDelegatedWorkError(
              'durability_failure',
              `running delegated child ${child.frameId} has no active execution`
            )
          }
          await active.completion
        })
      )
      const results = await Promise.all(frameIds.map(projectResult))
      if (results.some((result) => !result)) {
        throw new DurableDelegatedWorkError(
          'durability_failure',
          'delegated work did not reach a durable terminal state'
        )
      }
      return results as DurableDelegateResult[]
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
  DurableDelegatedWork,
  DurableMessage,
  DurableSnapshot,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  SpecialistDelegationProfile,
  SessionSubagentSummary,
  StopOutcome
}
