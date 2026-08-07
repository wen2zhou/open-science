import { describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { AcpRuntime } from './runtime'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'

const projection = (
  artifactVersionId: string,
  revision = 1,
  originatingPromptMessageId: string | null = 'interaction-1'
): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
  ...(originatingPromptMessageId ? { originatingPromptMessageId } : {}),
  revision,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
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
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { 'Analyze the data': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

type PlanServiceMock = Record<
  | 'generate'
  | 'respond'
  | 'getProjection'
  | 'getContinuationRecovery'
  | 'recoverLegacyPendingPlan'
  | 'updateStepStatus'
  | 'claimContinuation'
  | 'recordContinuationActive'
  | 'recordContinuationFailed',
  ReturnType<typeof vi.fn>
>

type RuntimeHarness = Readonly<{
  runtime: AcpRuntime
  workflow: ReturnType<typeof composeAcpRuntimePlanWorkflow>
  service: PlanServiceMock
  interactions: SessionPlanInteractionOwner
  setCurrentInteraction: (interaction: { sequence: number; promptMessageId: string }) => void
  updateStepStatus: ReturnType<typeof vi.fn>
}>

const createRuntimeHarness = (options: {
  onEvent?: (event?: unknown) => void
  activeProjection?: ActivePlanProjection
  durableMessageIds?: string[]
  cancelNotify?: () => Promise<void>
}): RuntimeHarness => {
  const generated = projection('version-1')
  const approved = { ...generated, approval: 'approved' as const, lifecycle: 'approved' as const }
  const updateStepStatus = vi.fn(async () => ({ projection: approved, changed: true }))
  const interactions = new SessionPlanInteractionOwner()
  const service = {
    generate: vi.fn(async () => ({ projection: generated, pauseInteraction: true as const })),
    respond: vi.fn(async (input: { feedback?: string; decision?: 'approved' | 'rejected' }) =>
      input.feedback
        ? {
            kind: 'revision_requested' as const,
            projection: generated,
            changed: true,
            turn: {
              turnAnchor: 'interaction-1',
              lifecycle: 'continuation_pending' as const,
              planArtifactVersionId: generated.artifactVersionId,
              continuation: {
                continuationId: 'continuation-revise-1',
                purpose: 'revise_pending_plan' as const,
                state: 'pending' as const,
                commandId: 'feedback-1',
                feedbackMessageId: 'message-1',
                requestedAt: 10,
                lastTransitionAt: 10
              }
            },
            text: input.feedback,
            message: {
              id: 'message-1',
              role: 'user' as const,
              content: input.feedback,
              status: 'complete' as const,
              eventIds: [],
              responseToMessageId: 'interaction-1',
              createdAt: 10,
              updatedAt: 10
            }
          }
        : {
            projection:
              input.decision === 'rejected'
                ? { ...generated, approval: 'rejected' as const, lifecycle: 'rejected' as const }
                : approved,
            changed: true
          }
    ),
    getProjection: vi.fn(
      async (
        _projectId: string,
        _sessionId: string,
        projectionOptions?: { interactionIsLive?: boolean }
      ) => {
        const current = options.activeProjection ?? generated
        return projectionOptions?.interactionIsLive === false && current.lifecycle === 'in_progress'
          ? { ...current, lifecycle: 'interrupted' as const }
          : current
      }
    ),
    getContinuationRecovery: vi.fn(async () => null),
    recoverLegacyPendingPlan: vi.fn(async () => ({ status: 'not-needed' as const })),
    updateStepStatus,
    claimContinuation: vi.fn(),
    recordContinuationActive: vi.fn(),
    recordContinuationFailed: vi.fn(async () => ({ revision: 9, turn: {} }))
  }
  let currentInteraction = {
    kind: 'prompt' as const,
    sessionId: 'session-1',
    sequence: 7,
    promptMessageId: 'interaction-1',
    turnToken: 'turn-token-1'
  }
  const sessionInteractions = {
    snapshot: () => [{ kind: 'prompt', sessionId: 'session-1' }],
    current: () => currentInteraction,
    cancelPrompt: vi.fn(
      async ({ notify, onAccepted }: { notify: () => Promise<void>; onAccepted: () => void }) => {
        await notify()
        onAccepted()
      }
    )
  }
  const planSessions = {
    containsMessageOnActiveBranch: vi.fn(
      async (_projectId: string, _sessionId: string, messageId: string) =>
        (options.durableMessageIds ?? ['interaction-1']).includes(messageId)
    )
  }
  const sessionPlanWorkflow = composeAcpRuntimePlanWorkflow(
    { plan: { sessions: planSessions } } as unknown as Parameters<
      typeof composeAcpRuntimePlanWorkflow
    >[0],
    {
      planService: service,
      planInteractions: interactions,
      sessionInteractions,
      artifactTurns: { promptMessageIdFor: () => 'interaction-1' }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[1],
    {
      publication: { pushEvent: (event: unknown) => options.onEvent?.(event) },
      sessionEnvironment: { projectName: () => 'project-1' }
    } as unknown as Parameters<typeof composeAcpRuntimePlanWorkflow>[2]
  )
  const target = Object.create(AcpRuntime.prototype) as Record<string, unknown>
  Object.assign(target, {
    planService: service,
    planInteractions: interactions,
    sessionInteractions,
    connectionResources: {
      connection: { agent: { notify: vi.fn(options.cancelNotify ?? (async () => undefined)) } }
    },
    sessionRegistry: {
      lookup: () => ({ attachment: { session: { sessionId: 'provider-session-1' } } })
    },
    sessionPlanWorkflow,
    artifactTurns: {
      promptMessageIdFor: () => 'interaction-1'
    },
    sessionDeletion: {
      delete: vi.fn(async () => ({ status: 'closed' }))
    },
    permissionContext: { cancelForSession: vi.fn() },
    publication: { emitState: vi.fn() },
    callbacks: { onEvent: options.onEvent },
    pushEvent: (event: unknown) => options.onEvent?.(event),
    getSnapshot: () => ({ status: 'connected' }),
    resolveSessionProjectName: () => 'project-1'
  })
  return {
    runtime: target as unknown as AcpRuntime,
    workflow: sessionPlanWorkflow,
    service,
    interactions,
    setCurrentInteraction: ({ sequence, promptMessageId }) => {
      currentInteraction = { ...currentInteraction, sequence, promptMessageId }
    },
    updateStepStatus
  }
}

describe('AcpRuntime Session Plan seam', () => {
  it('binds a durable continuation to the revision created by activation', async () => {
    const active = projection('version-1', 3)
    const { workflow, service, interactions } = createRuntimeHarness({ activeProjection: active })
    service.recordContinuationActive.mockResolvedValue({ revision: 4, turn: {} })
    const request = {
      sessionId: 'session-1',
      text: 'Revise the pending Plan.',
      planContinuation: {
        projectId: 'project-1',
        artifactVersionId: 'version-1',
        expectedRevision: 3,
        turnAnchor: 'interaction-1',
        continuationId: 'continuation-1',
        attemptId: 'attempt-1',
        purpose: 'revise_pending_plan' as const
      }
    }
    const interaction = {
      kind: 'prompt' as const,
      sessionId: 'session-1',
      sequence: 7,
      signal: new AbortController().signal,
      promptMessageId: 'interaction-1',
      turnToken: 'turn-token-1'
    }

    const preflight = await workflow.prompt.preflight(request)
    await workflow.prompt.admit(request, interaction, preflight)

    expect(interactions.executionBindingFor('session-1')).toMatchObject({
      artifactVersionId: 'version-1',
      expectedRevision: 4,
      continuationId: 'continuation-1',
      attemptId: 'attempt-1'
    })
  })

  it('records an active revise Attempt as failed when its prompt ends without a replacement Plan', async () => {
    const active = projection('version-1', 4)
    const { workflow, service } = createRuntimeHarness({ activeProjection: active })
    service.getContinuationRecovery.mockResolvedValue({
      projection: active,
      turn: {
        turnAnchor: 'interaction-1',
        lifecycle: 'continuation_active',
        planArtifactVersionId: 'version-1',
        continuation: {
          continuationId: 'continuation-1',
          purpose: 'revise_pending_plan',
          state: 'active',
          commandId: 'feedback-1',
          attemptId: 'attempt-1',
          requestedAt: 1,
          lastTransitionAt: 2
        }
      }
    })

    await workflow.prompt.afterRelease('session-1')

    expect(service.recordContinuationFailed).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: 'version-1',
      expectedRevision: 4,
      continuationId: 'continuation-1',
      attemptId: 'attempt-1',
      failure: 'execution_failed'
    })
  })

  it('records a continuation outcome through the public runtime seam at the latest revision', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: { ...projection('version-1', 8), approval: 'approved' }
    })

    await runtime.recordSessionPlanContinuationFailed({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: 'version-1',
      continuationId: 'continuation-1',
      attemptId: 'attempt-1',
      failure: 'execution_failed'
    })

    expect(service.recordContinuationFailed).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 8, continuationId: 'continuation-1' })
    )
  })

  it('returns plan_suspended immediately so the generating Attempt can end', async () => {
    const { runtime, service } = createRuntimeHarness({
      onEvent: () => {
        throw new Error('renderer unavailable')
      }
    })
    service.generate.mockResolvedValueOnce({
      kind: 'plan_suspended',
      projection: projection('version-1'),
      turn: {
        turnAnchor: 'interaction-1',
        lifecycle: 'awaiting_plan_approval',
        planArtifactVersionId: 'version-1'
      },
      pauseInteraction: true as const
    })
    const result = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await expect(result).resolves.toMatchObject({
      kind: 'plan_suspended',
      turn: { lifecycle: 'awaiting_plan_approval' }
    })
    expect(service.respond).not.toHaveBeenCalled()
    expect(runtime.getSessionPlanProjection).toBeDefined()
  })

  it('leaves duplicate generation rejection to the durable Plan service', async () => {
    const { runtime, service, interactions } = createRuntimeHarness({})
    let markGenerateStarted!: () => void
    let finishGenerate!: () => void
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve
    })
    const generateGate = new Promise<void>((resolve) => {
      finishGenerate = resolve
    })
    service.generate.mockImplementation(async () => {
      markGenerateStarted()
      await generateGate
      return { projection: projection('version-1'), pauseInteraction: true as const }
    })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await generateStarted
    const duplicate = runtime
      .callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      .catch((error) => error)
    await Promise.resolve()

    finishGenerate()
    await expect(pending).resolves.toMatchObject({ projection: { approval: 'pending' } })
    await expect(duplicate).resolves.toMatchObject({ projection: { approval: 'pending' } })
    expect(service.generate).toHaveBeenCalledTimes(2)
    expect(interactions.approvalInteractionIdFor('session-1')).toBeUndefined()
  })

  it('releases generation admission when durable Plan creation fails', async () => {
    const { runtime, service, interactions } = createRuntimeHarness({})
    service.generate.mockRejectedValueOnce(new Error('artifact write failed'))
    service.getProjection.mockResolvedValueOnce(null)

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
    ).rejects.toThrow('artifact write failed')

    const retry = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await expect(retry).resolves.toMatchObject({ projection: { approval: 'pending' } })
    expect(interactions.approvalInteractionIdFor('session-1')).toBeUndefined()
  })

  it('does not park a Plan after its generating interaction is cancelled', async () => {
    const { runtime, service, interactions } = createRuntimeHarness({})
    let markGenerateStarted!: () => void
    let finishGenerate!: () => void
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve
    })
    const generateGate = new Promise<void>((resolve) => {
      finishGenerate = resolve
    })
    service.generate.mockImplementationOnce(async () => {
      markGenerateStarted()
      await generateGate
      return { projection: projection('version-1'), pauseInteraction: true as const }
    })
    const cancelled = runtime
      .callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
      .catch((error) => error)
    await generateStarted

    await runtime.cancelPrompt({ sessionId: 'session-1' })
    finishGenerate()

    await expect(cancelled).resolves.toMatchObject({ projection: { approval: 'pending' } })
    expect(interactions.approvalInteractionIdFor('session-1')).toBeUndefined()

    const retry = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await expect(retry).resolves.toMatchObject({ projection: { approval: 'pending' } })
    expect(interactions.approvalInteractionIdFor('session-1')).toBeUndefined()
  })

  it('does not cancel a successor approval when the older cancel acknowledgement arrives late', async () => {
    let markNotifyStarted!: () => void
    let finishNotify!: () => void
    const notifyStarted = new Promise<void>((resolve) => {
      markNotifyStarted = resolve
    })
    const notifyGate = new Promise<void>((resolve) => {
      finishNotify = resolve
    })
    const { runtime, interactions, setCurrentInteraction } = createRuntimeHarness({
      cancelNotify: async () => {
        markNotifyStarted()
        await notifyGate
      }
    })
    const oldApproval = interactions
      .parkApproval('session-1', 'interaction-1')
      .catch((error) => error)
    const cancellation = runtime.cancelPrompt({ sessionId: 'session-1' })
    await notifyStarted

    interactions.rejectApproval('session-1', 'older interaction ended')
    await expect(oldApproval).resolves.toMatchObject({ message: 'older interaction ended' })
    setCurrentInteraction({ sequence: 8, promptMessageId: 'interaction-2' })
    const successorApproval = interactions.parkApproval('session-1', 'interaction-2')
    finishNotify()
    await cancellation

    expect(interactions.approvalInteractionIdFor('session-1')).toBe('interaction-2')
    interactions.resolveApproval('session-1', { decision: 'approved' })
    await expect(successorApproval).resolves.toEqual({ decision: 'approved' })
  })

  it('updates a Plan only through its exact execution binding', async () => {
    const { runtime, interactions, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-1', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })
    interactions.bindExecution({
      sessionId: 'session-1',
      interactionSequence: 7,
      artifactVersionId: 'version-1'
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).resolves.toMatchObject({ changed: true })
    expect(updateStepStatus).toHaveBeenCalledOnce()
  })

  it('rejects an MCP server-bound execution version after a replacement became active', async () => {
    const { runtime, interactions, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved'
      }
    })
    interactions.bindExecution({
      sessionId: 'session-1',
      interactionSequence: 7,
      artifactVersionId: 'version-1'
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: {
          title: 'Analyze the data',
          status: 'completed',
          expectedArtifactVersionId: 'version-1'
        }
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(updateStepStatus).not.toHaveBeenCalled()
  })

  it('rejects an MCP Plan decision when the Plan originated on a sibling Message Branch', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('version-2', 4, 'sibling-message'),
      durableMessageIds: ['parent-message', 'interaction-1']
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects an MCP Plan decision when a legacy Plan has no originating Message', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('legacy-version', 1, null)
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects a renderer Plan decision when the Plan originated on a sibling Message Branch', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('version-2', 4, 'sibling-message'),
      durableMessageIds: ['parent-message', 'interaction-1']
    })

    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'sibling-message',
        artifactVersionId: 'version-2',
        expectedRevision: 4,
        commandId: 'approve-sibling',
        decision: 'approved'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects renderer Plan feedback when the Plan originated on a sibling Message Branch', async () => {
    const { runtime, service } = createRuntimeHarness({
      activeProjection: projection('version-2', 4, 'sibling-message'),
      durableMessageIds: ['parent-message', 'interaction-1']
    })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    void pending.catch(() => undefined)
    await Promise.resolve()

    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'interaction-1',
        artifactVersionId: 'version-2',
        expectedRevision: 4,
        commandId: 'feedback-sibling',
        feedback: 'Use the sibling Plan.'
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(service.respond).not.toHaveBeenCalled()
  })

  it('rejects Plan execution from an ordinary interaction without explicit continuation authority', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-1', 4),
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: true
      }
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'continuation-required' })
    expect(updateStepStatus).not.toHaveBeenCalled()
  })

  it('rejects a Plan version bound to a different interaction', async () => {
    const { runtime, interactions, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: true
      }
    })
    interactions.bindExecution({
      sessionId: 'session-1',
      interactionSequence: 6,
      artifactVersionId: 'version-2'
    })

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'interaction-mismatch' })
    expect(updateStepStatus).not.toHaveBeenCalled()
  })

  it('does not release a successor execution when an older rejection finishes late', async () => {
    const { runtime, interactions, service } = createRuntimeHarness({})
    interactions.bindExecution({
      sessionId: 'session-1',
      interactionSequence: 6,
      artifactVersionId: 'version-1'
    })
    let markRespondStarted!: () => void
    let finishRespond!: () => void
    const respondStarted = new Promise<void>((resolve) => {
      markRespondStarted = resolve
    })
    const respondGate = new Promise<void>((resolve) => {
      finishRespond = resolve
    })
    service.respond.mockImplementationOnce(async () => {
      markRespondStarted()
      await respondGate
      return {
        projection: {
          ...projection('version-1'),
          approval: 'rejected' as const,
          lifecycle: 'rejected' as const
        },
        changed: true
      }
    })

    const rejected = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'reject'
    })
    await respondStarted
    interactions.bindExecution({
      sessionId: 'session-1',
      interactionSequence: 8,
      artifactVersionId: 'version-2'
    })
    finishRespond()

    await rejected
    expect(interactions.executionBindingFor('session-1')).toEqual({
      artifactVersionId: 'version-2',
      interactionSequence: 8
    })
  })

  it('routes durable feedback as a visible user Message without a parked interaction', async () => {
    const onEvent = vi.fn()
    const { runtime } = createRuntimeHarness({ onEvent })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'interaction-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        commandId: 'feedback-1',
        feedback: 'Split the analysis by cohort.'
      })
    ).resolves.toMatchObject({ kind: 'revision_requested' })
    await expect(pending).resolves.toMatchObject({
      projection: { approval: 'pending' }
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        role: 'user',
        text: 'Split the analysis by cohort.'
      })
    )
  })

  it('lets the resumed Agent explicitly approve after interpreting a user Message', async () => {
    const { runtime, service } = createRuntimeHarness({})
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      commandId: 'feedback-approve',
      feedback: '批准执行'
    })
    await pending

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'approve'
      })
    ).resolves.toMatchObject({ projection: { approval: 'approved' } })
    await runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'approve'
    })
    const decisions = service.respond.mock.calls
      .map(([command]) => command)
      .filter((command) => command.decision === 'approved')
    expect(decisions).toEqual([
      expect.objectContaining({
        turnAnchor: 'interaction-1',
        commandId: 'plan-decision-turn-token-1-approve',
        decision: 'approved',
        interactionIsLive: true
      }),
      expect.objectContaining({
        commandId: 'plan-decision-turn-token-1-approve',
        decision: 'approved'
      })
    ])
    expect(new Set(decisions.map((command) => command.commandId))).toEqual(
      new Set(['plan-decision-turn-token-1-approve'])
    )
  })

  it('lets the resumed Agent explicitly reject after interpreting a user Message', async () => {
    const { runtime, service } = createRuntimeHarness({})
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      commandId: 'feedback-reject',
      feedback: '取消计划'
    })
    await pending

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'reject'
      })
    ).resolves.toMatchObject({ projection: { approval: 'rejected' } })
    expect(service.respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'rejected', interactionIsLive: true })
    )
  })

  it('reports pending approval before continuation authority when the Agent skips its decision', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({})

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'updateStepStatus',
        input: { title: 'Analyze the data', status: 'in_progress' }
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })
    expect(updateStepStatus).not.toHaveBeenCalled()
  })

  it('marks approval as passive when restart left no in-process approval waiter', async () => {
    const { runtime, service } = createRuntimeHarness({})

    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      commandId: 'approve-passive',
      decision: 'approved'
    })

    expect(service.respond).toHaveBeenCalledWith(
      expect.objectContaining({ interactionIsLive: false })
    )
  })

  it.each(['approved', 'rejected'] as const)(
    'accepts an identity-complete %s decision after 300 seconds when hydration migrated only the legacy revision',
    async (decision) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000)
        const migrated = projection('version-1', 2)
        const { runtime, service } = createRuntimeHarness({ activeProjection: migrated })
        service.recoverLegacyPendingPlan.mockResolvedValue({
          status: 'recovered',
          projection: migrated,
          turn: {
            turnAnchor: 'interaction-1',
            lifecycle: 'awaiting_plan_approval',
            planArtifactVersionId: 'version-1'
          }
        })

        vi.advanceTimersByTime(301_000)
        await runtime.respondSessionPlan({
          projectId: 'project-1',
          sessionId: 'session-1',
          turnAnchor: 'interaction-1',
          artifactVersionId: 'version-1',
          expectedRevision: 1,
          commandId: `long-wait-${decision}`,
          decision
        })

        expect(service.respond).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project-1',
            sessionId: 'session-1',
            turnAnchor: 'interaction-1',
            artifactVersionId: 'version-1',
            expectedRevision: 2,
            commandId: `long-wait-${decision}`,
            decision,
            interactionIsLive: false
          })
        )
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('does not refresh an actually stale revision merely because legacy recovery also occurred', async () => {
    const migrated = projection('version-1', 3)
    const { runtime, service } = createRuntimeHarness({ activeProjection: migrated })
    service.recoverLegacyPendingPlan.mockResolvedValue({
      status: 'recovered',
      projection: migrated,
      turn: {
        turnAnchor: 'interaction-1',
        lifecycle: 'awaiting_plan_approval',
        planArtifactVersionId: 'version-1'
      }
    })

    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnAnchor: 'interaction-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      commandId: 'actually-stale',
      decision: 'rejected'
    })

    expect(service.respond).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, commandId: 'actually-stale' })
    )
  })

  it('clears only the deleted Session Plan interaction state', async () => {
    const { runtime, interactions } = createRuntimeHarness({})
    interactions.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'interaction-1'
    })
    interactions.bindExecution({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionSequence: 7
    })
    interactions.bindExecution({
      sessionId: 'session-2',
      artifactVersionId: 'version-2',
      interactionSequence: 8
    })
    const approval = interactions.parkApproval('session-1', 'interaction-1').catch((error) => error)

    await runtime.deleteSession({ sessionId: 'session-1' })

    await expect(approval).resolves.toMatchObject({
      message: 'The Session Plan interaction was deleted.'
    })
    expect(interactions.interactionIdFor('session-1', 'version-1')).toBeUndefined()
    expect(interactions.executionBindingFor('session-1')).toBeUndefined()
    expect(interactions.executionBindingFor('session-2')).toEqual({
      artifactVersionId: 'version-2',
      interactionSequence: 8
    })
  })
})
