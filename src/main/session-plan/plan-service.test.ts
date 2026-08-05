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

type PlanServiceHarness = Readonly<{
  service: PlanService
  dependencies: PlanServiceDependencies
  context: () => SessionRuntimeContext
  status: () => string
}>

const setup = (): PlanServiceHarness => {
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
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: generated.projection.revision,
      decision: 'approved'
    })
    const running = await service.updateStepStatus({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: generated.projection.artifactVersionId,
      expectedRevision: approved.projection.revision,
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
})
