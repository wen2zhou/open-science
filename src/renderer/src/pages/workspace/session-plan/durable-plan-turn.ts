import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'

export type DurablePlanTurnState =
  | 'awaiting_plan_approval'
  | 'continuation_pending'
  | 'continuation_active'
  | 'continuation_interrupted'

export type DurablePlanTurnProjection = Readonly<{
  state: DurablePlanTurnState
  plan: ActivePlanProjection
  actionable: boolean
  sidebarLabel: 'Waiting for plan approval' | 'Resuming' | 'Running' | 'Needs attention'
  showsSpinner: boolean
}>

const presentation = (
  state: DurablePlanTurnState
): Pick<DurablePlanTurnProjection, 'sidebarLabel' | 'showsSpinner'> => {
  switch (state) {
    case 'awaiting_plan_approval':
      return { sidebarLabel: 'Waiting for plan approval', showsSpinner: false }
    case 'continuation_pending':
      return { sidebarLabel: 'Resuming', showsSpinner: false }
    case 'continuation_active':
      return { sidebarLabel: 'Running', showsSpinner: true }
    case 'continuation_interrupted':
      return { sidebarLabel: 'Needs attention', showsSpinner: false }
  }
}

const runtimeLifecycle = (session: ChatSession): DurablePlanTurnState | undefined => {
  const value = (session.runtimeContext?.planTurn as { lifecycle?: unknown } | undefined)?.lifecycle
  return value === 'awaiting_plan_approval' ||
    value === 'continuation_pending' ||
    value === 'continuation_active' ||
    value === 'continuation_interrupted'
    ? value
    : undefined
}

export const projectDurablePlanTurn = (
  session: ChatSession | undefined
): DurablePlanTurnProjection | undefined => {
  const plan = session?.activePlanProjection
  if (!session || !plan) return undefined

  const turn = session.runtimeContext?.planTurn
  const state = runtimeLifecycle(session)
  if (turn && state) {
    const identityMatches =
      turn.planArtifactVersionId === plan.artifactVersionId &&
      turn.turnAnchor === plan.originatingPromptMessageId
    return {
      state,
      plan,
      actionable:
        identityMatches && state === 'awaiting_plan_approval' && plan.approval === 'pending',
      ...presentation(state)
    }
  }

  // Expand/migrate compatibility: old persisted sessions do not yet carry planTurn. The existing
  // waiting status plus a current pending projection is the only legacy shape allowed to remain
  // actionable; an idle orphan stays fail-closed.
  if (!turn && plan.approval === 'pending' && plan.lifecycle === 'awaiting_approval') {
    return {
      state: 'awaiting_plan_approval',
      plan,
      actionable: session.status === 'waiting-plan-approval',
      ...presentation('awaiting_plan_approval')
    }
  }

  return undefined
}
