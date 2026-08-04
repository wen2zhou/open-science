import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { SessionRuntimeContext } from '../../shared/session-persistence'
import { PlanService, type PlanServiceDependencies } from './plan-service'

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

const setup = (): Readonly<{
  service: PlanService
  dependencies: PlanServiceDependencies
  context: () => SessionRuntimeContext
  status: () => string
}> => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  let persistedStatus = 'running'
  let bytes = ''
  const dependencies: PlanServiceDependencies = {
    writeArtifactForActiveTurn: vi.fn(async (_sessionId, input) => {
      bytes = input.content
      return {
        artifactId: 'artifact-1',
        versionId: 'version-1',
        checksum: createHash('sha256').update(bytes).digest('hex'),
        name: input.filename
      }
    }),
    readArtifactVersion: vi.fn(async () => ({
      content: bytes,
      checksum: createHash('sha256').update(bytes).digest('hex')
    })),
    readRuntimeContext: vi.fn(async () => context),
    patchRuntimeContext: vi.fn(async ({ expectedRevision, plan, sessionStatus }) => {
      if (expectedRevision !== context.revision) throw new Error('revision conflict')
      context = { version: 1, revision: context.revision + 1, plan }
      persistedStatus = sessionStatus
      return context
    }),
    isRevisionConflict: (error) => error instanceof Error && error.message === 'revision conflict',
    now: () => 42,
    createId: () => 'a91f30c2'
  }
  return {
    service: new PlanService(dependencies),
    dependencies,
    context: () => context,
    status: () => persistedStatus
  }
}

type ExecutionPlanFixture = Readonly<{
  service: PlanService
  identity: Readonly<{
    projectId: string
    sessionId: string
    artifactVersionId: string
  }>
  generated: Awaited<ReturnType<PlanService['generate']>>
}>

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
      artifactVersionId: generated.projection.artifactVersionId
    }
  }
}

const approveExecutionPlan = async (): Promise<
  ExecutionPlanFixture & Readonly<{ approved: Awaited<ReturnType<PlanService['respond']>> }>
> => {
  const fixture = await generateExecutionPlan()
  const approved = await fixture.service.respond({
    ...fixture.identity,
    expectedRevision: fixture.generated.projection.revision,
    decision: 'approved'
  })
  return { ...fixture, approved }
}

describe('PlanService', () => {
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
      approval: 'pending',
      stepStatuses: {}
    })
    expect(status()).toBe('waiting-plan-approval')
    expect(result.projection.lifecycle).toBe('awaiting_approval')
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
      expectedRevision: generated.projection.revision
    }

    const approved = await service.respond({ ...identity, decision: 'approved' })
    expect(approved.changed).toBe(true)
    const duplicate = await service.respond({
      ...identity,
      expectedRevision: approved.projection.revision,
      decision: 'approved'
    })
    expect(duplicate.changed).toBe(false)

    const running = await service.updateStepStatus({
      ...identity,
      expectedRevision: approved.projection.revision,
      title: 'Analyze the data',
      status: 'in_progress'
    })
    expect(running.projection.lifecycle).toBe('in_progress')
    const completed = await service.updateStepStatus({
      ...identity,
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

  it('counts a deliberately skipped step as done in completed Plan progress', async () => {
    const { service } = setup()
    const generated = await service.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content
    })
    const skipped = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: (
        await service.respond({
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactVersionId: generated.projection.artifactVersionId,
          expectedRevision: generated.projection.revision,
          decision: 'approved'
        })
      ).projection.revision,
      title: 'Analyze the data',
      status: 'skipped',
      notes: 'The input already contains the result.'
    })

    expect(skipped.projection).toMatchObject({
      lifecycle: 'completed',
      counts: { completed: 1, steps: 1 }
    })
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
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const reconstructed = new PlanService(dependencies)
    await expect(
      reconstructed.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: approved.projection.revision,
        title: 'Analyze the data',
        status: 'in_progress'
      })
    ).resolves.toMatchObject({ projection: { lifecycle: 'in_progress' } })
    await expect(reconstructed.getProjection('project-1', 'session-1')).resolves.toMatchObject({
      lifecycle: 'interrupted'
    })

    vi.mocked(dependencies.writeArtifactForActiveTurn).mockResolvedValueOnce({
      artifactId: 'artifact-2',
      versionId: 'version-2',
      checksum: generated.projection.artifactChecksum,
      name: 'plan-replacement.json'
    })
    const replacement = await reconstructed.generate({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-2',
      content
    })
    await expect(
      reconstructed.updateStepStatus({
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactVersionId: generated.projection.artifactVersionId,
        expectedRevision: replacement.projection.revision,
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
    expect(settled.projection.stepStates).toMatchObject({
      'Validate cohorts': { status: 'blocked', notes: 'Cohort boundaries are missing.' },
      'Compare cohorts': { status: 'not_run' },
      'Find evidence': { status: 'completed' },
      'Review evidence': { status: 'completed' },
      'Audit findings': { status: 'not_run' },
      'Draft report': { status: 'not_run' }
    })
    await expect(
      service.checkTurnCompletion({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toEqual({ allow: true, lifecycle: 'blocked' })
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
      decision: 'approved'
    })
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: approved.projection.revision,
        title: 'Unknown work',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'unknown-step' })
    await expect(
      service.updateStepStatus({
        ...identity,
        expectedRevision: generated.projection.revision,
        title: 'Validate cohorts',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'revision-conflict' })
  })
})
