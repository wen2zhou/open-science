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

const setup = () => {
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
      expect.objectContaining({ filename: 'plan-a91f30c2.json', mimeType: 'application/json' })
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
})
