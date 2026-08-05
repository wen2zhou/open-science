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

export type PlanStepProjectionStatus = SessionPlanStepStatus | 'not_started' | 'not_run'

export type PlanStepProjection = Readonly<{
  status: PlanStepProjectionStatus
  notes?: string
}>

export type PlanLifecycle =
  | 'awaiting_approval'
  | 'approved'
  | 'in_progress'
  | 'interrupted'
  | 'blocked'
  | 'completed'
  | 'rejected'

export type ActivePlanProjection = Readonly<{
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  revision: number
  approval: SessionPlanApproval
  lifecycle: PlanLifecycle
  requiresExplicitContinuation: boolean
  document: PlanDocumentV1
  stepStatuses: SessionPlanRuntimeContext['stepStatuses']
  stepStates: Readonly<Record<string, PlanStepProjection>>
  counts: Readonly<{ phases: number; delegations: number; steps: number; completed: number }>
}>

const compactPlanContextText = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, 500)

export const formatPlanProtectedContext = (projection: ActivePlanProjection): string => {
  const steps = planStepTitles(projection.document).map((title) => {
    const state = projection.stepStates[title] ?? { status: 'not_started' as const }
    const notes = state.notes ? ` — ${compactPlanContextText(state.notes)}` : ''
    return `- ${compactPlanContextText(title)}: ${state.status}${notes}`
  })
  return [
    '<open_science_protected_plan_context>',
    `artifact_id=${projection.artifactId}`,
    `artifact_version_id=${projection.artifactVersionId}`,
    `artifact_checksum=${projection.artifactChecksum}`,
    `revision=${projection.revision} approval=${projection.approval} lifecycle=${projection.lifecycle}`,
    `task=${compactPlanContextText(projection.document.task_summary)}`,
    ...steps,
    'Do not execute this Plan without interaction-bound authority from Open Science.',
    '</open_science_protected_plan_context>'
  ].join('\n')
}

export const PLAN_COMMAND_ERROR_CODES = [
  'invalid-plan',
  'no-active-plan',
  'approval-already-decided',
  'stale-plan',
  'unknown-step',
  'invalid-transition',
  'dependency-not-satisfied',
  'plan-not-approved',
  'artifact-unavailable',
  'revision-conflict',
  'continuation-required',
  'interaction-mismatch'
] as const

export type PlanCommandErrorCode = (typeof PLAN_COMMAND_ERROR_CODES)[number]

export const isPlanCommandErrorCode = (value: unknown): value is PlanCommandErrorCode =>
  typeof value === 'string' && PLAN_COMMAND_ERROR_CODES.includes(value as PlanCommandErrorCode)

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

const PLAN_APPROVE_AND_CONTINUE_RESPONSE =
  /^(?:approve(?:d)?\s+(?:and|&)\s+(?:continue|proceed)|continue|proceed)[.!]?$/i

const PLAN_CONTINUATION_RESPONSE = /^(?:continue|proceed|resume(?:\s+(?:this|the)\s+plan)?)[.!]?$/i

export type PlanMessageIntent = 'none' | 'approve' | 'continue' | 'approve-and-continue'

export const isPlanApprovalResponse = (text: string): boolean =>
  PLAN_APPROVAL_RESPONSE.test(text.trim())

export const parsePlanMessageIntent = (
  text: string,
  approval: SessionPlanApproval
): PlanMessageIntent => {
  const normalized = text.trim()
  if (approval === 'pending') {
    if (PLAN_APPROVE_AND_CONTINUE_RESPONSE.test(normalized)) return 'approve-and-continue'
    return isPlanApprovalResponse(normalized) ? 'approve' : 'none'
  }
  if (approval === 'approved' && PLAN_CONTINUATION_RESPONSE.test(normalized)) return 'continue'
  return 'none'
}

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

export const parsePlanDocumentV1 = (input: unknown): PlanDocumentV1 => {
  if (!isRecord(input) || input.schema_version !== 1) {
    throw new PlanCommandError('invalid-plan', 'schema_version must be 1.')
  }
  return createPlanDocumentV1(input)
}

export const planStepTitles = (document: PlanDocumentV1): string[] =>
  document.phases.flatMap((phase) =>
    phase.delegations.flatMap((delegation) => delegation.steps.map((step) => step.title))
  )

export const projectPlanStepStates = (
  document: PlanDocumentV1,
  statuses: SessionPlanRuntimeContext['stepStatuses']
): Readonly<Record<string, PlanStepProjection>> => {
  const blockedPhaseIndex = document.phases.findIndex((phase) =>
    phase.delegations.some((delegation) =>
      delegation.steps.some((step) => statuses[step.title]?.status === 'blocked')
    )
  )
  return Object.fromEntries(
    document.phases.flatMap((phase, phaseIndex) =>
      phase.delegations.flatMap((delegation) => {
        const delegationStarted = delegation.steps.some(
          (step) => statuses[step.title] !== undefined
        )
        const delegationBlocked = delegation.steps.some(
          (step) => statuses[step.title]?.status === 'blocked'
        )
        return delegation.steps.map((step) => {
          const runtime = statuses[step.title]
          if (runtime) {
            return [
              step.title,
              { status: runtime.status, ...(runtime.notes ? { notes: runtime.notes } : {}) }
            ]
          }
          const unreachable =
            blockedPhaseIndex >= 0 &&
            (phaseIndex > blockedPhaseIndex ||
              (phaseIndex === blockedPhaseIndex && (!delegationStarted || delegationBlocked)))
          return [step.title, { status: unreachable ? 'not_run' : 'not_started' }]
        })
      })
    )
  )
}

export const isPlanComplete = (
  document: PlanDocumentV1,
  statuses: Readonly<Record<string, Readonly<{ status: SessionPlanStepStatus }>>>
): boolean =>
  planStepTitles(document).every((title) => {
    const status = statuses[title]?.status
    return status === 'completed' || status === 'skipped'
  })

export const derivePlanLifecycle = (
  document: PlanDocumentV1,
  approval: SessionPlanApproval,
  statuses: Readonly<Record<string, Readonly<{ status: SessionPlanStepStatus }>>>,
  interactionIsLive = false
): PlanLifecycle => {
  if (approval === 'pending') return 'awaiting_approval'
  if (approval === 'rejected') return 'rejected'
  const values = planStepTitles(document).map((title) => statuses[title]?.status)
  if (isPlanComplete(document, statuses)) return 'completed'
  if (values.includes('in_progress')) return interactionIsLive ? 'in_progress' : 'interrupted'
  if (values.includes('blocked')) return 'blocked'
  return 'approved'
}
