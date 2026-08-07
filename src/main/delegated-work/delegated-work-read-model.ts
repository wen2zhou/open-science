import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import { DelegatedWorkProjectionOwner } from './delegated-work-projection'
import type {
  AuthenticatedDelegateCaller,
  DelegatedWorkDurableRecords,
  DurableChildSummary,
  DurableDelegateResult,
  DurableSnapshot
} from './durable-delegated-work'

type DurableChild = DurableSnapshot['records'][number]

class DelegatedWorkReadModel {
  constructor(
    private readonly records: DelegatedWorkDurableRecords,
    private readonly projections: DelegatedWorkProjectionOwner,
    private readonly collectPollIntervalMs: number
  ) {}

  async children(
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): Promise<readonly DurableChildSummary[]> {
    const snapshot = await this.authenticatedSnapshot(caller)
    return this.selectAuthorizedChildren(snapshot, caller, frameIds).map((child) => {
      const attempt = currentAttempt(child)
      return {
        frameId: child.frameId,
        attemptId: attempt.id,
        title: child.title,
        name: child.title,
        agentName:
          attempt.resolvedAgent.kind === 'specialist'
            ? attempt.resolvedAgent.displayName
            : 'Main Agent',
        status: attempt.status
      }
    })
  }

  async collect(
    caller: AuthenticatedDelegateCaller,
    frameIds: readonly string[]
  ): Promise<readonly DurableDelegateResult[]> {
    if (!Array.isArray(frameIds) || frameIds.length === 0) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'collect requires at least one child'
      )
    }
    for (;;) {
      const snapshot = await this.authenticatedSnapshot(caller)
      const children = this.selectAuthorizedChildren(snapshot, caller, frameIds)
      const results = await Promise.all(
        children.map((child) => this.projections.projectSnapshotResult(snapshot, child))
      )
      if (results.every((result) => result !== undefined)) {
        return results as readonly DurableDelegateResult[]
      }
      await new Promise((resolve) => setTimeout(resolve, this.collectPollIntervalMs))
    }
  }

  async findAuthorizedChild(
    caller: AuthenticatedDelegateCaller,
    frameId: string
  ): Promise<DurableChild> {
    const snapshot = await this.records.snapshot()
    const child = snapshot.records.find(
      (candidate) =>
        sameSession(snapshot.session, caller.session) &&
        candidate.frameId === frameId &&
        candidate.parentFrameId === caller.frameId
    )
    if (caller.role !== 'main' || !child) {
      throw new DurableDelegatedWorkError('authorization', 'caller cannot access delegated child')
    }
    return child
  }

  private async authenticatedSnapshot(
    caller: AuthenticatedDelegateCaller
  ): Promise<DurableSnapshot> {
    const snapshot = await this.records.snapshot()
    if (
      caller.role !== 'main' ||
      !sameSession(snapshot.session, caller.session) ||
      caller.frameId !== snapshot.rootFrameId ||
      !snapshot.originMessageIds.includes(caller.originMessageId) ||
      !caller.toolInvocationId.trim()
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegated children are outside the authenticated parent conversation'
      )
    }
    return snapshot
  }

  private selectAuthorizedChildren(
    snapshot: DurableSnapshot,
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): readonly DurableChild[] {
    const directChildren = snapshot.records.filter(
      (child) => child.parentFrameId === caller.frameId
    )
    if (!frameIds) return directChildren
    const selected = frameIds.map((frameId) =>
      directChildren.find((child) => child.frameId === frameId)
    )
    if (selected.some((child) => !child)) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'one or more requested children are outside the authenticated parent conversation'
      )
    }
    return selected as readonly DurableChild[]
  }
}

export { DelegatedWorkReadModel }
