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

export type PlanResponseCommand = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
  decision: 'approved' | 'rejected'
}>

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
  return value.trim()
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const createPlanDocumentV1 = (input: unknown): PlanDocumentV1 => {
  if (!isRecord(input)) {
    throw new PlanCommandError('invalid-plan', 'Plan document must be an object.')
  }
  if ('schema_version' in input && input.schema_version !== 1) {
    throw new PlanCommandError('invalid-plan', 'schema_version must be 1.')
  }
  const taskSummary = requireText(input.task_summary, 'task_summary')
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new PlanCommandError('invalid-plan', 'A Plan requires at least one phase.')
  }
  const titles = new Set<string>()
  const phases = input.phases.map((phaseValue) => {
    const phase = isRecord(phaseValue) ? phaseValue : {}
    const name = requireText(phase.name, 'phase name')
    if (!Array.isArray(phase.delegations) || phase.delegations.length === 0) {
      throw new PlanCommandError('invalid-plan', 'Each phase requires at least one delegation.')
    }
    const delegations = phase.delegations.map((delegationValue) => {
      const delegation = isRecord(delegationValue) ? delegationValue : {}
      const delegationName = requireText(delegation.name, 'delegation name')
      if (!Array.isArray(delegation.steps) || delegation.steps.length === 0) {
        throw new PlanCommandError('invalid-plan', 'Each delegation requires at least one step.')
      }
      const steps = delegation.steps.map((stepValue) => {
        const step = isRecord(stepValue) ? stepValue : {}
        const title = requireText(step.title, 'step title')
        const description = requireText(step.description, 'step description')
        if (titles.has(title)) {
          throw new PlanCommandError('invalid-plan', `Duplicate step title: ${title}`)
        }
        titles.add(title)
        return { title, description }
      })
      return { name: delegationName, steps }
    })
    return { name, delegations }
  })
  if (!Array.isArray(input.desired_outputs)) {
    throw new PlanCommandError('invalid-plan', 'desired_outputs must be an array.')
  }
  const desiredOutputs = input.desired_outputs.map((output) =>
    requireText(output, 'desired output')
  )
  const feasibility = isRecord(input.feasibility) ? input.feasibility : {}
  if (!['high', 'medium', 'low'].includes(feasibility.confidence as string)) {
    throw new PlanCommandError('invalid-plan', 'feasibility confidence is invalid.')
  }
  const rationale = requireText(feasibility.rationale, 'feasibility rationale')
  return {
    schema_version: 1,
    task_summary: taskSummary,
    phases,
    desired_outputs: desiredOutputs,
    feasibility: { confidence: feasibility.confidence as PlanConfidence, rationale }
  }
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
