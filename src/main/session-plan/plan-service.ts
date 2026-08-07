import { createHash, randomUUID } from 'node:crypto'

import type {
  PersistedChatMessage,
  SessionPlanRuntimeContext,
  SessionPlanTurnRuntimeContext,
  SessionPlanStepStatus,
  SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  createPlanDocumentV1,
  derivePlanLifecycle,
  isPlanTerminalOutcome,
  parsePlanDocumentV1,
  PlanCommandError,
  projectPlanStepStates,
  planStepTitles,
  type ActivePlanProjection,
  type GeneratePlanContent,
  type PlanDocumentV1,
  type PlanResponseCommand
} from '../../shared/session-plan/contract'

type ArtifactWriteResult = Readonly<{
  artifactId?: string
  versionId?: string
  checksum?: string
  name: string
}>

type PlanServiceDependencies = Readonly<{
  writeArtifactForActiveTurn: (
    sessionId: string,
    input: { filename: string; content: string; mimeType: string; kind: 'plan' }
  ) => Promise<ArtifactWriteResult>
  readArtifactVersion: (input: {
    projectId: string
    sessionId: string
    artifactId: string
    artifactVersionId: string
  }) => Promise<{ content: string; checksum: string }>
  readRuntimeContext: (projectId: string, sessionId: string) => Promise<SessionRuntimeContext>
  patchRuntimeContext: (input: {
    projectId: string
    sessionId: string
    expectedRevision: number
    plan: SessionPlanRuntimeContext | undefined
    // Omitted preserves the Turn; null clears it in the same CAS as the Plan mutation.
    planTurn?: SessionPlanTurnRuntimeContext | null
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle' | 'error'
  }) => Promise<SessionRuntimeContext>
  isRevisionConflict: (error: unknown) => boolean
  resolveLegacyPlanTurnAnchor?: (
    projectId: string,
    sessionId: string,
    originatingPromptMessageId?: string
  ) => Promise<
    | Readonly<{ status: 'resolved'; turnAnchor: string }>
    | Readonly<{ status: 'unresolved'; reason: string }>
  >
  commitFeedback: (input: {
    projectId: string
    sessionId: string
    content: string
    turnAnchor: string
    messageId: string
    commandId: string
    expectedRevision: number
    plan: SessionPlanRuntimeContext
    planTurn: SessionPlanTurnRuntimeContext
  }) => Promise<{ context: SessionRuntimeContext; message: PersistedChatMessage; changed: boolean }>
  now?: () => number
  createId?: () => string
}>

type PlanIdentityCommand = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
  turnAnchor?: string
  commandId?: string
}>

type PlanDecisionResult = {
  projection: ActivePlanProjection
  changed: boolean
  kind?: 'continuation_requested'
  turn?: SessionPlanTurnRuntimeContext
}
type PlanRetryResult = PlanDecisionResult & {
  kind: 'continuation_requested'
  turn: SessionPlanTurnRuntimeContext
}
type PlanFeedbackResult = {
  kind: 'revision_requested'
  projection: ActivePlanProjection
  turn: SessionPlanTurnRuntimeContext
  changed: boolean
  text: string
  message: PersistedChatMessage
}
type PlanResponseResult = PlanDecisionResult | PlanFeedbackResult | PlanRetryResult

export type LegacyPendingPlanRecoveryResult =
  | Readonly<{ status: 'not-needed' }>
  | Readonly<{
      status: 'recovered'
      projection: ActivePlanProjection
      turn: SessionPlanTurnRuntimeContext
    }>
  | Readonly<{
      status: 'read-only'
      error: Readonly<{ code: 'artifact-unavailable' | 'interaction-mismatch'; message: string }>
    }>

export type PlanContinuationRecovery = Readonly<{
  projection: ActivePlanProjection
  turn: SessionPlanTurnRuntimeContext
}>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const isTerminalStepStatus = (status: SessionPlanStepStatus): boolean =>
  status === 'completed' || status === 'blocked' || status === 'skipped'

const runtimeStatusFor = (
  plan: SessionPlanRuntimeContext,
  title: string
): SessionPlanRuntimeContext['stepStatuses'][string] | undefined =>
  Object.hasOwn(plan.stepStatuses, title) ? plan.stepStatuses[title] : undefined

const parseDocument = (content: string): PlanDocumentV1 => {
  try {
    return parsePlanDocumentV1(JSON.parse(content))
  } catch {
    throw new PlanCommandError('artifact-unavailable', 'The active Plan Artifact is unreadable.')
  }
}

class PlanService {
  private readonly now: () => number
  private readonly createId: () => string
  constructor(private readonly dependencies: PlanServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => randomUUID().slice(0, 8))
  }

  async generate(input: {
    projectId: string
    sessionId: string
    interactionId: string
    attemptId?: string
    turnAnchor?: string
    artifactVersionId?: string
    expectedRevision?: number
    continuationId?: string
    content: GeneratePlanContent
  }): Promise<{
    kind: 'plan_suspended'
    projection: ActivePlanProjection
    turn: SessionPlanTurnRuntimeContext
    pauseInteraction: true
  }> {
    const document = createPlanDocumentV1(input.content)
    const current = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const replacement = current.plan ? this.requireActiveReviseAttempt(current, input) : undefined
    const serialized = JSON.stringify(document, null, 2)
    const artifact = await this.dependencies.writeArtifactForActiveTurn(input.sessionId, {
      filename: `plan-${this.createId()}.json`,
      content: serialized,
      mimeType: 'application/json',
      kind: 'plan'
    })
    if (!artifact.artifactId || !artifact.versionId || !artifact.checksum) {
      throw new PlanCommandError('artifact-unavailable', 'Plan Artifact provenance is incomplete.')
    }
    const verified = await this.dependencies.readArtifactVersion({
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId
    })
    if (
      verified.content !== serialized ||
      verified.checksum !== artifact.checksum ||
      sha256(verified.content) !== artifact.checksum
    ) {
      throw new PlanCommandError(
        'artifact-unavailable',
        'Plan Artifact checksum verification failed.'
      )
    }
    const plan: SessionPlanRuntimeContext = {
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId,
      artifactChecksum: artifact.checksum,
      originatingPromptMessageId: replacement?.turnAnchor ?? input.interactionId,
      approval: 'pending',
      stepStatuses: {}
    }
    const planTurn: SessionPlanTurnRuntimeContext = {
      turnAnchor: replacement?.turnAnchor ?? input.interactionId,
      lifecycle: 'awaiting_plan_approval',
      planArtifactVersionId: plan.artifactVersionId
    }
    let next: SessionRuntimeContext
    try {
      next = await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: current.revision,
        plan,
        planTurn,
        sessionStatus: 'waiting-plan-approval'
      })
    } catch (error) {
      if (this.dependencies.isRevisionConflict(error)) {
        throw new PlanCommandError('revision-conflict', 'The Session Plan changed concurrently.')
      }
      throw error
    }
    return {
      kind: 'plan_suspended',
      projection: this.project(document, plan, next.revision),
      turn: planTurn,
      pauseInteraction: true
    }
  }

  async respond(
    input: PlanIdentityCommand &
      Readonly<{
        turnAnchor: string
        commandId: string
        decision: 'approved' | 'rejected'
        interactionIsLive?: boolean
      }>
  ): Promise<PlanDecisionResult>
  async respond(
    input: PlanIdentityCommand &
      Readonly<{ turnAnchor: string; commandId: string; feedback: string }>
  ): Promise<PlanFeedbackResult>
  async respond(
    input: PlanIdentityCommand & Readonly<{ turnAnchor: string; commandId: string; retry: true }>
  ): Promise<PlanRetryResult>
  async respond(
    input: PlanResponseCommand & Readonly<{ interactionIsLive?: boolean }>
  ): Promise<PlanResponseResult>
  async respond(
    input: PlanResponseCommand & Readonly<{ interactionIsLive?: boolean }>
  ): Promise<PlanResponseResult> {
    if ('retry' in input && input.retry) return this.retryContinuation(input)
    if (input.decision === undefined) {
      const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
      const plan = context.plan
      if (!plan) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
      if (plan.artifactVersionId !== input.artifactVersionId) {
        throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
      }
      if (!input.turnAnchor || !input.commandId) {
        throw new PlanCommandError('interaction-mismatch', 'Plan feedback identity is incomplete.')
      }
      const repeated = context.planTurn?.continuation
      if (
        repeated?.purpose === 'revise_pending_plan' &&
        repeated.commandId === input.commandId &&
        repeated.feedbackMessageId &&
        context.planTurn
      ) {
        const committed = await this.dependencies.commitFeedback({
          projectId: input.projectId,
          sessionId: input.sessionId,
          content: input.feedback.trim(),
          turnAnchor: input.turnAnchor,
          messageId: repeated.feedbackMessageId,
          commandId: input.commandId,
          expectedRevision: input.expectedRevision,
          plan,
          planTurn: context.planTurn
        })
        const document = await this.readDocument(input.projectId, input.sessionId, plan)
        return {
          kind: 'revision_requested',
          projection: this.project(document, plan, committed.context.revision),
          turn: context.planTurn,
          changed: false,
          text: committed.message.content,
          message: committed.message
        }
      }
      if (context.revision !== input.expectedRevision) {
        throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
      }
      if (plan.approval !== 'pending') {
        throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
      }
      const text = input.feedback.trim()
      if (!text) throw new PlanCommandError('invalid-plan', 'Plan feedback must be non-empty.')
      const turn = this.requireAwaitingTurn(context, plan, input.turnAnchor)
      const now = this.now()
      const messageId = `message-${this.createId()}`
      const nextTurn: SessionPlanTurnRuntimeContext = {
        ...turn,
        lifecycle: 'continuation_pending',
        continuation: {
          continuationId: `continuation-${this.createId()}`,
          purpose: 'revise_pending_plan',
          state: 'pending',
          commandId: input.commandId,
          feedbackMessageId: messageId,
          requestedAt: now,
          lastTransitionAt: now
        }
      }
      const committed = await this.dependencies.commitFeedback({
        projectId: input.projectId,
        sessionId: input.sessionId,
        content: text,
        turnAnchor: turn.turnAnchor,
        messageId,
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        plan,
        planTurn: nextTurn
      })
      const committedTurn = committed.context.planTurn
      if (!committedTurn) throw new Error('Committed Plan feedback Turn is unavailable.')
      const document = await this.readDocument(input.projectId, input.sessionId, plan)
      return {
        kind: 'revision_requested',
        projection: this.project(document, plan, committed.context.revision),
        turn: committedTurn,
        changed: committed.changed,
        text,
        message: committed.message
      }
    }
    if (!input.turnAnchor || !input.commandId) {
      throw new PlanCommandError('interaction-mismatch', 'Plan decision identity is incomplete.')
    }
    const { context, plan, document } = await this.loadActive(input, input.decision)
    if (plan.originatingPromptMessageId !== input.turnAnchor) {
      throw new PlanCommandError('interaction-mismatch', 'The Plan belongs to a different Turn.')
    }
    if (plan.approval === input.decision) {
      return {
        projection: this.project(document, plan, context.revision, input.interactionIsLive),
        changed: false,
        ...(context.planTurn?.continuation
          ? { kind: 'continuation_requested' as const, turn: context.planTurn }
          : {})
      }
    }
    if (plan.approval !== 'pending') {
      throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
    }
    const updated = { ...plan, approval: input.decision }
    const continuationRequested = input.decision === 'approved'
    const now = this.now()
    const turn = continuationRequested
      ? this.requireAwaitingTurn(context, plan, input.turnAnchor)
      : undefined
    const nextTurn: SessionPlanTurnRuntimeContext | undefined = turn
      ? {
          ...turn,
          lifecycle: 'continuation_pending',
          continuation: {
            continuationId: `continuation-${this.createId()}`,
            purpose: 'execute_approved_plan',
            state: 'pending',
            commandId: input.commandId,
            requestedAt: now,
            lastTransitionAt: now
          }
        }
      : undefined
    const next = await this.patch(
      input,
      updated,
      continuationRequested ? 'running' : 'idle',
      continuationRequested ? nextTurn : null
    )
    return {
      projection: this.project(document, updated, next.revision, input.interactionIsLive),
      changed: true,
      ...(nextTurn ? { kind: 'continuation_requested' as const, turn: nextTurn } : {})
    }
  }

  async updateStepStatus(
    input: PlanIdentityCommand &
      Readonly<{
        title: string
        status: SessionPlanStepStatus
        notes?: string
        continuationId?: string
        attemptId?: string
      }>
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }> {
    const { context, plan, document } = await this.loadActive(input, undefined, {
      title: input.title,
      status: input.status
    })
    if (plan.approval !== 'approved') {
      throw new PlanCommandError('plan-not-approved', 'The Plan must be approved before execution.')
    }
    if (!planStepTitles(document).includes(input.title)) {
      throw new PlanCommandError('unknown-step', `Unknown Plan step: ${input.title}`)
    }
    const previous = runtimeStatusFor(plan, input.title)?.status
    const sameTerminal = previous === input.status && isTerminalStepStatus(input.status)
    if (sameTerminal) {
      return { projection: this.project(document, plan, context.revision, true), changed: false }
    }
    if (previous && isTerminalStepStatus(previous)) {
      throw new PlanCommandError('invalid-transition', 'Invalid Plan step transition.')
    }
    this.requireExecutionAuthority(context, plan, input)
    const startsStep = !previous && (input.status === 'in_progress' || input.status === 'skipped')
    const valid =
      startsStep ||
      (previous === 'in_progress' && ['in_progress', 'completed', 'blocked'].includes(input.status))
    if (!valid) throw new PlanCommandError('invalid-transition', 'Invalid Plan step transition.')
    if (startsStep) this.requireStartDependencies(document, plan, input.title)
    const updated: SessionPlanRuntimeContext = {
      ...plan,
      stepStatuses: {
        ...plan.stepStatuses,
        [input.title]: {
          status: input.status,
          updatedAt: this.now(),
          ...(input.notes ? { notes: input.notes } : {})
        }
      }
    }
    const terminal = isPlanTerminalOutcome(document, updated.stepStatuses)
    const next = await this.patch(
      input,
      updated,
      terminal ? 'idle' : 'running',
      terminal ? null : undefined
    )
    return { projection: this.project(document, updated, next.revision, true), changed: true }
  }

  async getProjection(
    projectId: string,
    sessionId: string,
    options: Readonly<{ interactionIsLive?: boolean }> = {}
  ): Promise<ActivePlanProjection | null> {
    await this.recoverLegacyPendingPlan(projectId, sessionId)
    const context = await this.dependencies.readRuntimeContext(projectId, sessionId)
    if (!context.plan) return null
    try {
      const document = await this.readDocument(projectId, sessionId, context.plan)
      return this.project(
        document,
        context.plan,
        context.revision,
        options.interactionIsLive ?? false
      )
    } catch (error) {
      if (!(error instanceof PlanCommandError) || error.code !== 'artifact-unavailable') throw error
      await this.dropUnavailableAuthority(projectId, sessionId, context)
      return null
    }
  }

  async getContinuationRecovery(
    projectId: string,
    sessionId: string
  ): Promise<PlanContinuationRecovery | null> {
    await this.recoverLegacyPendingPlan(projectId, sessionId)
    const context = await this.dependencies.readRuntimeContext(projectId, sessionId)
    const plan = context.plan
    const turn = context.planTurn
    const continuation = turn?.continuation
    if (
      !plan ||
      !turn ||
      !continuation ||
      !['continuation_pending', 'continuation_active'].includes(turn.lifecycle) ||
      !['pending', 'dispatching', 'active'].includes(continuation.state)
    ) {
      return null
    }
    const document = await this.readDocument(projectId, sessionId, plan)
    return { projection: this.project(document, plan, context.revision), turn }
  }

  async recoverLegacyPendingPlan(
    projectId: string,
    sessionId: string
  ): Promise<LegacyPendingPlanRecoveryResult> {
    let context = await this.dependencies.readRuntimeContext(projectId, sessionId)
    const plan = context.plan
    if (!plan || context.planTurn) return { status: 'not-needed' }

    let document: PlanDocumentV1
    try {
      document = await this.readDocument(projectId, sessionId, plan)
    } catch (error) {
      if (!(error instanceof PlanCommandError) || error.code !== 'artifact-unavailable') throw error
      await this.dropUnavailableAuthority(projectId, sessionId, context)
      return {
        status: 'read-only',
        error: { code: 'artifact-unavailable', message: error.message }
      }
    }

    // An old approval fact without a durable continuation is not execution authority. Keeping it
    // active would let authorizeContinuation manufacture a new Attempt after restart.
    if (plan.approval !== 'pending') {
      await this.dropUnavailableAuthority(projectId, sessionId, context)
      return {
        status: 'read-only',
        error: {
          code: 'interaction-mismatch',
          message: 'The legacy Plan has no durable continuation authority.'
        }
      }
    }
    const resolution = await this.dependencies.resolveLegacyPlanTurnAnchor?.(
      projectId,
      sessionId,
      plan.originatingPromptMessageId
    )
    if (!resolution || resolution.status !== 'resolved') {
      return {
        status: 'read-only',
        error: {
          code: 'interaction-mismatch',
          message: `The legacy Plan turn anchor could not be verified${resolution ? ` (${resolution.reason})` : ''}.`
        }
      }
    }
    const migratedPlan: SessionPlanRuntimeContext = {
      ...plan,
      originatingPromptMessageId: resolution.turnAnchor
    }
    const turn: SessionPlanTurnRuntimeContext = {
      turnAnchor: resolution.turnAnchor,
      lifecycle: 'awaiting_plan_approval',
      planArtifactVersionId: plan.artifactVersionId
    }
    try {
      context = await this.dependencies.patchRuntimeContext({
        projectId,
        sessionId,
        expectedRevision: context.revision,
        plan: migratedPlan,
        planTurn: turn,
        sessionStatus: 'waiting-plan-approval'
      })
    } catch (error) {
      if (!this.dependencies.isRevisionConflict(error)) throw error
      const latest = await this.dependencies.readRuntimeContext(projectId, sessionId)
      if (
        latest.planTurn?.lifecycle === 'awaiting_plan_approval' &&
        latest.planTurn.planArtifactVersionId === plan.artifactVersionId &&
        latest.planTurn.turnAnchor === resolution.turnAnchor
      ) {
        return {
          status: 'recovered',
          projection: this.project(document, latest.plan!, latest.revision),
          turn: latest.planTurn
        }
      }
      return {
        status: 'read-only',
        error: { code: 'interaction-mismatch', message: 'The legacy Plan changed during recovery.' }
      }
    }
    return {
      status: 'recovered',
      projection: this.project(document, migratedPlan, context.revision),
      turn
    }
  }

  async authorizeContinuation(input: PlanIdentityCommand): Promise<ActivePlanProjection> {
    const { context, plan, document } = await this.loadActive(input)
    if (plan.approval !== 'approved') {
      throw new PlanCommandError('plan-not-approved', 'The Plan must be approved before execution.')
    }
    if (isPlanTerminalOutcome(document, plan.stepStatuses)) {
      throw new PlanCommandError(
        'invalid-transition',
        'The Plan has already reached a terminal outcome.'
      )
    }
    return this.project(document, plan, context.revision, true)
  }

  async claimContinuation(
    input: PlanIdentityCommand &
      Readonly<{
        turnAnchor: string
        continuationId: string
        attemptId: string
      }>
  ): Promise<{ revision: number; turn: SessionPlanTurnRuntimeContext }> {
    const { context, plan } = await this.loadActive(input)
    const turn = context.planTurn
    const continuation = turn?.continuation
    if (
      !this.continuationApprovalMatches(plan, continuation?.purpose) ||
      !turn ||
      turn.lifecycle !== 'continuation_pending' ||
      turn.turnAnchor !== input.turnAnchor ||
      turn.planArtifactVersionId !== input.artifactVersionId ||
      !continuation ||
      continuation.continuationId !== input.continuationId ||
      continuation.state !== 'pending'
    ) {
      throw new PlanCommandError('continuation-required', 'No matching continuation is pending.')
    }
    const claimed: SessionPlanTurnRuntimeContext = {
      ...turn,
      continuation: {
        ...continuation,
        state: 'dispatching',
        attemptId: input.attemptId,
        lastTransitionAt: this.now()
      }
    }
    const next = await this.patch(input, plan, 'running', claimed)
    return { revision: next.revision, turn: claimed }
  }

  async recordContinuationActive(
    input: PlanIdentityCommand &
      Readonly<{
        turnAnchor: string
        continuationId: string
        attemptId: string
      }>
  ): Promise<{ revision: number; turn: SessionPlanTurnRuntimeContext }> {
    const { context, plan } = await this.loadActive(input)
    const turn = context.planTurn
    const continuation = turn?.continuation
    if (
      !this.continuationApprovalMatches(plan, continuation?.purpose) ||
      !turn ||
      turn.lifecycle !== 'continuation_pending' ||
      turn.turnAnchor !== input.turnAnchor ||
      turn.planArtifactVersionId !== input.artifactVersionId ||
      !continuation ||
      continuation.continuationId !== input.continuationId ||
      continuation.state !== 'dispatching' ||
      continuation.attemptId !== input.attemptId
    ) {
      throw new PlanCommandError('continuation-required', 'The continuation claim is not current.')
    }
    const active: SessionPlanTurnRuntimeContext = {
      ...turn,
      lifecycle: 'continuation_active',
      continuation: {
        ...continuation,
        state: 'active',
        lastTransitionAt: this.now()
      }
    }
    const next = await this.patch(input, plan, 'running', active)
    return { revision: next.revision, turn: active }
  }

  async recordContinuationFailed(
    input: PlanIdentityCommand &
      Readonly<{
        turnAnchor: string
        continuationId: string
        attemptId: string
        failure: 'dispatch_failed' | 'execution_failed'
      }>
  ): Promise<{ revision: number; turn: SessionPlanTurnRuntimeContext }> {
    const { context, plan } = await this.loadActive(input)
    const turn = context.planTurn
    const continuation = turn?.continuation
    if (
      !turn ||
      !['continuation_pending', 'continuation_active'].includes(turn.lifecycle) ||
      turn.turnAnchor !== input.turnAnchor ||
      turn.planArtifactVersionId !== input.artifactVersionId ||
      !continuation ||
      !['dispatching', 'active'].includes(continuation.state) ||
      continuation.continuationId !== input.continuationId ||
      continuation.attemptId !== input.attemptId
    ) {
      throw new PlanCommandError('continuation-required', 'The failed Attempt is not current.')
    }
    if (continuation.purpose === 'revise_pending_plan') {
      if (plan.approval !== 'pending') {
        throw new PlanCommandError('continuation-required', 'The revise Plan is no longer pending.')
      }
      const restored: SessionPlanTurnRuntimeContext = {
        turnAnchor: turn.turnAnchor,
        lifecycle: 'awaiting_plan_approval',
        planArtifactVersionId: plan.artifactVersionId,
        continuationHistory: [
          ...(turn.continuationHistory ?? []),
          {
            ...continuation,
            state: 'interrupted',
            failure: input.failure,
            lastTransitionAt: this.now()
          }
        ]
      }
      const next = await this.patch(input, plan, 'waiting-plan-approval', restored)
      return { revision: next.revision, turn: restored }
    }
    if (plan.approval !== 'approved') {
      throw new PlanCommandError('continuation-required', 'The execute Plan is no longer approved.')
    }
    const interrupted: SessionPlanTurnRuntimeContext = {
      ...turn,
      lifecycle: 'continuation_interrupted',
      continuation: {
        ...continuation,
        state: 'interrupted',
        failure: input.failure,
        lastTransitionAt: this.now()
      }
    }
    const next = await this.patch(input, plan, 'error', interrupted)
    return { revision: next.revision, turn: interrupted }
  }

  private async retryContinuation(
    input: PlanIdentityCommand & Readonly<{ turnAnchor: string; commandId: string; retry: true }>
  ): Promise<PlanRetryResult> {
    const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const plan = context.plan
    if (!plan) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
    if (plan.artifactVersionId !== input.artifactVersionId) {
      throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
    }
    const turn = context.planTurn
    const current = turn?.continuation
    if (
      turn?.lifecycle === 'continuation_pending' &&
      current?.purpose === 'execute_approved_plan' &&
      current.commandId === input.commandId
    ) {
      const document = await this.readDocument(input.projectId, input.sessionId, plan)
      return {
        kind: 'continuation_requested',
        projection: this.project(document, plan, context.revision),
        turn,
        changed: false
      }
    }
    if (context.revision !== input.expectedRevision) {
      throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
    }
    if (
      plan.approval !== 'approved' ||
      !turn ||
      turn.lifecycle !== 'continuation_interrupted' ||
      turn.turnAnchor !== input.turnAnchor ||
      turn.planArtifactVersionId !== plan.artifactVersionId ||
      current?.purpose !== 'execute_approved_plan' ||
      current.state !== 'interrupted'
    ) {
      throw new PlanCommandError('continuation-required', 'No interrupted continuation can retry.')
    }
    const now = this.now()
    const pending: SessionPlanTurnRuntimeContext = {
      ...turn,
      lifecycle: 'continuation_pending',
      continuationHistory: [...(turn.continuationHistory ?? []), current],
      continuation: {
        continuationId: `continuation-retry-${this.createId()}`,
        purpose: 'execute_approved_plan',
        state: 'pending',
        commandId: input.commandId,
        requestedAt: now,
        lastTransitionAt: now
      }
    }
    const next = await this.patch(input, plan, 'running', pending)
    const document = await this.readDocument(input.projectId, input.sessionId, plan)
    return {
      kind: 'continuation_requested',
      projection: this.project(document, plan, next.revision),
      turn: pending,
      changed: true
    }
  }

  private async loadActive(
    input: PlanIdentityCommand,
    idempotentDecision?: 'approved' | 'rejected',
    idempotentStep?: Readonly<{ title: string; status: SessionPlanStepStatus }>
  ): Promise<{
    context: SessionRuntimeContext
    plan: SessionPlanRuntimeContext
    document: PlanDocumentV1
  }> {
    const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const plan = context.plan
    if (!plan) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
    if (plan.artifactVersionId !== input.artifactVersionId) {
      throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
    }
    const repeatsTerminalStep =
      idempotentStep !== undefined &&
      isTerminalStepStatus(idempotentStep.status) &&
      runtimeStatusFor(plan, idempotentStep.title)?.status === idempotentStep.status
    if (
      context.revision !== input.expectedRevision &&
      plan.approval !== idempotentDecision &&
      !repeatsTerminalStep
    ) {
      throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
    }
    return {
      context,
      plan,
      document: await this.readDocument(input.projectId, input.sessionId, plan)
    }
  }

  private async dropUnavailableAuthority(
    projectId: string,
    sessionId: string,
    observed: SessionRuntimeContext
  ): Promise<void> {
    let current = observed
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.dependencies.patchRuntimeContext({
          projectId,
          sessionId,
          expectedRevision: current.revision,
          plan: undefined,
          planTurn: null,
          sessionStatus: 'idle'
        })
        return
      } catch (error) {
        if (!this.dependencies.isRevisionConflict(error)) throw error
        const latest = await this.dependencies.readRuntimeContext(projectId, sessionId)
        if (!latest.plan || !observed.plan) return
        if (
          latest.plan.artifactId !== observed.plan.artifactId ||
          latest.plan.artifactVersionId !== observed.plan.artifactVersionId ||
          latest.plan.artifactChecksum !== observed.plan.artifactChecksum
        ) {
          return
        }
        current = latest
      }
    }
  }

  private async readDocument(
    projectId: string,
    sessionId: string,
    plan: SessionPlanRuntimeContext
  ): Promise<PlanDocumentV1> {
    let result: { content: string; checksum: string }
    try {
      result = await this.dependencies.readArtifactVersion({
        projectId,
        sessionId,
        artifactId: plan.artifactId,
        artifactVersionId: plan.artifactVersionId
      })
    } catch {
      throw new PlanCommandError('artifact-unavailable', 'The active Plan Artifact is unreadable.')
    }
    if (
      result.checksum !== plan.artifactChecksum ||
      sha256(result.content) !== plan.artifactChecksum
    ) {
      throw new PlanCommandError(
        'artifact-unavailable',
        'The active Plan Artifact failed verification.'
      )
    }
    return parseDocument(result.content)
  }

  private async patch(
    input: PlanIdentityCommand,
    plan: SessionPlanRuntimeContext,
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle' | 'error',
    planTurn?: SessionPlanTurnRuntimeContext | null
  ): Promise<SessionRuntimeContext> {
    try {
      return await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        plan,
        ...(planTurn !== undefined ? { planTurn } : {}),
        sessionStatus
      })
    } catch (error) {
      if (this.dependencies.isRevisionConflict(error)) {
        throw new PlanCommandError('revision-conflict', 'The Plan revision changed concurrently.')
      }
      throw error
    }
  }

  private requireExecutionAuthority(
    context: SessionRuntimeContext,
    plan: SessionPlanRuntimeContext,
    input: PlanIdentityCommand & Readonly<{ continuationId?: string; attemptId?: string }>
  ): void {
    const turn = context.planTurn
    const continuation = turn?.continuation
    if (
      !turn ||
      turn.lifecycle !== 'continuation_active' ||
      turn.turnAnchor !== plan.originatingPromptMessageId ||
      (input.turnAnchor !== undefined && input.turnAnchor !== turn.turnAnchor) ||
      turn.planArtifactVersionId !== plan.artifactVersionId ||
      !continuation ||
      continuation.state !== 'active' ||
      !input.continuationId ||
      continuation.continuationId !== input.continuationId ||
      !input.attemptId ||
      continuation.attemptId !== input.attemptId
    ) {
      throw new PlanCommandError(
        'continuation-required',
        'This Attempt does not own the active Plan continuation.'
      )
    }
  }

  private requireAwaitingTurn(
    context: SessionRuntimeContext,
    plan: SessionPlanRuntimeContext,
    expectedTurnAnchor?: string
  ): SessionPlanTurnRuntimeContext {
    const turn = context.planTurn
    if (
      !turn ||
      turn.lifecycle !== 'awaiting_plan_approval' ||
      turn.planArtifactVersionId !== plan.artifactVersionId ||
      turn.turnAnchor !== plan.originatingPromptMessageId ||
      (expectedTurnAnchor !== undefined && turn.turnAnchor !== expectedTurnAnchor)
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The active Plan is not bound to an awaiting Conversation Turn.'
      )
    }
    return turn
  }

  private continuationApprovalMatches(
    plan: SessionPlanRuntimeContext,
    purpose: 'execute_approved_plan' | 'revise_pending_plan' | undefined
  ): boolean {
    return (
      (purpose === 'execute_approved_plan' && plan.approval === 'approved') ||
      (purpose === 'revise_pending_plan' && plan.approval === 'pending')
    )
  }

  private requireActiveReviseAttempt(
    context: SessionRuntimeContext,
    input: Readonly<{
      turnAnchor?: string
      artifactVersionId?: string
      expectedRevision?: number
      continuationId?: string
      attemptId?: string
    }>
  ): SessionPlanTurnRuntimeContext {
    const plan = context.plan
    const turn = context.planTurn
    const continuation = turn?.continuation
    if (
      !plan ||
      plan.approval !== 'pending' ||
      context.revision !== input.expectedRevision ||
      plan.artifactVersionId !== input.artifactVersionId ||
      !turn ||
      turn.lifecycle !== 'continuation_active' ||
      turn.turnAnchor !== input.turnAnchor ||
      turn.planArtifactVersionId !== plan.artifactVersionId ||
      continuation?.purpose !== 'revise_pending_plan' ||
      continuation.state !== 'active' ||
      continuation.continuationId !== input.continuationId ||
      continuation.attemptId !== input.attemptId
    ) {
      throw new PlanCommandError(
        'continuation-required',
        'Only the active revise Attempt may generate a replacement Plan.'
      )
    }
    return turn
  }

  private requireStartDependencies(
    document: PlanDocumentV1,
    plan: SessionPlanRuntimeContext,
    title: string
  ): void {
    const phaseIndex = document.phases.findIndex((phase) =>
      phase.delegations.some((delegation) => delegation.steps.some((step) => step.title === title))
    )
    const phase = document.phases[phaseIndex]
    const delegation = phase.delegations.find((candidate) =>
      candidate.steps.some((step) => step.title === title)
    )!
    const stepIndex = delegation.steps.findIndex((step) => step.title === title)
    const isNormallyFinished = (stepTitle: string): boolean => {
      const status = runtimeStatusFor(plan, stepTitle)?.status
      return status === 'completed' || status === 'skipped'
    }
    const priorStepSatisfied = delegation.steps
      .slice(0, stepIndex)
      .every((step) => isNormallyFinished(step.title))
    const priorPhasesSatisfied = document.phases
      .slice(0, phaseIndex)
      .every((priorPhase) =>
        priorPhase.delegations.every((priorDelegation) =>
          priorDelegation.steps.every((step) => isNormallyFinished(step.title))
        )
      )
    const blockedTitle = Object.entries(plan.stepStatuses).find(
      ([, value]) => value.status === 'blocked'
    )?.[0]
    const delegationStartedBeforeBlock = delegation.steps.some(
      (step) => runtimeStatusFor(plan, step.title) !== undefined
    )
    if (
      !priorStepSatisfied ||
      !priorPhasesSatisfied ||
      (blockedTitle !== undefined && !delegationStartedBeforeBlock)
    ) {
      throw new PlanCommandError(
        'dependency-not-satisfied',
        'The Plan step dependencies are not satisfied.'
      )
    }
  }

  private project(
    document: PlanDocumentV1,
    plan: SessionPlanRuntimeContext,
    revision: number,
    interactionIsLive = false
  ): ActivePlanProjection {
    const titles = planStepTitles(document)
    const lifecycle = derivePlanLifecycle(
      document,
      plan.approval,
      plan.stepStatuses,
      interactionIsLive
    )
    return {
      artifactId: plan.artifactId,
      artifactVersionId: plan.artifactVersionId,
      artifactChecksum: plan.artifactChecksum,
      ...(plan.originatingPromptMessageId
        ? { originatingPromptMessageId: plan.originatingPromptMessageId }
        : {}),
      revision,
      approval: plan.approval,
      lifecycle,
      requiresExplicitContinuation:
        !interactionIsLive &&
        plan.approval === 'approved' &&
        !isPlanTerminalOutcome(document, plan.stepStatuses),
      document,
      stepStatuses: plan.stepStatuses,
      stepStates: projectPlanStepStates(document, plan.stepStatuses),
      counts: {
        phases: document.phases.length,
        delegations: document.phases.reduce((sum, phase) => sum + phase.delegations.length, 0),
        steps: titles.length,
        completed: titles.filter((title) => {
          const status = runtimeStatusFor(plan, title)?.status
          return status === 'completed' || status === 'skipped'
        }).length,
        inProgress: titles.filter(
          (title) => runtimeStatusFor(plan, title)?.status === 'in_progress'
        ).length
      }
    }
  }
}

export { PlanService }
export type { PlanResponseResult, PlanServiceDependencies }
