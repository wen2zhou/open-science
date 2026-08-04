import { createHash, randomUUID } from 'node:crypto'

import type {
  SessionPlanRuntimeContext,
  SessionPlanStepStatus,
  SessionRuntimeContext
} from '../../shared/session-persistence'
import {
  createPlanDocumentV1,
  derivePlanLifecycle,
  PlanCommandError,
  planStepTitles,
  type ActivePlanProjection,
  type GeneratePlanContent,
  type PlanDocumentV1
} from '../../shared/session-plan/contract'

type ArtifactWriteResult = Readonly<{
  artifactId?: string
  versionId?: string
  checksum?: string
  name: string
}>

type PlanServiceDependencies = Readonly<{
  writeArtifactForActiveTurn: (
    sessionId: string,
    input: { filename: string; content: string; mimeType: string }
  ) => Promise<ArtifactWriteResult>
  readArtifactVersion: (input: {
    projectId: string
    sessionId: string
    artifactId: string
    artifactVersionId: string
  }) => Promise<{ content: string; checksum: string }>
  readRuntimeContext: (projectId: string, sessionId: string) => Promise<SessionRuntimeContext>
  patchRuntimeContext: (input: {
    projectId: string
    sessionId: string
    expectedRevision: number
    plan: SessionPlanRuntimeContext
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle'
  }) => Promise<SessionRuntimeContext>
  now?: () => number
  createId?: () => string
}>

type PlanIdentityCommand = Readonly<{
  projectId: string
  sessionId: string
  artifactVersionId: string
  expectedRevision: number
}>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const parseDocument = (content: string): PlanDocumentV1 => {
  try {
    const parsed = JSON.parse(content) as PlanDocumentV1
    if (parsed.schema_version !== 1) throw new Error('unsupported schema')
    const { schema_version: _schemaVersion, ...candidate } = parsed
    return createPlanDocumentV1(candidate)
  } catch (error) {
    if (error instanceof PlanCommandError) throw error
    throw new PlanCommandError('artifact-unavailable', 'The active Plan Artifact is unreadable.')
  }
}

class PlanService {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly dependencies: PlanServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => randomUUID().slice(0, 8))
  }

  async generate(input: {
    projectId: string
    sessionId: string
    interactionId: string
    content: GeneratePlanContent
  }): Promise<{ projection: ActivePlanProjection; pauseInteraction: true }> {
    const document = createPlanDocumentV1(input.content)
    const serialized = JSON.stringify(document, null, 2)
    const artifact = await this.dependencies.writeArtifactForActiveTurn(input.sessionId, {
      filename: `plan-${this.createId()}.json`,
      content: serialized,
      mimeType: 'application/json'
    })
    if (!artifact.artifactId || !artifact.versionId || !artifact.checksum) {
      throw new PlanCommandError('artifact-unavailable', 'Plan Artifact provenance is incomplete.')
    }
    const verified = await this.dependencies.readArtifactVersion({
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId
    })
    if (
      verified.content !== serialized ||
      verified.checksum !== artifact.checksum ||
      sha256(verified.content) !== artifact.checksum
    ) {
      throw new PlanCommandError(
        'artifact-unavailable',
        'Plan Artifact checksum verification failed.'
      )
    }
    const current = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const plan: SessionPlanRuntimeContext = {
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId,
      artifactChecksum: artifact.checksum,
      approval: 'pending',
      stepStatuses: {}
    }
    let next: SessionRuntimeContext
    try {
      next = await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: current.revision,
        plan,
        sessionStatus: 'waiting-plan-approval'
      })
    } catch {
      throw new PlanCommandError('revision-conflict', 'The Session Plan changed concurrently.')
    }
    return { projection: this.project(document, plan, next.revision), pauseInteraction: true }
  }

  async respond(
    input: PlanIdentityCommand & Readonly<{ decision: 'approved' | 'rejected' }>
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }> {
    const { context, plan, document } = await this.loadActive(input)
    if (plan.approval === input.decision) {
      return { projection: this.project(document, plan, context.revision), changed: false }
    }
    if (plan.approval !== 'pending') {
      throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
    }
    const updated = { ...plan, approval: input.decision }
    const next = await this.patch(
      input,
      updated,
      input.decision === 'approved' ? 'running' : 'idle'
    )
    return { projection: this.project(document, updated, next.revision), changed: true }
  }

  async updateStepStatus(
    input: PlanIdentityCommand &
      Readonly<{ title: string; status: SessionPlanStepStatus; notes?: string }>
  ): Promise<{ projection: ActivePlanProjection; changed: boolean }> {
    const { context, plan, document } = await this.loadActive(input)
    if (plan.approval !== 'approved') {
      throw new PlanCommandError('plan-not-approved', 'The Plan must be approved before execution.')
    }
    if (!planStepTitles(document).includes(input.title)) {
      throw new PlanCommandError('unknown-step', `Unknown Plan step: ${input.title}`)
    }
    const previous = plan.stepStatuses[input.title]?.status
    const sameTerminal =
      previous === input.status && ['completed', 'blocked', 'skipped'].includes(input.status)
    if (sameTerminal) {
      return { projection: this.project(document, plan, context.revision), changed: false }
    }
    const valid =
      (!previous && (input.status === 'in_progress' || input.status === 'skipped')) ||
      (previous === 'in_progress' && ['in_progress', 'completed', 'blocked'].includes(input.status))
    if (!valid) throw new PlanCommandError('invalid-transition', 'Invalid Plan step transition.')
    const updated: SessionPlanRuntimeContext = {
      ...plan,
      stepStatuses: {
        ...plan.stepStatuses,
        [input.title]: {
          status: input.status,
          updatedAt: this.now(),
          ...(input.notes ? { notes: input.notes } : {})
        }
      }
    }
    const next = await this.patch(input, updated, 'running')
    return { projection: this.project(document, updated, next.revision), changed: true }
  }

  async getProjection(projectId: string, sessionId: string): Promise<ActivePlanProjection | null> {
    const context = await this.dependencies.readRuntimeContext(projectId, sessionId)
    if (!context.plan) return null
    const document = await this.readDocument(projectId, sessionId, context.plan)
    return this.project(document, context.plan, context.revision)
  }

  async checkTurnCompletion(input: {
    projectId: string
    sessionId: string
  }): Promise<{ allow: boolean; lifecycle?: ActivePlanProjection['lifecycle'] }> {
    const projection = await this.getProjection(input.projectId, input.sessionId)
    if (!projection || projection.approval !== 'approved') return { allow: true }
    return { allow: projection.lifecycle === 'completed', lifecycle: projection.lifecycle }
  }

  private async loadActive(input: PlanIdentityCommand): Promise<{
    context: SessionRuntimeContext
    plan: SessionPlanRuntimeContext
    document: PlanDocumentV1
  }> {
    const context = await this.dependencies.readRuntimeContext(input.projectId, input.sessionId)
    const plan = context.plan
    if (!plan) throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
    if (plan.artifactVersionId !== input.artifactVersionId) {
      throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
    }
    if (context.revision !== input.expectedRevision) {
      throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
    }
    return {
      context,
      plan,
      document: await this.readDocument(input.projectId, input.sessionId, plan)
    }
  }

  private async readDocument(
    projectId: string,
    sessionId: string,
    plan: SessionPlanRuntimeContext
  ): Promise<PlanDocumentV1> {
    const result = await this.dependencies.readArtifactVersion({
      projectId,
      sessionId,
      artifactId: plan.artifactId,
      artifactVersionId: plan.artifactVersionId
    })
    if (
      result.checksum !== plan.artifactChecksum ||
      sha256(result.content) !== plan.artifactChecksum
    ) {
      throw new PlanCommandError(
        'artifact-unavailable',
        'The active Plan Artifact failed verification.'
      )
    }
    return parseDocument(result.content)
  }

  private async patch(
    input: PlanIdentityCommand,
    plan: SessionPlanRuntimeContext,
    sessionStatus: 'waiting-plan-approval' | 'running' | 'idle'
  ): Promise<SessionRuntimeContext> {
    try {
      return await this.dependencies.patchRuntimeContext({
        projectId: input.projectId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        plan,
        sessionStatus
      })
    } catch {
      throw new PlanCommandError('revision-conflict', 'The Plan revision changed concurrently.')
    }
  }

  private project(
    document: PlanDocumentV1,
    plan: SessionPlanRuntimeContext,
    revision: number
  ): ActivePlanProjection {
    const titles = planStepTitles(document)
    return {
      artifactId: plan.artifactId,
      artifactVersionId: plan.artifactVersionId,
      artifactChecksum: plan.artifactChecksum,
      revision,
      approval: plan.approval,
      lifecycle: derivePlanLifecycle(document, plan.approval, plan.stepStatuses, true),
      document,
      stepStatuses: plan.stepStatuses,
      counts: {
        phases: document.phases.length,
        delegations: document.phases.reduce((sum, phase) => sum + phase.delegations.length, 0),
        steps: titles.length,
        completed: titles.filter((title) => plan.stepStatuses[title]?.status === 'completed').length
      }
    }
  }
}

export { PlanService }
export type { PlanServiceDependencies }
