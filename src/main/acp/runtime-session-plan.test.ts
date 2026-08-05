import { describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { AcpRuntime } from './runtime'

const projection = (artifactVersionId: string, revision = 1): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
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
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0 }
})

type PlanServiceMock = Record<
  'generate' | 'respond' | 'getProjection' | 'updateStepStatus' | 'checkTurnCompletion',
  ReturnType<typeof vi.fn>
>

type RuntimeHarness = Readonly<{
  runtime: AcpRuntime
  service: PlanServiceMock
  updateStepStatus: ReturnType<typeof vi.fn>
}>

const createRuntimeHarness = (options: {
  onEvent?: (event?: unknown) => void
  activeProjection?: ActivePlanProjection
}): RuntimeHarness => {
  const generated = projection('version-1')
  const approved = { ...generated, approval: 'approved' as const, lifecycle: 'approved' as const }
  const updateStepStatus = vi.fn(async () => ({ projection: approved, changed: true }))
  const service = {
    generate: vi.fn(async () => ({ projection: generated, pauseInteraction: true as const })),
    respond: vi.fn(async (input: { feedback?: string }) =>
      input.feedback
        ? {
            kind: 'feedback' as const,
            routeToInteractionId: 'interaction-1',
            artifactVersionId: generated.artifactVersionId,
            text: input.feedback,
            message: {
              id: 'plan-response-1',
              role: 'user' as const,
              content: input.feedback,
              status: 'complete' as const,
              eventIds: [],
              responseToMessageId: 'interaction-1',
              responseToPlanVersionId: generated.artifactVersionId,
              createdAt: 10,
              updatedAt: 10
            }
          }
        : { projection: approved, changed: true }
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
    updateStepStatus,
    checkTurnCompletion: vi.fn(async () => ({ allow: true }))
  }
  const target = Object.create(AcpRuntime.prototype) as Record<string, unknown>
  Object.assign(target, {
    planService: service,
    sessionInteractions: {
      snapshot: () => [{ kind: 'prompt', sessionId: 'session-1' }],
      current: () => ({ kind: 'prompt', sessionId: 'session-1', sequence: 7 })
    },
    planExecutionBindings: new Map(),
    artifactTurns: { promptMessageIdFor: () => 'interaction-1' },
    planApprovalWaiters: new Map(),
    callbacks: { onEvent: options.onEvent },
    resolveSessionProjectName: () => 'project-1'
  })
  return { runtime: target as unknown as AcpRuntime, service, updateStepStatus }
}

describe('AcpRuntime Session Plan seam', () => {
  it('rejects duplicate generation and settles approval before a throwing projection callback', async () => {
    const { runtime } = createRuntimeHarness({
      onEvent: () => {
        throw new Error('renderer unavailable')
      }
    })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()

    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
    ).rejects.toThrow('already awaiting approval')
    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        decision: 'approved'
      })
    ).resolves.toMatchObject({ changed: true })
    await expect(pending).resolves.toMatchObject({ changed: true })
  })

  it('rejects an MCP server-bound execution version after a replacement became active', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: projection('version-2', 4)
    })
    ;(
      runtime as unknown as {
        planExecutionBindings: Map<
          string,
          { interactionSequence: number; artifactVersionId: string }
        >
      }
    ).planExecutionBindings.set('session-1', {
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
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: {
        ...projection('version-2', 4),
        approval: 'approved',
        lifecycle: 'approved',
        requiresExplicitContinuation: true
      }
    })
    ;(
      runtime as unknown as {
        planExecutionBindings: Map<
          string,
          { interactionSequence: number; artifactVersionId: string }
        >
      }
    ).planExecutionBindings.set('session-1', {
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

  it('routes inline revision feedback to the paused Plan interaction and projects its durable user Message', async () => {
    const onEvent = vi.fn()
    const { runtime, service } = createRuntimeHarness({ onEvent })
    const pending = runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'generate',
      input: {}
    })
    await Promise.resolve()
    onEvent.mockClear()

    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        feedback: 'Split the analysis by cohort.'
      })
    ).resolves.toMatchObject({ kind: 'feedback', routeToInteractionId: 'interaction-1' })
    await expect(pending).resolves.toMatchObject({
      kind: 'feedback',
      text: 'Split the analysis by cohort.'
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        role: 'user',
        messageId: 'plan-response-1',
        text: 'Split the analysis by cohort.'
      })
    )

    await expect(
      runtime.respondSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        expectedRevision: 1,
        feedback: 'Try another revision.'
      })
    ).rejects.toThrow('no longer available')
    expect(service.respond).toHaveBeenCalledTimes(1)

    onEvent.mockClear()
    service.generate.mockRejectedValueOnce(new Error('replacement failed'))
    await expect(
      runtime.callSessionPlan({
        projectId: 'project-1',
        sessionId: 'session-1',
        operation: 'generate',
        input: {}
      })
    ).rejects.toThrow('replacement failed')
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'plan',
        planProjection: expect.objectContaining({ artifactVersionId: 'version-1' })
      })
    )
  })

  it('marks approval as passive when restart left no in-process approval waiter', async () => {
    const { runtime, service } = createRuntimeHarness({})

    await runtime.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 1,
      decision: 'approved'
    })

    expect(service.respond).toHaveBeenCalledWith(
      expect.objectContaining({ interactionIsLive: false })
    )
  })
})
