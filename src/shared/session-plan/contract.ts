import type {
  SessionPlanApproval,
  SessionPlanRuntimeContext,
  SessionPlanStepStatus
} from '../session-persistence'

export type PlanConfidence = 'high' | 'medium' | 'low'

export type GeneratePlanContent = Readonly<{
  task_summary: string
  phases: readonly Readonly<{
    name: string
    delegations: readonly Readonly<{
      name: string
      steps: readonly Readonly<{ title: string; description: string }>[]
    }>[]
  }>[]
  desired_outputs: readonly string[]
  feasibility: Readonly<{ confidence: PlanConfidence; rationale: string }>
}>

export type PlanDocumentV1 = GeneratePlanContent & Readonly<{ schema_version: 1 }>

export type PlanLifecycle =
  'awaiting_approval' | 'approved' | 'in_progress' | 'interrupted' | 'completed' | 'rejected'

export type ActivePlanProjection = Readonly<{
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  revision: number
  approval: SessionPlanApproval
  lifecycle: PlanLifecycle
  document: PlanDocumentV1
  stepStatuses: SessionPlanRuntimeContext['stepStatuses']
  counts: Readonly<{ phases: number; delegations: number; steps: number; completed: number }>
}>

export type PlanCommandErrorCode =
  | 'invalid-plan'
  | 'no-active-plan'
  | 'approval-already-decided'
  | 'stale-plan'
  | 'unknown-step'
  | 'invalid-transition'
  | 'plan-not-approved'
  | 'artifact-unavailable'
  | 'revision-conflict'

type PlanResponseIdentity = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
}>

export type PlanResponseCommand =
  | (PlanResponseIdentity & Readonly<{ decision: 'approved' | 'rejected'; feedback?: never }>)
  | (PlanResponseIdentity & Readonly<{ feedback: string; decision?: never }>)

const PLAN_APPROVAL_RESPONSE =
  /^(?:approve|approved|go ahead|proceed|looks good|do it|continue)[.!]?$/i

export const isPlanApprovalResponse = (text: string): boolean =>
  PLAN_APPROVAL_RESPONSE.test(text.trim())

export class PlanCommandError extends Error {
  constructor(
    readonly code: PlanCommandErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PlanCommandError'
  }
}

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PlanCommandError('invalid-plan', `${label} must be non-empty.`)
  }
  return value
}

export const createPlanDocumentV1 = (input: GeneratePlanContent): PlanDocumentV1 => {
  requireText(input.task_summary, 'task_summary')
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new PlanCommandError('invalid-plan', 'A Plan requires at least one phase.')
  }
  const titles = new Set<string>()
  for (const phase of input.phases) {
    requireText(phase.name, 'phase name')
    if (!Array.isArray(phase.delegations) || phase.delegations.length === 0) {
      throw new PlanCommandError('invalid-plan', 'Each phase requires at least one delegation.')
    }
    for (const delegation of phase.delegations) {
      requireText(delegation.name, 'delegation name')
      if (!Array.isArray(delegation.steps) || delegation.steps.length === 0) {
        throw new PlanCommandError('invalid-plan', 'Each delegation requires at least one step.')
      }
      for (const step of delegation.steps) {
        requireText(step.title, 'step title')
        requireText(step.description, 'step description')
        if (titles.has(step.title)) {
          throw new PlanCommandError('invalid-plan', `Duplicate step title: ${step.title}`)
        }
        titles.add(step.title)
      }
    }
  }
  if (!Array.isArray(input.desired_outputs)) {
    throw new PlanCommandError('invalid-plan', 'desired_outputs must be an array.')
  }
  input.desired_outputs.forEach((output) => requireText(output, 'desired output'))
  if (!['high', 'medium', 'low'].includes(input.feasibility?.confidence)) {
    throw new PlanCommandError('invalid-plan', 'feasibility confidence is invalid.')
  }
  requireText(input.feasibility.rationale, 'feasibility rationale')
  return { schema_version: 1, ...input }
}

export const planStepTitles = (document: PlanDocumentV1): string[] =>
  document.phases.flatMap((phase) =>
    phase.delegations.flatMap((delegation) => delegation.steps.map((step) => step.title))
  )

export const derivePlanLifecycle = (
  document: PlanDocumentV1,
  approval: SessionPlanApproval,
  statuses: Readonly<Record<string, Readonly<{ status: SessionPlanStepStatus }>>>,
  interactionIsLive = false
): PlanLifecycle => {
  if (approval === 'pending') return 'awaiting_approval'
  if (approval === 'rejected') return 'rejected'
  const values = planStepTitles(document).map((title) => statuses[title]?.status)
  if (values.every((status) => status === 'completed' || status === 'skipped')) return 'completed'
  if (values.includes('in_progress')) return interactionIsLive ? 'in_progress' : 'interrupted'
  return 'approved'
}
