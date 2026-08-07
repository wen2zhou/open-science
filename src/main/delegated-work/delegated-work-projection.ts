import type { ArtifactFile } from '../../shared/artifacts'
import type {
  DelegatedArtifactEvidence,
  DelegatedArtifactProjectionScope,
  DelegatedReviewEvidence,
  DelegatedWorkDurableRecords,
  DurableDelegateResult,
  DurableSnapshot,
  ReadOnlyAgentFrameDetail
} from './durable-delegated-work'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'

type DurableChild = DurableSnapshot['records'][number]
type DurableAttempt = DurableChild['attempts'][number]

class DelegatedWorkProjectionOwner {
  constructor(
    private readonly records: DelegatedWorkDurableRecords,
    private readonly artifactEvidence?: DelegatedArtifactEvidence,
    private readonly reviewEvidence?: DelegatedReviewEvidence
  ) {}

  attemptScope(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt
  ): DelegatedArtifactProjectionScope | undefined {
    const runtimeSegmentId = attempt.runtimeSegmentIds.at(-1)
    const promptMessages = snapshot.messages.filter(
      (message) => message.frameId === child.frameId && message.role === 'user'
    )
    const attemptIndex = child.attempts.findIndex((candidate) => candidate.id === attempt.id)
    const promptMessageId = promptMessages[attemptIndex]?.id
    if (!runtimeSegmentId || !promptMessageId) return undefined
    return {
      session: snapshot.session,
      executionId: attempt.id,
      attemptId: attempt.id,
      rootFrameId: snapshot.rootFrameId,
      agentFrameId: child.frameId,
      messageBranchId: child.messageBranchId,
      runtimeSegmentId,
      promptMessageId,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      runtimeSegmentIds: [...attempt.runtimeSegmentIds],
      ...(attempt.terminalMessageId ? { terminalMessageId: attempt.terminalMessageId } : {})
    }
  }

  async projectSnapshotResult(
    snapshot: DurableSnapshot,
    child: DurableChild
  ): Promise<DurableDelegateResult | undefined> {
    const attempt = currentAttempt(child)
    if (attempt.status === 'running') return undefined
    const terminalMessage = attempt.terminalMessageId
      ? snapshot.messages.find((message) => message.id === attempt.terminalMessageId)
      : undefined
    return {
      frameId: child.frameId,
      attemptId: attempt.id,
      status: attempt.status,
      ...(attempt.terminalMessageId ? { terminalMessageId: attempt.terminalMessageId } : {}),
      ...(terminalMessage ? { response: terminalMessage.content } : {}),
      artifactsCreated: await this.projectArtifacts(snapshot, child, attempt),
      ...(attempt.cancellationReason ? { cancellationReason: attempt.cancellationReason } : {}),
      ...(attempt.error ? { error: attempt.error } : {})
    }
  }

  async projectResult(frameId: string): Promise<DurableDelegateResult | undefined> {
    const snapshot = await this.records.snapshot()
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    return child ? this.projectSnapshotResult(snapshot, child) : undefined
  }

  async readAgentFrame(
    session: DurableSnapshot['session'],
    frameId: string
  ): Promise<ReadOnlyAgentFrameDetail | undefined> {
    const snapshot = await this.records.snapshot()
    if (!sameSession(snapshot.session, session)) return undefined
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    if (!child) return undefined
    const attempt = currentAttempt(child)
    const messages = await Promise.all(
      snapshot.messages
        .filter((message) => message.frameId === frameId)
        .map(async ({ id, role, content }) => {
          const owningAttempt = child.attempts.find(
            (candidate) => candidate.terminalMessageId === id
          )
          const artifacts = owningAttempt
            ? await this.projectArtifacts(snapshot, child, owningAttempt)
            : []
          const reviews =
            owningAttempt?.status === 'completed' && owningAttempt.terminalMessageId
              ? await this.reviewEvidence?.project({
                  session: snapshot.session,
                  attemptId: owningAttempt.id,
                  agentFrameId: child.frameId,
                  messageBranchId: child.messageBranchId,
                  terminalMessageId: owningAttempt.terminalMessageId,
                  artifactVersionIds: artifacts.flatMap((artifact) =>
                    artifact.versionId ? [artifact.versionId] : []
                  )
                })
              : undefined
          return Object.freeze({
            role,
            content,
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(reviews && reviews.length > 0 ? { reviews } : {})
          })
        })
    )
    return Object.freeze({
      frameId,
      title: child.title,
      status: attempt.status,
      resolvedAgent: Object.freeze(structuredClone(attempt.resolvedAgent)),
      messages: Object.freeze(messages)
    })
  }

  private async projectArtifacts(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt
  ): Promise<readonly ArtifactFile[]> {
    const scope = this.attemptScope(snapshot, child, attempt)
    return scope && this.artifactEvidence ? this.artifactEvidence.project(scope) : []
  }
}

export { DelegatedWorkProjectionOwner }
