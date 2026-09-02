import { randomUUID } from 'node:crypto'

import type {
  AgentResultDelivery,
  AgentResultDeliveryContext
} from '../../shared/agent-result-delivery'

type DeliveryRepository = {
  recordTerminalOutcome(context: AgentResultDeliveryContext): Promise<AgentResultDelivery>
  recoverExpiredClaims(now?: number): Promise<number>
  listPendingSessionIds(): Promise<string[]>
  claimPending(
    sessionId: string,
    options: { token: string; expiresAt: number; limit: number; now?: number }
  ): Promise<AgentResultDelivery[]>
  markConsumed(
    ids: readonly string[],
    claimToken: string,
    continuationMessageId: string,
    consumedAt?: number
  ): Promise<number>
  releaseClaim(
    ids: readonly string[],
    claimToken: string,
    state: 'pending' | 'needs-attention'
  ): Promise<number>
}

type ContinuationResult = Readonly<{
  stopReason: string
  continuationMessageId: string
}>

type AgentResultDeliveryOwnerOptions = Readonly<{
  repository: DeliveryRepository
  sendContinuation(request: {
    sessionId: string
    text: string
    deliveryIds: readonly string[]
  }): Promise<ContinuationResult>
  isContinuationSaved(request: {
    sessionId: string
    continuationMessageId: string
  }): Promise<boolean>
  canStartSessionTurn(sessionId: string): boolean | Promise<boolean>
  createId?: () => string
  now?: () => number
  claimLeaseMs?: number
  batchLimit?: number
  batchDelayMs?: number
}>

const buildDeliveryPrompt = (deliveries: readonly AgentResultDelivery[]): string => {
  const outcomes = deliveries.map(({ context }) => ({
    runId: context.runId,
    executionType: context.executionType,
    terminalStatus: context.terminalStatus,
    resultSummary: context.resultSummary,
    ...(context.errorGuidance ? { errorGuidance: context.errorGuidance } : {}),
    sessionId: context.sessionId,
    ...(context.agentFrameId ? { agentFrameId: context.agentFrameId } : {}),
    ...(context.provenance ? { provenance: context.provenance } : {})
  }))
  return [
    'Background execution outcomes are now available for this Session.',
    'Treat these as durable execution facts. Decide the next step from each outcome; do not rerun work unless your reasoning requires it.',
    JSON.stringify(outcomes)
  ].join('\n\n')
}

class AgentResultDeliveryOwner {
  private readonly createId: () => string
  private readonly now: () => number
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: AgentResultDeliveryOwnerOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  async enqueue(context: AgentResultDeliveryContext): Promise<AgentResultDelivery> {
    const delivery = await this.options.repository.recordTerminalOutcome(context)
    if (delivery.state !== 'pending' || this.scheduled.has(context.sessionId)) return delivery
    const timer = setTimeout(() => {
      this.scheduled.delete(context.sessionId)
      void this.drainSession(context.sessionId)
    }, this.options.batchDelayMs ?? 250)
    timer.unref?.()
    this.scheduled.set(context.sessionId, timer)
    return delivery
  }

  dispose(): void {
    for (const timer of this.scheduled.values()) clearTimeout(timer)
    this.scheduled.clear()
  }

  async recover(): Promise<void> {
    await this.options.repository.recoverExpiredClaims(this.now())
    for (const sessionId of await this.options.repository.listPendingSessionIds()) {
      await this.drainSession(sessionId)
    }
  }

  async drainSession(
    sessionId: string
  ): Promise<'idle' | 'queued' | 'consumed' | 'needs-attention'> {
    if (!(await this.options.canStartSessionTurn(sessionId))) return 'queued'
    const now = this.now()
    const claimToken = this.createId()
    const deliveries = await this.options.repository.claimPending(sessionId, {
      token: claimToken,
      expiresAt: now + (this.options.claimLeaseMs ?? 5 * 60_000),
      limit: this.options.batchLimit ?? 16,
      now
    })
    if (deliveries.length === 0) return 'idle'

    const ids = deliveries.map(({ id }) => id)
    try {
      const result = await this.options.sendContinuation({
        sessionId,
        text: buildDeliveryPrompt(deliveries),
        deliveryIds: ids
      })
      const saved =
        result.stopReason === 'end_turn' &&
        (await this.options.isContinuationSaved({
          sessionId,
          continuationMessageId: result.continuationMessageId
        }))
      if (!saved) {
        await this.options.repository.releaseClaim(ids, claimToken, 'needs-attention')
        return 'needs-attention'
      }
      const consumed = await this.options.repository.markConsumed(
        ids,
        claimToken,
        result.continuationMessageId,
        this.now()
      )
      if (consumed !== ids.length) {
        await this.options.repository.releaseClaim(ids, claimToken, 'needs-attention')
        return 'needs-attention'
      }
      return 'consumed'
    } catch {
      await this.options.repository.releaseClaim(ids, claimToken, 'needs-attention')
      return 'needs-attention'
    }
  }
}

export { AgentResultDeliveryOwner, buildDeliveryPrompt }
export type { AgentResultDeliveryOwnerOptions, ContinuationResult }
