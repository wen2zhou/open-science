// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { useSessionStore } from '@/stores/session-store'

import { respondToSessionPlan } from './respond-to-session-plan'

const projection = {
  artifactVersionId: 'version-1',
  originatingPromptMessageId: 'prompt-1',
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

const feedbackMessage = {
  id: 'message-1',
  role: 'user',
  content: 'Split the analysis by cohort.',
  status: 'complete',
  createdAt: 10,
  updatedAt: 10
}

beforeEach(() => {
  respondPlan.mockReset().mockResolvedValue({ changed: true, projection: approvedProjection })
  getPlanProjection.mockReset().mockResolvedValue(projection)
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
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        activePlanProjection: projection
      } as never
    ]
  })
})

describe('respondToSessionPlan', () => {
  it('refreshes a long-lived pending Plan before binding the decision revision', async () => {
    const refreshedPending = { ...projection, revision: 9 }
    getPlanProjection.mockResolvedValue(refreshedPending)

    await respondToSessionPlan(
      { projectId: 'project-1', sessionId: 'session-1', projection },
      'approved'
    )

    expect(respondPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        turnAnchor: 'prompt-1',
        artifactVersionId: 'version-1',
        expectedRevision: 9,
        decision: 'approved'
      })
    )
  })

  it('shares the version-bound response and projection refresh across renderer surfaces', async () => {
    await respondToSessionPlan(
      { projectId: 'project-1', sessionId: 'session-1', projection },
      'approved'
    )

    expect(respondPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'prompt-1',
        artifactVersionId: 'version-1',
        expectedRevision: 3,
        decision: 'approved'
      })
    )
    expect(getPlanProjection).toHaveBeenCalledWith('project-1', 'session-1')
    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBe(approvedProjection)
  })

  it('sends an identity-bound retry command and refreshes the durable projection', async () => {
    await respondToSessionPlan(
      { projectId: 'project-1', sessionId: 'session-1', projection },
      { retry: true }
    )

    expect(respondPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'prompt-1',
        artifactVersionId: 'version-1',
        expectedRevision: 3,
        retry: true
      })
    )
    expect(getPlanProjection).toHaveBeenCalledWith('project-1', 'session-1')
    expect(useSessionStore.getState().sessions[0].activePlanProjection).toBe(approvedProjection)
  })

  it('projects returned feedback immediately as a standard user Message', async () => {
    respondPlan.mockResolvedValue({
      kind: 'revision_requested',
      artifactVersionId: 'version-1',
      text: feedbackMessage.content,
      message: feedbackMessage
    })
    getPlanProjection.mockResolvedValue(projection)

    await respondToSessionPlan(
      { projectId: 'project-1', sessionId: 'session-1', projection },
      { feedback: feedbackMessage.content }
    )

    expect(respondPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        turnAnchor: 'prompt-1',
        artifactVersionId: 'version-1',
        expectedRevision: 3,
        feedback: feedbackMessage.content
      })
    )
    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        role: 'user',
        content: feedbackMessage.content
      })
    ])
  })

  it('projects feedback optimistically when the adapter omits its Message payload', async () => {
    respondPlan.mockResolvedValue(undefined)
    getPlanProjection.mockResolvedValue(projection)

    await respondToSessionPlan(
      { projectId: 'project-1', sessionId: 'session-1', projection },
      { feedback: feedbackMessage.content }
    )

    expect(useSessionStore.getState().sessions[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: feedbackMessage.content })
    ])
  })
})
