// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { useSessionStore } from '@/stores/session-store'

import { respondToSessionPlan } from './respond-to-session-plan'

const projection = {
  artifactVersionId: 'version-1',
  revision: 3
} as ActivePlanProjection

const approvedProjection = {
  ...projection,
  revision: 4,
  approval: 'approved',
  lifecycle: 'approved'
} as ActivePlanProjection

const respondPlan = vi.fn()
const getPlanProjection = vi.fn()

beforeEach(() => {
  respondPlan.mockReset().mockResolvedValue({ changed: true, projection: approvedProjection })
  getPlanProjection.mockReset().mockResolvedValue(approvedProjection)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { acp: { respondPlan, getPlanProjection } }
  })
  useSessionStore.setState({
    sessions: [
      {
        id: 'session-1',
        projectId: 'project-1',
        status: 'waiting-plan-approval',
        activePlanProjection: projection
      } as never
    ]
  })
})

describe('respondToSessionPlan', () => {
  it('shares the version-bound response and projection refresh across renderer surfaces', async () => {
    await respondToSessionPlan(
      { projectId: 'project-1', sessionId: 'session-1', projection },
      'approved'
    )

    expect(respondPlan).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 3,
      decision: 'approved'
    })
    expect(getPlanProjection).toHaveBeenCalledWith('project-1', 'session-1')
    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBe(approvedProjection)
  })
})
