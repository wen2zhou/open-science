import { describe, expect, it } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { projectDurablePlanTurn } from './durable-plan-turn'

const plan: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  originatingPromptMessageId: 'prompt-1',
  revision: 3,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: {},
  counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
}

const session = (
  lifecycle: 'awaiting_plan_approval' | 'continuation_pending' | 'continuation_active',
  overrides: Partial<ChatSession> = {}
): ChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Analysis',
    cwd: '/workspace',
    status: lifecycle === 'awaiting_plan_approval' ? 'waiting-plan-approval' : 'running',
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    activePlanProjection: plan,
    runtimeContext: {
      version: 2,
      revision: 3,
      plan: {
        artifactId: plan.artifactId,
        artifactVersionId: plan.artifactVersionId,
        artifactChecksum: plan.artifactChecksum,
        originatingPromptMessageId: 'prompt-1',
        approval: lifecycle === 'awaiting_plan_approval' ? 'pending' : 'approved',
        stepStatuses: {}
      },
      planTurn: {
        turnAnchor: 'prompt-1',
        lifecycle,
        planArtifactVersionId: 'version-1',
        ...(lifecycle === 'awaiting_plan_approval'
          ? {}
          : {
              continuation: {
                continuationId: 'continuation-1',
                purpose: 'execute_approved_plan' as const,
                state:
                  lifecycle === 'continuation_active' ? ('active' as const) : ('pending' as const),
                requestedAt: 3,
                lastTransitionAt: 4
              }
            })
      }
    },
    ...overrides
  }) as ChatSession

describe('durable Plan Turn projection', () => {
  it('keeps the current pending Plan actionable without an active run', () => {
    const projected = projectDurablePlanTurn(session('awaiting_plan_approval'))

    expect(projected).toMatchObject({
      state: 'awaiting_plan_approval',
      actionable: true,
      sidebarLabel: 'Waiting for plan approval',
      showsSpinner: false
    })
  })

  it('projects continuation dispatch as Resuming with decisions disabled', () => {
    const projected = projectDurablePlanTurn(
      session('continuation_pending', {
        activePlanProjection: { ...plan, approval: 'approved', lifecycle: 'approved' }
      })
    )

    expect(projected).toMatchObject({
      state: 'continuation_pending',
      actionable: false,
      sidebarLabel: 'Resuming',
      showsSpinner: false
    })
  })

  it('fails closed when Turn and active Plan identities disagree', () => {
    const projected = projectDurablePlanTurn(
      session('awaiting_plan_approval', {
        activePlanProjection: { ...plan, artifactVersionId: 'replacement-version' }
      })
    )

    expect(projected?.actionable).toBe(false)
  })

  it('keeps a legacy waiting projection actionable during expand/migrate compatibility', () => {
    const projected = projectDurablePlanTurn(
      session('awaiting_plan_approval', { runtimeContext: undefined })
    )

    expect(projected).toMatchObject({ state: 'awaiting_plan_approval', actionable: true })
  })
})
