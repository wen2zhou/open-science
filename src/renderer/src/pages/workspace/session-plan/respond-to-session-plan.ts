import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { useSessionStore } from '@/stores/session-store'

type SessionPlanResponseTarget = Readonly<{
  projectId: string
  sessionId: string
  projection: Pick<ActivePlanProjection, 'artifactVersionId' | 'revision'>
}>

const refreshSessionPlanProjection = async ({
  projectId,
  sessionId
}: Pick<SessionPlanResponseTarget, 'projectId' | 'sessionId'>): Promise<void> => {
  const current = await window.api.acp.getPlanProjection(projectId, sessionId)
  if (current) useSessionStore.getState().setActivePlanProjection(sessionId, current)
}

export const respondToSessionPlan = async (
  target: SessionPlanResponseTarget,
  decision: 'approved' | 'rejected'
): Promise<void> => {
  try {
    await window.api.acp.respondPlan({
      projectId: target.projectId,
      sessionId: target.sessionId,
      artifactVersionId: target.projection.artifactVersionId,
      expectedRevision: target.projection.revision,
      decision
    })
  } catch (error) {
    try {
      await refreshSessionPlanProjection(target)
    } catch {
      // Preserve the authoritative response error when recovery hydration also fails.
    }
    throw error
  }
  await refreshSessionPlanProjection(target)
}
