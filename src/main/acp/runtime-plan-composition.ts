import type { AcpPromptRequest, AcpRuntimeEvent } from '../../shared/acp'
import type {
  ActivePlanProjection,
  GeneratePlanContent,
  PlanResponseCommand
} from '../../shared/session-plan/contract'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type { SessionPlanStepStatus } from '../../shared/session-persistence'
import { createLogger, errorLogFields } from '../logger'
import type { PlanResponseResult } from '../session-plan/plan-service'
import type { AcpRuntimeOptions } from './runtime'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpPromptTurnPlanContext, AcpPromptTurnPlanWorkflow } from './prompt-turn-workflow'
import type { AcpPromptSessionInteractionScope } from './session-interaction-owner'

type AcpSessionPlanCall = Readonly<{
  projectId: string
  sessionId: string
  operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus'
  input?: unknown
}>

const log = createLogger('acp')

const safeLogError = (message: string, error: unknown): void => {
  try {
    log.error(message, errorLogFields(error))
  } catch {
    // Plan projection and the original operation result take precedence over diagnostics.
  }
}

// Composes ACP-facing Session Plan application policy around the authoritative Plan, interaction,
// Artifact, durable-branch, and publication owners. It owns no mutable state of its own.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
const composeAcpRuntimePlanWorkflow = (
  options: AcpRuntimeOptions,
  base: AcpRuntimeBaseOwners,
  session: AcpRuntimeSessionOwners
) => {
  const service = base.planService
  const interactions = base.planInteractions
  const sessionInteractions = base.sessionInteractions
  const planSessions = options.plan?.sessions
  const pushEvent = (
    event: Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>
  ): void => session.publication.pushEvent(event)
  const publishProjection = (sessionId: string, projection: ActivePlanProjection): void => {
    try {
      pushEvent({
        id: `session-plan-${projection.artifactVersionId}-${projection.revision}`,
        timestamp: Date.now(),
        kind: 'plan',
        level: 'info',
        sessionId,
        title: 'Session Plan updated',
        planProjection: projection
      })
    } catch (error) {
      safeLogError('Session Plan projection callback failed', error)
    }
  }
  const assertVisibleToDurableBranch = async (
    projectId: string,
    sessionId: string,
    projection: ActivePlanProjection
  ): Promise<void> => {
    const origin = projection.originatingPromptMessageId
    if (
      !origin ||
      !planSessions ||
      !(await planSessions.containsMessageOnActiveBranch(projectId, sessionId, origin))
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The active Session Plan does not belong to the durable active Message Branch.'
      )
    }
  }
  const bindExecutionToCurrentInteraction = (
    sessionId: string,
    artifactVersionId: string
  ): void => {
    const interaction = sessionInteractions.current(sessionId)
    if (!interaction || interaction.kind !== 'prompt') return
    interactions.bindExecution({
      sessionId,
      interactionSequence: interaction.sequence,
      artifactVersionId
    })
  }
  const rejectApprovalForInteraction = (
    sessionId: string,
    interactionId: string,
    reason: string
  ): void => {
    interactions.releaseApprovalReservation(sessionId, interactionId)
    if (interactions.approvalInteractionIdFor(sessionId) !== interactionId) return
    interactions.rejectApproval(sessionId, reason)
  }
  const call = async (input: AcpSessionPlanCall): Promise<unknown> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    if (input.operation === 'generate') {
      const interactionId = base.artifactTurns?.promptMessageIdFor(input.sessionId)
      if (!interactionId) throw new Error('No active interaction can generate a Session Plan.')
      const interaction = sessionInteractions.current(input.sessionId)
      const binding = interactions.executionBindingFor(input.sessionId)
      const reviseBinding =
        interaction && binding?.interactionSequence === interaction.sequence ? binding : undefined
      let result: Awaited<ReturnType<NonNullable<typeof service>['generate']>>
      try {
        result = await service.generate({
          projectId: input.projectId,
          sessionId: input.sessionId,
          interactionId,
          ...(reviseBinding?.turnAnchor ? { turnAnchor: reviseBinding.turnAnchor } : {}),
          ...(reviseBinding ? { artifactVersionId: reviseBinding.artifactVersionId } : {}),
          ...(reviseBinding?.expectedRevision !== undefined
            ? { expectedRevision: reviseBinding.expectedRevision }
            : {}),
          ...(reviseBinding?.continuationId
            ? { continuationId: reviseBinding.continuationId }
            : {}),
          ...(reviseBinding?.attemptId ? { attemptId: reviseBinding.attemptId } : {}),
          content: input.input as GeneratePlanContent
        })
      } catch (error) {
        const current = await service.getProjection(input.projectId, input.sessionId)
        if (current) publishProjection(input.sessionId, current)
        throw error
      }
      publishProjection(input.sessionId, result.projection)
      return result
    }
    const projection = await service.getProjection(input.projectId, input.sessionId, {
      interactionIsLive: sessionInteractions.current(input.sessionId) !== undefined
    })
    if (!projection) throw new Error('The Session has no active Plan.')
    await assertVisibleToDurableBranch(input.projectId, input.sessionId, projection)
    const identity = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: projection.artifactVersionId,
      expectedRevision: projection.revision
    }
    if (input.operation === 'approve' || input.operation === 'reject') {
      const interaction = sessionInteractions.current(input.sessionId)
      const interactionIsLive = interaction !== undefined
      const decision = input.operation === 'approve' ? 'approved' : 'rejected'
      const executionBinding = interactions.executionBindingFor(input.sessionId)
      if (!interaction || interaction.kind !== 'prompt') {
        throw new PlanCommandError(
          'interaction-mismatch',
          'A live prompt interaction must own the Plan decision command.'
        )
      }
      const turnAnchor = projection.originatingPromptMessageId
      if (!turnAnchor) {
        throw new PlanCommandError(
          'interaction-mismatch',
          'The Plan decision is missing its Conversation Turn identity.'
        )
      }
      const result = await service.respond({
        ...identity,
        turnAnchor,
        commandId: `plan-decision-${interaction.turnToken}-${input.operation}`,
        decision,
        interactionIsLive
      })
      if (decision === 'approved') {
        bindExecutionToCurrentInteraction(input.sessionId, result.projection.artifactVersionId)
      } else if (executionBinding) {
        interactions.releaseExecution(input.sessionId, executionBinding.interactionSequence)
      }
      interactions.resolveApproval(input.sessionId, result)
      publishProjection(input.sessionId, result.projection)
      return result
    }
    const update = input.input as {
      title: string
      status: SessionPlanStepStatus
      notes?: string
      expectedArtifactVersionId?: string
    }
    if (projection.approval !== 'approved') {
      throw new PlanCommandError(
        'plan-not-approved',
        'The Plan is still pending. Interpret the user Message, then call generate_plan with decision:"approved" or decision:"rejected" before updating steps.'
      )
    }
    const interaction = sessionInteractions.current(input.sessionId)
    const binding = interactions.executionBindingFor(input.sessionId)
    if (!binding) {
      throw new PlanCommandError(
        'continuation-required',
        'Continuing this Plan requires an explicit user continuation.'
      )
    }
    if (!interaction || binding.interactionSequence !== interaction.sequence) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'This interaction is not authorized to execute the active Plan.'
      )
    }
    if (
      binding.artifactVersionId !== projection.artifactVersionId ||
      (update.expectedArtifactVersionId !== undefined &&
        update.expectedArtifactVersionId !== binding.artifactVersionId)
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'This interaction is bound to a different Plan Artifact Version.'
      )
    }
    const result = await service.updateStepStatus({
      ...identity,
      artifactVersionId: update.expectedArtifactVersionId ?? identity.artifactVersionId,
      title: update.title,
      status: update.status,
      ...(binding.turnAnchor ? { turnAnchor: binding.turnAnchor } : {}),
      ...(binding.continuationId ? { continuationId: binding.continuationId } : {}),
      ...(binding.attemptId ? { attemptId: binding.attemptId } : {}),
      ...(update.notes ? { notes: update.notes } : {})
    })
    publishProjection(input.sessionId, result.projection)
    return result
  }
  const projection = (projectId: string, sessionId: string): Promise<ActivePlanProjection | null> =>
    service?.getProjection(projectId, sessionId, {
      interactionIsLive: sessionInteractions.current(sessionId) !== undefined
    }) ?? Promise.resolve(null)
  const continuationRecovery = (projectId: string, sessionId: string) =>
    service?.getContinuationRecovery(projectId, sessionId) ?? Promise.resolve(null)
  const respond = async (input: PlanResponseCommand): Promise<PlanResponseResult> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    const recovery = await service.recoverLegacyPendingPlan(input.projectId, input.sessionId)
    const current = await service.getProjection(input.projectId, input.sessionId, {
      interactionIsLive: false
    })
    if (!current) throw new Error('The Session has no active Plan.')
    await assertVisibleToDurableBranch(input.projectId, input.sessionId, current)
    const recoveredIdentityMatches =
      recovery.status === 'recovered' &&
      recovery.projection.artifactVersionId === current.artifactVersionId &&
      recovery.projection.revision === current.revision &&
      recovery.turn.turnAnchor === input.turnAnchor &&
      current.originatingPromptMessageId === input.turnAnchor &&
      input.artifactVersionId === current.artifactVersionId &&
      input.expectedRevision + 1 === current.revision
    const result = await service.respond({
      ...input,
      ...(recoveredIdentityMatches ? { expectedRevision: current.revision } : {}),
      interactionIsLive: false
    })
    if ('projection' in result) {
      publishProjection(input.sessionId, result.projection)
      if (result.kind === 'revision_requested') {
        try {
          pushEvent({
            id: `session-user-message-${result.message.id}`,
            timestamp: result.message.createdAt,
            kind: 'message',
            level: 'info',
            sessionId: input.sessionId,
            promptMessageId: result.message.responseToMessageId,
            messageId: result.message.id,
            role: 'user',
            text: result.message.content
          })
        } catch (error) {
          safeLogError('Routed user Message projection callback failed', error)
        }
      }
      return result
    }
    return result
  }
  const claimContinuation = (
    input: Parameters<NonNullable<typeof service>['claimContinuation']>[0]
  ): ReturnType<NonNullable<typeof service>['claimContinuation']> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    return service.claimContinuation(input)
  }
  const recordContinuationFailed = async (
    input: Omit<
      Parameters<NonNullable<typeof service>['recordContinuationFailed']>[0],
      'expectedRevision'
    >
  ): ReturnType<NonNullable<typeof service>['recordContinuationFailed']> => {
    if (!service) throw new Error('Session Plan capability is not configured.')
    const current = await service.getProjection(input.projectId, input.sessionId, {
      interactionIsLive: false
    })
    if (!current) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
    return service.recordContinuationFailed({ ...input, expectedRevision: current.revision })
  }

  const preflight = (
    request: AcpPromptRequest
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> => {
    const projectId = session.sessionEnvironment.projectName(request.sessionId)
    if (request.planContinuation && request.planContinuation.projectId !== projectId) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The Plan continuation belongs to a different Project.'
      )
    }
    if (request.planContinuation && !service) {
      throw new Error('Session Plan capability is not configured.')
    }
    const continuation = request.planContinuation
    if (continuation?.pendingAction === undefined && continuation) {
      if (continuation.turnAnchor && continuation.continuationId && continuation.attemptId) {
        return service!
          .getProjection(continuation.projectId, request.sessionId, {
            interactionIsLive: false
          })
          .then(async (authorized) => {
            const purpose = continuation.purpose ?? 'execute_approved_plan'
            if (
              !authorized ||
              (purpose === 'execute_approved_plan' && authorized.approval !== 'approved') ||
              (purpose === 'revise_pending_plan' && authorized.approval !== 'pending')
            ) {
              throw new PlanCommandError(
                'continuation-required',
                'The durable Plan continuation is not approved.'
              )
            }
            await assertVisibleToDurableBranch(
              continuation.projectId,
              request.sessionId,
              authorized
            )
            return Object.freeze({ authorized })
          })
      }
      throw new PlanCommandError(
        'continuation-required',
        'A durable continuation claim is required before Plan execution.'
      )
    }
    if (!continuation) return Object.freeze({})
    return service!
      .getProjection(continuation.projectId, request.sessionId, {
        interactionIsLive: false
      })
      .then(async (protectedPending) => {
        if (!protectedPending) {
          throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
        }
        if (protectedPending.artifactVersionId !== continuation.artifactVersionId) {
          throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
        }
        if (protectedPending.revision !== continuation.expectedRevision) {
          throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
        }
        if (protectedPending.approval !== 'pending') {
          throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
        }
        await assertVisibleToDurableBranch(
          continuation.projectId,
          request.sessionId,
          protectedPending
        )
        return Object.freeze({ protectedPending })
      })
  }
  const admit = (
    request: AcpPromptRequest,
    interaction: AcpPromptSessionInteractionScope,
    plan: AcpPromptTurnPlanContext
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> => {
    let { authorized, protectedPending } = plan
    const continuation = request.planContinuation
    const decision = continuation?.pendingAction
    const committed = (): AcpPromptTurnPlanContext => {
      if (authorized) {
        interactions.bindExecution({
          sessionId: request.sessionId,
          interactionSequence: interaction.sequence,
          artifactVersionId: authorized.artifactVersionId,
          expectedRevision: authorized.revision,
          ...(continuation?.turnAnchor ? { turnAnchor: continuation.turnAnchor } : {}),
          ...(continuation?.continuationId ? { continuationId: continuation.continuationId } : {}),
          ...(continuation?.attemptId ? { attemptId: continuation.attemptId } : {})
        })
      }
      return Object.freeze({
        ...(authorized ? { authorized } : {}),
        ...(protectedPending ? { protectedPending } : {})
      })
    }
    if (
      continuation?.pendingAction === undefined &&
      continuation?.turnAnchor &&
      continuation.continuationId &&
      continuation.attemptId
    ) {
      return service!
        .recordContinuationActive({
          projectId: continuation.projectId,
          sessionId: request.sessionId,
          turnAnchor: continuation.turnAnchor,
          artifactVersionId: continuation.artifactVersionId,
          expectedRevision: continuation.expectedRevision,
          continuationId: continuation.continuationId,
          attemptId: continuation.attemptId
        })
        .then(({ revision }) => {
          authorized = { ...authorized!, revision }
          return committed()
        })
    }
    if (continuation && (decision === 'approve' || decision === 'reject')) {
      const executionBinding = interactions.executionBindingFor(request.sessionId)
      if (!continuation.turnAnchor) {
        throw new PlanCommandError(
          'interaction-mismatch',
          'The Plan decision is missing its Conversation Turn identity.'
        )
      }
      return service!
        .respond({
          projectId: continuation.projectId,
          sessionId: request.sessionId,
          turnAnchor: continuation.turnAnchor,
          artifactVersionId: continuation.artifactVersionId,
          expectedRevision: continuation.expectedRevision,
          commandId: `plan-decision-${interaction.turnToken}-${decision}`,
          decision: decision === 'approve' ? 'approved' : 'rejected',
          interactionIsLive: true
        })
        .then((result) => {
          if (decision === 'approve') authorized = result.projection
          else {
            protectedPending = result.projection
            if (executionBinding) {
              interactions.releaseExecution(request.sessionId, executionBinding.interactionSequence)
            }
          }
          interactions.resolveApproval(request.sessionId, result)
          publishProjection(request.sessionId, result.projection)
          return committed()
        })
    }
    return committed()
  }
  const beforeRelease = (
    sessionId: string,
    interaction: AcpPromptSessionInteractionScope
  ): void => {
    interactions.releaseExecution(sessionId, interaction.sequence)
    if (interaction.promptMessageId) {
      rejectApprovalForInteraction(
        sessionId,
        interaction.promptMessageId,
        'The Session Plan interaction ended before approval.'
      )
    }
  }
  const afterRelease = async (sessionId: string): Promise<void> => {
    if (!service) return
    try {
      const projectId = session.sessionEnvironment.projectName(sessionId)
      const recovery = await service.getContinuationRecovery(projectId, sessionId)
      const continuation = recovery?.turn.continuation
      if (
        recovery &&
        continuation?.attemptId &&
        (continuation.state === 'dispatching' || continuation.state === 'active')
      ) {
        await service.recordContinuationFailed({
          projectId,
          sessionId,
          turnAnchor: recovery.turn.turnAnchor,
          artifactVersionId: recovery.projection.artifactVersionId,
          expectedRevision: recovery.projection.revision,
          continuationId: continuation.continuationId,
          attemptId: continuation.attemptId,
          failure: continuation.state === 'dispatching' ? 'dispatch_failed' : 'execution_failed'
        })
      }
      const current = await service.getProjection(projectId, sessionId, {
        interactionIsLive: false
      })
      if (current) publishProjection(sessionId, current)
    } catch (error) {
      safeLogError('Session Plan terminal projection failed', error)
    }
  }
  const prompt: AcpPromptTurnPlanWorkflow = Object.freeze({
    preflight,
    admit,
    beforeRelease,
    afterRelease
  })
  const capturePromptCancellation = (sessionId: string): (() => void) => {
    const interaction = sessionInteractions.current(sessionId)
    const interactionId =
      (interaction?.kind === 'prompt' ? interaction.promptMessageId : undefined) ??
      interactions.approvalInteractionIdFor(sessionId)
    return () => {
      if (interactionId) {
        rejectApprovalForInteraction(
          sessionId,
          interactionId,
          'The Session Plan interaction was cancelled.'
        )
      }
    }
  }
  const sessionDeleted = (sessionId: string): void => {
    interactions.clearSession(sessionId, 'The Session Plan interaction was deleted.')
  }

  return Object.freeze({
    call,
    projection,
    continuationRecovery,
    respond,
    claimContinuation,
    recordContinuationFailed,
    prompt,
    capturePromptCancellation,
    sessionDeleted
  })
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */

type AcpRuntimePlanWorkflow = ReturnType<typeof composeAcpRuntimePlanWorkflow>

export { composeAcpRuntimePlanWorkflow }
export type { AcpRuntimePlanWorkflow, AcpSessionPlanCall }
