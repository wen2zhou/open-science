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
  admitChild(input: AdmitChildInput): Promise<void>
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

type DurableDelegatedWork = Readonly<{
  delegate(
    caller: AuthenticatedDelegateCaller,
    request: DurableDelegateRequest,
    options?: Readonly<{ wait?: boolean }>
  ): Promise<DurableDelegateOutcome>
  sessionSummary(session: SessionKey): Promise<SessionSubagentSummary>
  readAgentFrame(
    session: SessionKey,
    frameId: string
  ): Promise<ReadOnlyAgentFrameDetail | undefined>
}>

class DurableDelegatedWorkError extends Error {
  constructor(
    readonly code:
      | 'admission_rejection'
      | 'authorization'
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
    async admitChild(admission) {
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
      if (
        state.records.some((child) => child.frameId === admission.frameId) ||
        state.records.some((child) =>
          child.attempts.some((attempt) => attempt.id === admission.attemptId)
        )
      ) {
        throw new Error('Duplicate delegated-work identity.')
      }
      state.records.push({
        frameId: admission.frameId,
        parentFrameId: admission.caller.frameId,
        originMessageId: admission.caller.originMessageId,
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
      })
      state.messages.push({
        id: admission.userMessageId,
        frameId: admission.frameId,
        role: 'user',
        content: admission.request.context
          ? `${admission.request.task}\n\nContext:\n${admission.request.context}`
          : admission.request.task,
        createdAt: admission.startedAt
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
  }>
  now?: () => number
  createId?: (kind: 'frame' | 'attempt' | 'message' | 'runtime') => string
}): DurableDelegatedWork => {
  const now = options.now ?? Date.now
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const invocationOutcomes = new Map<string, Promise<DurableDelegateOutcome>>()
  const running = new Map<
    string,
    { completion: Promise<void>; reservation: DelegateCapacityReservation; slotId: string }
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

  const launch = (
    child: DurableChild,
    reservation: DelegateCapacityReservation,
    slotId: string
  ): void => {
    const attempt = currentAttempt(child)
    const runtimeSegmentId = createId('runtime')
    const completion = (async () => {
      let handle: ReturnType<DelegateExecution['run']> | undefined
      try {
        await options.workspace?.prepare(
          (await options.records.snapshot()).session,
          child.frameId,
          child.inputs
        )
        await options.records.startRuntime(child.frameId, attempt.id, runtimeSegmentId)
        const executionInput: DelegateExecutionInput = {
          session: (await options.records.snapshot()).session,
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
        } else {
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
    running.set(child.frameId, { completion, reservation, slotId })
  }

  const delegateOnce = async (
    caller: AuthenticatedDelegateCaller,
    request: DurableDelegateRequest,
    delegateOptions: Readonly<{ wait?: boolean }>
  ): Promise<DurableDelegateOutcome> => {
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
    if (typeof request.task !== 'string' || request.task.trim().length === 0) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation requires a non-empty task'
      )
    }
    if (request.name !== undefined && (typeof request.name !== 'string' || !request.name.trim())) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit delegate name cannot be empty'
      )
    }
    if (
      request.context !== undefined &&
      (typeof request.context !== 'string' || !request.context.trim())
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit delegate context cannot be empty'
      )
    }
    const resolvedAgent = await resolveAgent(request.profile)
    if (
      request.inputs !== undefined &&
      (!Array.isArray(request.inputs) ||
        request.inputs.some((input) => typeof input !== 'string' || !input.trim()))
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation inputs must be immutable Version identities'
      )
    }
    if (request.inputs && options.validateInput) {
      const validInputs = await Promise.all(request.inputs.map(options.validateInput))
      if (validInputs.some((valid) => !valid)) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation inputs must be immutable Upload or Artifact Version identities'
        )
      }
    }
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
    const frameId = createId('frame')
    const attemptId = createId('attempt')
    try {
      await options.records.admitChild({
        caller,
        frameId,
        attemptId,
        userMessageId: createId('message'),
        title: request.name?.trim() || request.task.trim(),
        request: { ...request, task: request.task.trim() },
        resolvedAgent,
        startedAt: now()
      })
    } catch (error) {
      await reservation.releaseAll()
      throw error
    }
    const child = (await snapshotChild(frameId))!
    launch(child, reservation, reservation.slotIds[0])
    const receipt = { frameId, attemptId, status: 'running' as const }
    if (delegateOptions.wait === false) return { kind: 'receipts', children: [receipt] }
    await running.get(frameId)!.completion
    const result = await projectResult(frameId)
    if (!result) {
      throw new DurableDelegatedWorkError(
        'durability_failure',
        'delegated work did not reach a durable terminal state'
      )
    }
    return { kind: 'results', children: [result] }
  }

  return Object.freeze({
    delegate(
      caller: AuthenticatedDelegateCaller,
      request: DurableDelegateRequest,
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
    }
  })
}

export { DurableDelegatedWorkError, createDurableDelegatedWork, createInMemoryDelegatedWorkRecords }
export type {
  AuthenticatedDelegateCaller,
  DelegatedWorkDurableRecords,
  DurableDelegateOutcome,
  DurableDelegateRequest,
  DurableDelegateResult,
  DurableDelegatedWork,
  DurableMessage,
  DurableSnapshot,
  ReadOnlyAgentFrameDetail,
  SpecialistDelegationProfile,
  SessionSubagentSummary
}
