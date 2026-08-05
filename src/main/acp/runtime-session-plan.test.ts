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
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0 }
})

type RuntimePlanHarness = Readonly<{
  runtime: AcpRuntime
  service: Readonly<{
    generate: ReturnType<typeof vi.fn>
    respond: ReturnType<typeof vi.fn>
    getProjection: ReturnType<typeof vi.fn>
    updateStepStatus: ReturnType<typeof vi.fn>
    checkTurnCompletion: ReturnType<typeof vi.fn>
  }>
  updateStepStatus: ReturnType<typeof vi.fn>
}>

const createRuntimeHarness = (options: {
  onEvent?: (event?: unknown) => void
  activeProjection?: ActivePlanProjection
}): RuntimePlanHarness => {
  const generated = projection('version-1')
  const approved = { ...generated, approval: 'approved' as const, lifecycle: 'approved' as const }
  const updateStepStatus = vi.fn(async () => ({ projection: approved, changed: true }))
  const service = {
    generate: vi.fn(async () => ({ projection: generated, pauseInteraction: true as const })),
    respond: vi.fn(async () => ({ projection: approved, changed: true })),
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
    artifactTurns: { promptMessageIdFor: () => 'interaction-1' },
    planApprovalWaiters: new Map(),
    callbacks: { onEvent: options.onEvent },
    sessionInteractions: { current: () => undefined },
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

  it('passes the MCP server-bound execution version instead of substituting the active version', async () => {
    const { runtime, updateStepStatus } = createRuntimeHarness({
      activeProjection: projection('version-2', 4)
    })

    await runtime.callSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      operation: 'updateStepStatus',
      input: {
        title: 'Analyze the data',
        status: 'completed',
        expectedArtifactVersionId: 'version-1'
      }
    })

    expect(updateStepStatus).toHaveBeenCalledWith(
      expect.objectContaining({ artifactVersionId: 'version-1', expectedRevision: 4 })
    )
  })
})
