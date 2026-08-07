import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type {
  SessionPlanTurnRuntimeContext,
  SessionRuntimeContext
} from '../../shared/session-persistence'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { PlanService, type PlanServiceDependencies } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

const content = {
  task_summary: 'Analyze one dataset',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Primary agent',
          steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
        }
      ]
    }
  ],
  desired_outputs: ['Analysis result'],
  feasibility: { confidence: 'high' as const, rationale: 'Inputs are available.' }
}

const executionContent = {
  ...content,
  phases: [
    {
      name: 'Parallel analysis',
      delegations: [
        {
          name: 'Cohort comparison',
          steps: [
            { title: 'Validate cohorts', description: 'Confirm cohort boundaries.' },
            { title: 'Compare cohorts', description: 'Calculate cohort differences.' }
          ]
        },
        {
          name: 'Evidence review',
          steps: [
            { title: 'Find evidence', description: 'Find supporting evidence.' },
            { title: 'Review evidence', description: 'Review supporting evidence.' }
          ]
        },
        {
          name: 'Quality review',
          steps: [{ title: 'Audit findings', description: 'Audit the analysis findings.' }]
        }
      ]
    },
    {
      name: 'Synthesis',
      delegations: [
        {
          name: 'Report',
          steps: [{ title: 'Draft report', description: 'Produce the final report.' }]
        }
      ]
    }
  ]
}

type PlanServiceHarness = Readonly<{
  service: PlanService
  interactions: SessionPlanInteractionOwner
  dependencies: PlanServiceDependencies
  context: () => SessionRuntimeContext
  status: () => string
  setContext: (next: SessionRuntimeContext) => void
}>

const setup = (): PlanServiceHarness => {
  let context: SessionRuntimeContext = { version: 2, revision: 0 }
  let persistedStatus = 'running'
  let bytes = ''
  let artifactSequence = 0
  const interactions = new SessionPlanInteractionOwner()
  const feedbackMessages = new Map<
    string,
    Awaited<ReturnType<PlanServiceDependencies['commitFeedback']>>['message']
  >()
  const dependencies: PlanServiceDependencies = {
    writeArtifactForActiveTurn: vi.fn(async (_sessionId, input) => {
      bytes = input.content
      artifactSequence += 1
      return {
        artifactId: `artifact-${artifactSequence}`,
        versionId: `version-${artifactSequence}`,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        name: input.filename
      }
    }),
    readArtifactVersion: vi.fn(async () => ({
      content: bytes,
      checksum: createHash('sha256').update(bytes).digest('hex')
    })),
    readRuntimeContext: vi.fn(async () => context),
    patchRuntimeContext: vi.fn(async (request) => {
      const { expectedRevision, plan, planTurn, sessionStatus } = request
      if (expectedRevision !== context.revision) throw new Error('revision conflict')
      context = {
        ...context,
        version: 2,
        revision: context.revision + 1,
        ...(plan ? { plan } : {}),
        ...(planTurn ? { planTurn } : {})
      }
      if (Object.hasOwn(request, 'planTurn') && !planTurn) {
        const mutable = context as { planTurn?: SessionPlanTurnRuntimeContext }
        delete mutable.planTurn
      }
      if (!plan) {
        const mutable = context as { plan?: SessionRuntimeContext['plan'] }
        delete mutable.plan
      }
      persistedStatus = sessionStatus
      return context
    }),
    isRevisionConflict: (error) => error instanceof Error && error.message === 'revision conflict',
    commitFeedback: vi.fn(async (command) => {
      const existing = feedbackMessages.get(command.commandId)
      if (existing) return { context, message: existing, changed: false }
      const message = {
        id: command.messageId,
        role: 'user' as const,
        content: command.content,
        status: 'complete' as const,
        eventIds: [],
        responseToMessageId: command.turnAnchor,
        createdAt: 42,
        updatedAt: 42
      }
      feedbackMessages.set(command.commandId, message)
      context = {
        ...context,
        version: 2,
        revision: context.revision + 1,
        plan: command.plan,
        planTurn: command.planTurn
      }
      return { context, message, changed: true }
    }),
    now: () => 42,
    createId: () => 'a91f30c2'
  }
  return {
    service: new PlanService(dependencies),
    interactions,
    dependencies,
    context: () => context,
    status: () => persistedStatus,
    setContext: (next) => {
      context = next
    }
  }
}

type ExecutionPlanFixture = Readonly<{
  service: PlanService
  identity: Readonly<{
    projectId: string
    sessionId: string
    artifactVersionId: string
    turnAnchor: string
    commandId: string
  }>
  generated: Awaited<ReturnType<PlanService['generate']>>
}>

type ExecutionAuthority = Readonly<{
  turnAnchor: string
  continuationId: string
  attemptId: string
}>

const activateApprovedContinuation = async (
  service: PlanService,
  identity: Pick<ExecutionPlanFixture['identity'], 'projectId' | 'sessionId' | 'artifactVersionId'>,
  approved: { projection: ActivePlanProjection; turn?: SessionPlanTurnRuntimeContext },
  attemptId = 'attempt-execute-1'
): Promise<{ revision: number; authority: ExecutionAuthority }> => {
  const continuation = approved.turn?.continuation
  if (!continuation) throw new Error('missing approved continuation')
  const turnAnchor = approved.turn!.turnAnchor
  const authority = { turnAnchor, continuationId: continuation.continuationId, attemptId }
  const claimed = await service.claimContinuation({
    ...identity,
    ...authority,
    expectedRevision: approved.projection.revision
  })
  const active = await service.recordContinuationActive({
    ...identity,
    ...authority,
    expectedRevision: claimed.revision
  })
  return { revision: active.revision, authority }
}

const generateExecutionPlan = async (): Promise<ExecutionPlanFixture> => {
  const { service } = setup()
  const generated = await service.generate({
    projectId: 'project-1',
    sessionId: 'session-1',
    interactionId: 'interaction-1',
    content: executionContent
  })
  return {
    service,
    generated,
    identity: {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      turnAnchor: 'interaction-1',
      commandId: 'approve-execution-plan'
    }
  }
}

const approveExecutionPlan = async (): Promise<
  ExecutionPlanFixture &
    Readonly<{
      identity: ExecutionPlanFixture['identity'] & ExecutionAuthority
      approved: { projection: ActivePlanProjection; changed: boolean }
    }>
> => {
  const fixture = await generateExecutionPlan()
  const approved = await fixture.service.respond({
    ...fixture.identity,
    expectedRevision: fixture.generated.projection.revision,
    decision: 'approved'
  })
  const active = await activateApprovedContinuation(fixture.service, fixture.identity, approved)
  return {
    ...fixture,
    identity: { ...fixture.identity, ...active.authority },
    approved: { ...approved, projection: { ...approved.projection, revision: active.revision } }
  }
}

describe('PlanService', () => {
  it('suspends the originating Conversation Turn when GeneratePlan returns', async () => {
    const { service, context, status } = setup()

    const result = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'message-1',
      attemptId: 'attempt-generate-1',
      content
    })

    expect(result).toMatchObject({
      kind: 'plan_suspended',
      projection: { approval: 'pending', originatingPromptMessageId: 'message-1' },
      turn: {
        turnAnchor: 'message-1',
        lifecycle: 'awaiting_plan_approval',
        planArtifactVersionId: 'version-1'
      }
    })
    expect(context().planTurn).toEqual<SessionPlanTurnRuntimeContext>({
      turnAnchor: 'message-1',
      lifecycle: 'awaiting_plan_approval',
      planArtifactVersionId: 'version-1'
    })
    expect(status()).toBe('waiting-plan-approval')
  })

  it('atomically records approval and requests execution for the same Conversation Turn', async () => {
    const { service, context, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'message-1',
      attemptId: 'attempt-generate-1',
      content
    })

    const result = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'message-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-1',
      decision: 'approved'
    })

    expect(result).toMatchObject({
      kind: 'continuation_requested',
      projection: { approval: 'approved' },
      turn: {
        turnAnchor: 'message-1',
        lifecycle: 'continuation_pending',
        continuation: { purpose: 'execute_approved_plan', state: 'pending' }
      }
    })
    expect(context()).toMatchObject({
      plan: { approval: 'approved' },
      planTurn: {
        lifecycle: 'continuation_pending',
        continuation: { purpose: 'execute_approved_plan', state: 'pending' }
      }
    })
    expect(status()).toBe('running')
  })

  it.each(['turnAnchor', 'commandId'] as const)(
    'rejects an approval command without %s identity at the service boundary',
    async (missingField) => {
      const { service, context } = setup()
      const generated = await service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'message-1',
        content
      })
      const command = {
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'message-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: generated.projection.revision,
        commandId: 'approve-1',
        decision: 'approved' as const
      }
      delete command[missingField]

      await expect(service.respond(command)).rejects.toMatchObject({
        code: 'interaction-mismatch'
      })
      expect(context()).toMatchObject({
        revision: generated.projection.revision,
        plan: { approval: 'pending' },
        planTurn: { lifecycle: 'awaiting_plan_approval' }
      })
    }
  )

  it('claims a fresh Attempt and permits steps only while that continuation owns authority', async () => {
    const { service, context, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'message-1',
      attemptId: 'attempt-generate-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'message-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-1',
      decision: 'approved'
    })
    if (!approved.turn?.continuation) throw new Error('missing continuation')

    await expect(
      service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: approved.projection.revision,
        title: 'Analyze the data',
        status: 'in_progress',
        turnAnchor: 'message-1',
        continuationId: approved.turn.continuation.continuationId,
        attemptId: 'attempt-execute-1'
      })
    ).rejects.toMatchObject({ code: 'continuation-required' })

    const claimed = await service.claimContinuation({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'message-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: approved.projection.revision,
      continuationId: approved.turn.continuation.continuationId,
      attemptId: 'attempt-execute-1'
    })
    expect(claimed.turn.continuation).toMatchObject({
      state: 'dispatching',
      attemptId: 'attempt-execute-1'
    })
    const active = await service.recordContinuationActive({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'message-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: claimed.revision,
      continuationId: approved.turn.continuation.continuationId,
      attemptId: 'attempt-execute-1'
    })
    expect(active.turn.lifecycle).toBe('continuation_active')

    const running = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress',
      turnAnchor: 'message-1',
      continuationId: approved.turn.continuation.continuationId,
      attemptId: 'attempt-execute-1'
    })
    const completed = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'completed',
      turnAnchor: 'message-1',
      continuationId: approved.turn.continuation.continuationId,
      attemptId: 'attempt-execute-1'
    })

    expect(completed.projection.lifecycle).toBe('completed')
    expect(context().planTurn).toBeUndefined()
    expect(status()).toBe('idle')
  })

  it('keeps approval durable across dispatch failure and retries with one new auditable continuation', async () => {
    const { service, context, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'message-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'message-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-command-1',
      decision: 'approved'
    })
    const first = approved.turn!.continuation!
    const claimed = await service.claimContinuation({
      ...identity,
      expectedRevision: approved.projection.revision,
      continuationId: first.continuationId,
      attemptId: 'attempt-1'
    })
    const interrupted = await service.recordContinuationFailed({
      ...identity,
      expectedRevision: claimed.revision,
      continuationId: first.continuationId,
      attemptId: 'attempt-1',
      failure: 'dispatch_failed'
    })

    expect(context()).toMatchObject({
      plan: { approval: 'approved' },
      planTurn: {
        lifecycle: 'continuation_interrupted',
        continuation: { state: 'interrupted', attemptId: 'attempt-1' }
      }
    })
    expect(status()).toBe('error')

    const retried = await service.respond({
      ...identity,
      expectedRevision: interrupted.revision,
      commandId: 'retry-command-1',
      retry: true
    })
    expect(retried).toMatchObject({
      changed: true,
      turn: {
        lifecycle: 'continuation_pending',
        continuationHistory: [{ continuationId: first.continuationId, state: 'interrupted' }],
        continuation: { state: 'pending', commandId: 'retry-command-1' }
      }
    })
    expect(retried.turn.continuation!.continuationId).not.toBe(first.continuationId)
    await expect(
      service.respond({
        ...identity,
        expectedRevision: interrupted.revision,
        commandId: 'retry-command-1',
        retry: true
      })
    ).resolves.toMatchObject({ changed: false, turn: { continuation: { state: 'pending' } } })

    await expect(
      service.recordContinuationFailed({
        ...identity,
        expectedRevision: retried.projection.revision,
        continuationId: first.continuationId,
        attemptId: 'attempt-1',
        failure: 'execution_failed'
      })
    ).rejects.toMatchObject({ code: 'continuation-required' })
    const retryContinuation = retried.turn.continuation!
    await service.claimContinuation({
      ...identity,
      expectedRevision: retried.projection.revision,
      continuationId: retryContinuation.continuationId,
      attemptId: 'attempt-2'
    })
    await expect(
      service.claimContinuation({
        ...identity,
        expectedRevision: retried.projection.revision,
        continuationId: retryContinuation.continuationId,
        attemptId: 'attempt-overlap'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('projects durable pending and dispatching continuations for restart reconciliation', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'message-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'message-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-before-restart',
      decision: 'approved'
    })

    await expect(service.getContinuationRecovery('project-1', 'session-1')).resolves.toMatchObject({
      projection: { approval: 'approved', revision: approved.projection.revision },
      turn: { lifecycle: 'continuation_pending', continuation: { state: 'pending' } }
    })

    const continuationId = approved.turn!.continuation!.continuationId
    await service.claimContinuation({
      ...identity,
      expectedRevision: approved.projection.revision,
      continuationId,
      attemptId: 'attempt-before-restart'
    })
    await expect(service.getContinuationRecovery('project-1', 'session-1')).resolves.toMatchObject({
      turn: {
        lifecycle: 'continuation_pending',
        continuation: { state: 'dispatching', attemptId: 'attempt-before-restart' }
      }
    })
  })

  it('durably verifies a generated Plan before atomically activating it for the Session', async () => {
    const { service, dependencies, context, status } = setup()

    const result = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })

    expect(dependencies.writeArtifactForActiveTurn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        filename: 'plan-a91f30c2.json',
        mimeType: 'application/json',
        kind: 'plan'
      })
    )
    expect(dependencies.readArtifactVersion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1'
    })
    expect(context().plan).toMatchObject({
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1',
      originatingPromptMessageId: 'interaction-1',
      approval: 'pending',
      stepStatuses: {}
    })
    expect(status()).toBe('waiting-plan-approval')
    expect(result.projection.lifecycle).toBe('awaiting_approval')
    expect(result.projection.originatingPromptMessageId).toBe('interaction-1')
    expect(result.pauseInteraction).toBe(true)
  })

  it('uses one irreversible idempotent transition for approval and completes the exact step', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      turnAnchor: 'interaction-1',
      commandId: 'approve-irreversible'
    }

    const approved = await service.respond({ ...identity, decision: 'approved' })
    expect(approved.changed).toBe(true)
    const active = await activateApprovedContinuation(service, identity, approved)
    const duplicate = await service.respond({
      ...identity,
      expectedRevision: active.revision,
      decision: 'approved'
    })
    expect(duplicate.changed).toBe(false)

    const running = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })
    expect(running.projection.lifecycle).toBe('in_progress')
    const completed = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'completed'
    })
    expect(completed.projection.lifecycle).toBe('completed')
    expect(context().plan?.stepStatuses['Analyze the data']).toMatchObject({
      status: 'completed',
      updatedAt: 42
    })
    await expect(
      service.respond({
        ...identity,
        expectedRevision: completed.projection.revision,
        decision: 'rejected'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })
  })

  it.each(['approved', 'rejected'] as const)(
    'releases the live interaction after a %s decision',
    async (decision) => {
      const { service, interactions } = setup()
      const generated = await service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        content
      })

      await service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'interaction-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: generated.projection.revision,
        commandId: `decision-${decision}`,
        decision
      })

      expect(
        interactions.interactionIdFor('session-1', generated.projection.artifactVersionId)
      ).toBeUndefined()
    }
  )

  it('counts a deliberately skipped step as done in completed Plan progress', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-skipped-step',
      decision: 'approved'
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const active = await activateApprovedContinuation(service, identity, approved)
    const skipped = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'skipped',
      notes: 'The input already contains the result.'
    })

    expect(skipped.projection).toMatchObject({
      lifecycle: 'completed',
      counts: { completed: 1, steps: 1 }
    })
  })

  it('treats special JavaScript property names as opaque Plan step titles', async () => {
    const { service, context } = setup()
    const specialContent = {
      ...content,
      phases: [
        {
          name: 'Special names',
          delegations: [
            {
              name: 'Primary agent',
              steps: ['toString', 'constructor', '__proto__'].map((title) => ({
                title,
                description: `Complete ${title}.`
              }))
            }
          ]
        }
      ]
    }
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content: specialContent
    })
    expect(generated.projection.stepStates).toEqual(
      Object.fromEntries(
        ['toString', 'constructor', '__proto__'].map((title) => [title, { status: 'not_started' }])
      )
    )
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-prototype-titles',
      decision: 'approved'
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const active = await activateApprovedContinuation(service, identity, approved)
    let revision = active.revision
    for (const title of ['toString', 'constructor', '__proto__']) {
      const running = await service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        ...active.authority,
        expectedRevision: revision,
        title,
        status: 'in_progress'
      })
      const completed = await service.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        ...active.authority,
        expectedRevision: running.projection.revision,
        title,
        status: 'completed'
      })
      revision = completed.projection.revision
    }

    const statuses = context().plan?.stepStatuses
    expect(statuses?.toString).toMatchObject({ status: 'completed' })
    expect(statuses?.constructor).toMatchObject({ status: 'completed' })
    expect(Object.hasOwn(statuses!, '__proto__')).toBe(true)
    expect(statuses?.__proto__).toMatchObject({ status: 'completed' })
  })

  it('accepts duplicate terminal delivery with the original revision without rewriting the record', async () => {
    const { service, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-dependency-order',
      decision: 'approved'
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      turnAnchor: 'interaction-1',
      commandId: 'approve-terminal-step'
    }
    const active = await activateApprovedContinuation(service, identity, approved)
    const running = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })
    const terminalCommand = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'completed' as const,
      ...active.authority
    }
    const completed = await service.updateStepStatus(terminalCommand)
    const revisionAfterCompletion = context().revision

    await expect(service.updateStepStatus(terminalCommand)).resolves.toMatchObject({
      changed: false,
      projection: { revision: completed.projection.revision, lifecycle: 'completed' }
    })
    expect(context().revision).toBe(revisionAfterCompletion)
  })

  it('retries in-progress work and rejects every transition away from a terminal status', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      turnAnchor: 'interaction-1',
      commandId: 'approve-retry-terminal',
      decision: 'approved'
    })
    const active = await activateApprovedContinuation(service, identity, approved)
    const running = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress',
      notes: 'First attempt.'
    })
    const retried = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: running.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress',
      notes: 'Retry after interruption.'
    })
    expect(retried.projection.stepStatuses['Analyze the data']).toMatchObject({
      status: 'in_progress',
      notes: 'Retry after interruption.'
    })
    const completed = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: retried.projection.revision,
      title: 'Analyze the data',
      status: 'completed'
    })

    for (const status of ['in_progress', 'blocked', 'skipped'] as const) {
      await expect(
        service.updateStepStatus({
          ...identity,
          ...active.authority,
          expectedRevision: completed.projection.revision,
          title: 'Analyze the data',
          status
        })
      ).rejects.toMatchObject({ code: 'invalid-transition' })
    }
  })

  it('rejects irreversibly, releases the Session block, and treats duplicate delivery as idempotent', async () => {
    const { service, context, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      turnAnchor: 'interaction-1',
      commandId: 'reject-irreversible'
    }

    const rejected = await service.respond({ ...identity, decision: 'rejected' })
    expect(rejected).toMatchObject({ changed: true, projection: { lifecycle: 'rejected' } })
    expect(status()).toBe('idle')
    expect(context().plan?.approval).toBe('rejected')

    const duplicate = await service.respond({ ...identity, decision: 'rejected' })
    expect(duplicate.changed).toBe(false)
    await expect(
      service.respond({
        ...identity,
        expectedRevision: rejected.projection.revision,
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'approval-already-decided' })
  })

  it('ends a rejected durable Turn even when the obsolete generating interaction is still live', async () => {
    const { service, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })

    await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'reject-obsolete-interaction',
      decision: 'rejected',
      interactionIsLive: true
    })

    expect(status()).toBe('idle')
  })

  it('atomically persists idempotent feedback and a revise intent without granting approval', async () => {
    const { service, dependencies, context } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const response = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'feedback-1',
      feedback: 'Split the analysis by cohort.'
    })

    expect(response).toMatchObject({
      kind: 'revision_requested',
      changed: true,
      projection: { approval: 'pending' },
      turn: {
        turnAnchor: 'interaction-1',
        lifecycle: 'continuation_pending',
        continuation: { purpose: 'revise_pending_plan', state: 'pending' }
      },
      text: 'Split the analysis by cohort.',
      message: {
        role: 'user',
        content: 'Split the analysis by cohort.',
        responseToMessageId: 'interaction-1'
      }
    })
    expect(context()).toMatchObject({
      plan: { approval: 'pending' },
      planTurn: { continuation: { purpose: 'revise_pending_plan' } }
    })
    const repeated = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'feedback-1',
      feedback: 'Split the analysis by cohort.'
    })
    expect(repeated).toMatchObject({ changed: false, message: { id: response.message.id } })
    expect(dependencies.commitFeedback).toHaveBeenCalledTimes(2)
  })

  it('lets only the claimed active revise Attempt publish an immutable replacement', async () => {
    const { service, context } = setup()
    const original = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const feedback = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: original.projection.revision,
      commandId: 'feedback-1',
      feedback: 'Split the analysis by cohort.'
    })
    const continuation = feedback.turn.continuation!
    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        content: { ...content, task_summary: 'Unauthorized replacement' }
      })
    ).rejects.toMatchObject({ code: 'continuation-required' })
    const claimed = await service.claimContinuation({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: feedback.projection.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1'
    })
    const active = await service.recordContinuationActive({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: claimed.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1'
    })
    const replacement = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: active.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1',
      content: { ...content, task_summary: 'Replacement' }
    })
    expect(replacement).toMatchObject({
      projection: { artifactVersionId: 'version-2', approval: 'pending' },
      turn: {
        turnAnchor: 'interaction-1',
        lifecycle: 'awaiting_plan_approval',
        planArtifactVersionId: 'version-2'
      }
    })
    expect(context().plan).toMatchObject({ artifactVersionId: 'version-2', stepStatuses: {} })
    await expect(
      service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'interaction-1',
        artifactVersionId: original.projection.artifactVersionId,
        expectedRevision: replacement.projection.revision,
        commandId: 'stale-feedback',
        feedback: 'Old card'
      })
    ).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('restores the original pending Plan when an active revise Attempt fails', async () => {
    const { service, context, status } = setup()
    const original = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const feedback = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: original.projection.revision,
      commandId: 'feedback-1',
      feedback: 'Revise it.'
    })
    const continuation = feedback.turn.continuation!
    const claimed = await service.claimContinuation({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: feedback.projection.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1'
    })
    const active = await service.recordContinuationActive({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: claimed.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1'
    })
    await service.recordContinuationFailed({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: active.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1',
      failure: 'execution_failed'
    })
    expect(context()).toMatchObject({
      plan: { artifactVersionId: 'version-1', approval: 'pending' },
      planTurn: { lifecycle: 'awaiting_plan_approval', planArtifactVersionId: 'version-1' }
    })
    expect(context().planTurn?.continuation).toBeUndefined()
    expect(status()).toBe('waiting-plan-approval')
  })

  it('projects retained in-progress work as interrupted after the interaction ends', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-unavailable-artifact',
      decision: 'approved'
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const active = await activateApprovedContinuation(service, identity, approved)
    const running = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })

    expect(running.projection.lifecycle).toBe('in_progress')
    await expect(
      service.getProjection('project-1', 'session-1', { interactionIsLive: false })
    ).resolves.toMatchObject({ lifecycle: 'interrupted' })
  })

  it('does not change the active Plan when durable Artifact verification fails', async () => {
    const { service, dependencies, context } = setup()
    vi.mocked(dependencies.readArtifactVersion).mockResolvedValueOnce({
      content: '{"corrupt":true}',
      checksum: 'b'.repeat(64)
    })

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        content
      })
    ).rejects.toMatchObject({ code: 'artifact-unavailable' })
    expect(context().plan).toBeUndefined()
    expect(dependencies.patchRuntimeContext).not.toHaveBeenCalled()
  })

  it('returns invalid-plan without writing an Artifact or replacing the active Plan', async () => {
    const { service, dependencies, context } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const activePlan = context().plan
    vi.mocked(dependencies.writeArtifactForActiveTurn).mockClear()
    vi.mocked(dependencies.patchRuntimeContext).mockClear()

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-2',
        content: {
          ...content,
          phases: [
            {
              name: 'Analysis',
              delegations: [
                {
                  name: 'Primary agent',
                  steps: [
                    { title: 'Analyze the data', description: 'First.' },
                    { title: ' Analyze the data ', description: 'Duplicate.' }
                  ]
                }
              ]
            }
          ]
        }
      })
    ).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(dependencies.writeArtifactForActiveTurn).not.toHaveBeenCalled()
    expect(dependencies.patchRuntimeContext).not.toHaveBeenCalled()
    expect(context().plan).toBe(activePlan)
  })

  it('distinguishes a CAS conflict from an unrelated persistence failure', async () => {
    const conflict = setup()
    vi.mocked(conflict.dependencies.patchRuntimeContext).mockRejectedValueOnce(
      new Error('revision conflict')
    )
    await expect(
      conflict.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        content
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })

    const storage = setup()
    vi.mocked(storage.dependencies.patchRuntimeContext).mockRejectedValueOnce(
      new Error('disk unavailable')
    )
    await expect(
      storage.service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        content
      })
    ).rejects.toThrow('disk unavailable')
  })

  it('rehydrates approved execution authority and rejects a replaced Artifact Version', async () => {
    const { service, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-revision-conflict',
      decision: 'approved'
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const active = await activateApprovedContinuation(service, identity, approved)
    const reconstructed = new PlanService({
      ...dependencies
    })
    await expect(
      reconstructed.updateStepStatus({
        ...identity,
        ...active.authority,
        expectedRevision: active.revision,
        title: 'Analyze the data',
        status: 'in_progress'
      })
    ).resolves.toMatchObject({ projection: { lifecycle: 'in_progress' } })
    await expect(reconstructed.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      lifecycle: 'interrupted'
    })
    await expect(
      reconstructed.getProjection('project-1', 'session-1', { interactionIsLive: true })
    ).resolves.toMatchObject({ lifecycle: 'in_progress' })

    await expect(
      reconstructed.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'stale-version',
        expectedRevision: active.revision,
        ...active.authority,
        title: 'Analyze the data',
        status: 'completed'
      })
    ).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('enforces serial steps and phase gates while independent delegations may start together', async () => {
    const { service, identity, approved } = await approveExecutionPlan()

    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: approved.projection.revision,
        title: 'Compare cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: approved.projection.revision,
        title: 'Compare cohorts',
        status: 'skipped'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })

    const cohortRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Validate cohorts',
      status: 'in_progress'
    })
    const evidenceRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortRunning.projection.revision,
      title: 'Find evidence',
      status: 'in_progress'
    })
    expect(evidenceRunning.projection.stepStatuses).toMatchObject({
      'Validate cohorts': { status: 'in_progress' },
      'Find evidence': { status: 'in_progress' }
    })

    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: evidenceRunning.projection.revision,
        title: 'Draft report',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })
  })

  it('lets an already-started peer delegation settle after a block and then completes cleanly blocked', async () => {
    const { service, identity, approved } = await approveExecutionPlan()
    const cohortRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Validate cohorts',
      status: 'in_progress'
    })
    const evidenceRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortRunning.projection.revision,
      title: 'Find evidence',
      status: 'in_progress'
    })
    const cohortBlocked = await service.updateStepStatus({
      ...identity,
      expectedRevision: evidenceRunning.projection.revision,
      title: 'Validate cohorts',
      status: 'blocked',
      notes: 'Cohort boundaries are missing.'
    })
    expect(cohortBlocked.projection.stepStates).toMatchObject({
      'Compare cohorts': { status: 'not_run' },
      'Review evidence': { status: 'not_started' },
      'Audit findings': { status: 'not_run' },
      'Draft report': { status: 'not_run' }
    })

    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: cohortBlocked.projection.revision,
        title: 'Audit findings',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'dependency-not-satisfied' })

    const evidenceFound = await service.updateStepStatus({
      ...identity,
      expectedRevision: cohortBlocked.projection.revision,
      title: 'Find evidence',
      status: 'completed'
    })
    const reviewRunning = await service.updateStepStatus({
      ...identity,
      expectedRevision: evidenceFound.projection.revision,
      title: 'Review evidence',
      status: 'in_progress'
    })
    const settled = await service.updateStepStatus({
      ...identity,
      expectedRevision: reviewRunning.projection.revision,
      title: 'Review evidence',
      status: 'completed'
    })

    expect(settled.projection.lifecycle).toBe('blocked')
    expect(settled.projection.requiresExplicitContinuation).toBe(false)
    expect(settled.projection.stepStates).toMatchObject({
      'Validate cohorts': { status: 'blocked', notes: 'Cohort boundaries are missing.' },
      'Compare cohorts': { status: 'not_run' },
      'Find evidence': { status: 'completed' },
      'Review evidence': { status: 'completed' },
      'Audit findings': { status: 'not_run' },
      'Draft report': { status: 'not_run' }
    })
    await expect(
      service.authorizeContinuation({
        ...identity,
        expectedRevision: settled.projection.revision
      })
    ).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('supports primary-agent sequential fallback without changing the delegation schema', async () => {
    const { service, identity, approved } = await approveExecutionPlan()
    let revision = approved.projection.revision
    const transition = async (
      title: string,
      status: 'in_progress' | 'completed'
    ): Promise<void> => {
      const result = await service.updateStepStatus({
        ...identity,
        expectedRevision: revision,
        title,
        status
      })
      revision = result.projection.revision
    }

    for (const title of [
      'Validate cohorts',
      'Compare cohorts',
      'Find evidence',
      'Review evidence',
      'Audit findings'
    ]) {
      await transition(title, 'in_progress')
      await transition(title, 'completed')
    }
    await transition('Draft report', 'in_progress')

    const projection = await service.getProjection('project-1', 'session-1')
    expect(projection?.lifecycle).toBe('interrupted')
    expect(projection?.document.phases[0].delegations).toHaveLength(3)
    expect(projection?.document).not.toHaveProperty('execution_strategy')
  })

  it('returns stable structured errors for approval, title, and revision violations', async () => {
    const { service, identity, generated } = await generateExecutionPlan()
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: generated.projection.revision,
        title: 'Validate cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })

    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      turnAnchor: 'interaction-1',
      commandId: 'approve-dependencies',
      decision: 'approved'
    })
    const active = await activateApprovedContinuation(service, identity, approved)
    await expect(
      service.updateStepStatus({
        ...identity,
        ...active.authority,
        expectedRevision: active.revision,
        title: 'Unknown work',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'unknown-step' })
    await expect(
      service.updateStepStatus({
        ...identity,
        ...active.authority,
        expectedRevision: generated.projection.revision,
        title: 'Validate cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('restores the original approval surface when replacement Artifact verification fails', async () => {
    const { service, dependencies, context } = setup()
    const original = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const feedback = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: original.projection.revision,
      commandId: 'feedback-replacement',
      feedback: 'Replace the plan.'
    })
    const continuation = feedback.turn.continuation!
    const claimed = await service.claimContinuation({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: feedback.projection.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1'
    })
    const active = await service.recordContinuationActive({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: original.projection.artifactVersionId,
      expectedRevision: claimed.revision,
      continuationId: continuation.continuationId,
      attemptId: 'attempt-revise-1'
    })
    vi.mocked(dependencies.writeArtifactForActiveTurn).mockResolvedValueOnce({
      artifactId: 'artifact-2',
      versionId: 'version-2',
      checksum: 'b'.repeat(64),
      name: 'plan-replacement.json'
    })
    vi.mocked(dependencies.readArtifactVersion).mockResolvedValueOnce({
      content: '{"corrupt":true}',
      checksum: 'b'.repeat(64)
    })

    await expect(
      service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        turnAnchor: 'interaction-1',
        artifactVersionId: original.projection.artifactVersionId,
        expectedRevision: active.revision,
        continuationId: continuation.continuationId,
        attemptId: 'attempt-revise-1',
        content: { ...content, task_summary: 'Replacement' }
      })
    ).rejects.toMatchObject({ code: 'artifact-unavailable' })
    expect(context().plan).toMatchObject({
      artifactVersionId: original.projection.artifactVersionId,
      approval: 'pending',
      stepStatuses: {}
    })
  })

  it('passively restores approved progress as interrupted without reviving an interaction', async () => {
    const { service, dependencies } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-live-interaction',
      decision: 'approved',
      interactionIsLive: true
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }
    const active = await activateApprovedContinuation(service, identity, approved)
    await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })

    const restarted = new PlanService({
      ...dependencies
    })
    await expect(restarted.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      lifecycle: 'interrupted',
      requiresExplicitContinuation: true,
      stepStatuses: { 'Analyze the data': { status: 'in_progress' } }
    })
  })

  it('records approval after restart without claiming that execution resumed', async () => {
    const { service, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })

    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-ended-interaction',
      decision: 'approved',
      interactionIsLive: false
    })

    expect(status()).toBe('running')
    expect(approved.projection).toMatchObject({
      approval: 'approved',
      lifecycle: 'approved',
      requiresExplicitContinuation: true
    })
  })

  it('authorizes explicit continuation only for the durable approved incomplete version', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const approved = await service.respond({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      commandId: 'approve-ended-interaction-live-projection',
      decision: 'approved',
      interactionIsLive: false
    })

    await expect(
      service.authorizeContinuation({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: approved.projection.revision
      })
    ).resolves.toMatchObject({
      artifactVersionId: generated.projection.artifactVersionId,
      approval: 'approved',
      requiresExplicitContinuation: false
    })
    await expect(
      service.authorizeContinuation({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'stale-version',
        expectedRevision: approved.projection.revision
      })
    ).rejects.toMatchObject({ code: 'stale-plan' })
  })

  it('rejects continuation before approval and after completion', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId
    }

    await expect(
      service.authorizeContinuation({
        ...identity,
        expectedRevision: generated.projection.revision
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })

    const approved = await service.respond({
      ...identity,
      expectedRevision: generated.projection.revision,
      turnAnchor: 'interaction-1',
      commandId: 'approve-authority',
      decision: 'approved',
      interactionIsLive: false
    })
    const active = await activateApprovedContinuation(service, identity, approved)
    const started = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: active.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })
    const completed = await service.updateStepStatus({
      ...identity,
      ...active.authority,
      expectedRevision: started.projection.revision,
      title: 'Analyze the data',
      status: 'completed'
    })

    await expect(
      service.authorizeContinuation({
        ...identity,
        expectedRevision: completed.projection.revision
      })
    ).rejects.toMatchObject({ code: 'invalid-transition' })
  })

  it('drops unreadable restored Plan authority instead of exposing it as executable', async () => {
    const { service, dependencies, context, status } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    vi.mocked(dependencies.readArtifactVersion).mockResolvedValueOnce({
      content: '{"schema_version":1}',
      checksum: '0'.repeat(64)
    })

    await expect(service.getProjection('project-1', 'session-1')).resolves.toBeNull()
    expect(context().plan).toBeUndefined()
    expect(status()).toBe('idle')
  })

  it('drops checksum-valid restored Plan authority when the document structure is corrupt', async () => {
    const { service, dependencies, context, setContext, status } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const corrupt = JSON.stringify({
      schema_version: 1,
      task_summary: 'Missing phases',
      phases: [],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Invalid structure.' }
    })
    vi.mocked(dependencies.readArtifactVersion).mockResolvedValueOnce({
      content: corrupt,
      checksum: createHash('sha256').update(corrupt).digest('hex')
    })
    setContext({
      ...context(),
      plan: {
        ...context().plan!,
        artifactChecksum: createHash('sha256').update(corrupt).digest('hex')
      }
    })

    await expect(service.getProjection('project-1', 'session-1')).resolves.toBeNull()
    expect(context().plan).toBeUndefined()
    expect(status()).toBe('idle')
  })

  it('drops restored Plan authority when provenance content is missing', async () => {
    const { service, dependencies, context, status } = setup()
    await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    vi.mocked(dependencies.readArtifactVersion).mockRejectedValueOnce(
      new Error('pending content is missing')
    )

    await expect(service.getProjection('project-1', 'session-1')).resolves.toBeNull()
    expect(context().plan).toBeUndefined()
    expect(status()).toBe('idle')
  })

  it('atomically migrates a checksum-valid legacy pending Plan with a verified user anchor', async () => {
    const { service, dependencies, context, setContext, status } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'prompt-legacy',
      content
    })
    setContext({ version: 1, revision: generated.projection.revision, plan: context().plan })
    Object.assign(dependencies, {
      resolveLegacyPlanTurnAnchor: vi.fn(async () => ({
        status: 'resolved',
        turnAnchor: 'prompt-legacy'
      }))
    })

    await expect(service.recoverLegacyPendingPlan('project-1', 'session-1')).resolves.toMatchObject(
      {
        status: 'recovered',
        turn: { turnAnchor: 'prompt-legacy', lifecycle: 'awaiting_plan_approval' }
      }
    )
    expect(context()).toMatchObject({
      version: 2,
      plan: { originatingPromptMessageId: 'prompt-legacy' },
      planTurn: { turnAnchor: 'prompt-legacy', lifecycle: 'awaiting_plan_approval' }
    })
    expect(status()).toBe('waiting-plan-approval')
  })

  it('keeps a legacy pending Plan non-actionable when its anchor is ambiguous', async () => {
    const { service, dependencies, context, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'prompt-legacy',
      content
    })
    setContext({
      version: 1,
      revision: generated.projection.revision,
      plan: { ...context().plan!, originatingPromptMessageId: undefined }
    })
    Object.assign(dependencies, {
      resolveLegacyPlanTurnAnchor: vi.fn(async () => ({
        status: 'unresolved',
        reason: 'ambiguous'
      }))
    })

    await expect(service.recoverLegacyPendingPlan('project-1', 'session-1')).resolves.toMatchObject(
      {
        status: 'read-only',
        error: { code: 'interaction-mismatch', message: expect.stringContaining('ambiguous') }
      }
    )
    expect(context().planTurn).toBeUndefined()
    await expect(
      service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'prompt-legacy',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: context().revision,
        commandId: 'approve-ambiguous-legacy',
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
  })

  it('clears legacy approved incomplete authority instead of authorizing execution', async () => {
    const { service, context, setContext } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'prompt-legacy',
      content
    })
    setContext({
      version: 1,
      revision: generated.projection.revision,
      plan: { ...context().plan!, approval: 'approved' }
    })

    await expect(service.recoverLegacyPendingPlan('project-1', 'session-1')).resolves.toMatchObject(
      { status: 'read-only', error: { code: 'interaction-mismatch' } }
    )
    expect(context().plan).toBeUndefined()
  })

  it('drives deterministic fake-Agent blocked and completed acceptance flows', async () => {
    const run = async (terminal: 'blocked' | 'completed'): Promise<ActivePlanProjection> => {
      const { service } = setup()
      const generated = await service.generate({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: `interaction-${terminal}`,
        content
      })
      expect(generated.projection).toMatchObject({
        lifecycle: 'awaiting_approval',
        approval: 'pending'
      })
      const identity = {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        turnAnchor: `interaction-${terminal}`,
        commandId: `approve-${terminal}`
      }
      const approved = await service.respond({
        ...identity,
        expectedRevision: generated.projection.revision,
        decision: 'approved',
        interactionIsLive: true
      })
      const active = await activateApprovedContinuation(service, identity, approved)
      const executing = await service.updateStepStatus({
        ...identity,
        ...active.authority,
        expectedRevision: active.revision,
        title: 'Analyze the data',
        status: 'in_progress'
      })
      return (
        await service.updateStepStatus({
          ...identity,
          ...active.authority,
          expectedRevision: executing.projection.revision,
          title: 'Analyze the data',
          status: terminal,
          ...(terminal === 'blocked' ? { notes: 'Deterministic fixture input is missing.' } : {})
        })
      ).projection
    }

    await expect(run('blocked')).resolves.toMatchObject({
      lifecycle: 'blocked',
      stepStates: {
        'Analyze the data': {
          status: 'blocked',
          notes: 'Deterministic fixture input is missing.'
        }
      }
    })
    await expect(run('completed')).resolves.toMatchObject({
      lifecycle: 'completed',
      counts: { completed: 1, steps: 1 }
    })
  })
})
