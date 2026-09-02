import type { AgentResultDelivery as PrismaAgentResultDelivery, PrismaClient } from '@prisma/client'

import type {
  AgentResultDelivery,
  AgentResultDeliveryContext,
  AgentResultDeliveryState
} from '../../shared/agent-result-delivery'

type DeliveryClient = Pick<PrismaClient, 'agentResultDelivery' | '$transaction'>

const dateMs = (value: Date | null): number | undefined => value?.getTime()

const decodeContext = (value: string): AgentResultDeliveryContext => {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Agent result delivery context is corrupt.')
  }
  return parsed as AgentResultDeliveryContext
}

const toDelivery = (row: PrismaAgentResultDelivery): AgentResultDelivery => ({
  id: row.id,
  state: row.state as AgentResultDeliveryState,
  context: decodeContext(row.contextJson),
  attemptCount: row.attemptCount,
  ...(row.claimToken ? { claimToken: row.claimToken } : {}),
  ...(dateMs(row.claimExpiresAt) === undefined
    ? {}
    : { claimExpiresAt: dateMs(row.claimExpiresAt) }),
  ...(row.continuationMessageId ? { continuationMessageId: row.continuationMessageId } : {}),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  ...(dateMs(row.consumedAt) === undefined ? {} : { consumedAt: dateMs(row.consumedAt) }),
  ...(dateMs(row.dismissedAt) === undefined ? {} : { dismissedAt: dateMs(row.dismissedAt) })
})

class AgentResultDeliveryRepository {
  constructor(private readonly getClient: () => Promise<DeliveryClient>) {}

  async recordTerminalOutcome(context: AgentResultDeliveryContext): Promise<AgentResultDelivery> {
    const client = await this.getClient()
    const contextJson = JSON.stringify(context)
    const id = `local-run:${context.runId}`
    const row = await client.agentResultDelivery.upsert({
      where: { sourceKind_sourceId: { sourceKind: 'local-run', sourceId: context.runId } },
      create: {
        id,
        sourceKind: 'local-run',
        sourceId: context.runId,
        projectId: context.projectId,
        sessionId: context.sessionId,
        agentFrameId: context.agentFrameId,
        executionType: context.executionType,
        terminalStatus: context.terminalStatus,
        contextJson,
        state: 'pending'
      },
      update: {}
    })
    if (row.contextJson !== contextJson) {
      throw new Error(`Conflicting terminal outcome for background Run ${context.runId}.`)
    }
    return toDelivery(row)
  }

  async listAwaitingAgent(sessionId: string): Promise<AgentResultDelivery[]> {
    const client = await this.getClient()
    const rows = await client.agentResultDelivery.findMany({
      where: {
        sessionId,
        state: { in: ['pending', 'claimed', 'needs-attention'] }
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(toDelivery)
  }

  async listPendingSessionIds(): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.agentResultDelivery.findMany({
      where: { state: 'pending' },
      distinct: ['sessionId'],
      select: { sessionId: true },
      orderBy: { sessionId: 'asc' }
    })
    return rows.map(({ sessionId }) => sessionId)
  }

  async find(id: string): Promise<AgentResultDelivery | undefined> {
    const client = await this.getClient()
    const row = await client.agentResultDelivery.findUnique({ where: { id } })
    return row ? toDelivery(row) : undefined
  }

  async recoverExpiredClaims(now = Date.now()): Promise<number> {
    const client = await this.getClient()
    const recovered = await client.agentResultDelivery.updateMany({
      where: { state: 'claimed', claimExpiresAt: { lte: new Date(now) } },
      data: { state: 'pending', claimToken: null, claimExpiresAt: null }
    })
    return recovered.count
  }

  async claimPending(
    sessionId: string,
    options: { token: string; expiresAt: number; limit: number; now?: number }
  ): Promise<AgentResultDelivery[]> {
    const client = await this.getClient()
    const now = options.now ?? Date.now()
    return client.$transaction(async (tx) => {
      await tx.agentResultDelivery.updateMany({
        where: { state: 'claimed', claimExpiresAt: { lte: new Date(now) } },
        data: { state: 'pending', claimToken: null, claimExpiresAt: null }
      })
      const candidates = await tx.agentResultDelivery.findMany({
        where: { sessionId, state: 'pending' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: Math.max(1, options.limit)
      })
      if (candidates.length === 0) return []
      const ids = candidates.map(({ id }) => id)
      await tx.agentResultDelivery.updateMany({
        where: { id: { in: ids }, state: 'pending' },
        data: {
          state: 'claimed',
          claimToken: options.token,
          claimExpiresAt: new Date(options.expiresAt),
          attemptCount: { increment: 1 }
        }
      })
      return (
        await tx.agentResultDelivery.findMany({
          where: { id: { in: ids }, state: 'claimed', claimToken: options.token },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        })
      ).map(toDelivery)
    })
  }

  async dismiss(sessionId: string, id: string, dismissedAt = Date.now()): Promise<boolean> {
    const client = await this.getClient()
    const updated = await client.agentResultDelivery.updateMany({
      where: {
        id,
        sessionId,
        state: { in: ['pending', 'needs-attention'] }
      },
      data: {
        state: 'dismissed',
        dismissedAt: new Date(dismissedAt),
        claimToken: null,
        claimExpiresAt: null
      }
    })
    return updated.count === 1
  }

  async releaseClaim(
    ids: readonly string[],
    claimToken: string,
    state: 'pending' | 'needs-attention'
  ): Promise<number> {
    const client = await this.getClient()
    const updated = await client.agentResultDelivery.updateMany({
      where: { id: { in: [...ids] }, state: 'claimed', claimToken },
      data: { state, claimToken: null, claimExpiresAt: null }
    })
    return updated.count
  }

  async markConsumed(
    ids: readonly string[],
    claimToken: string,
    continuationMessageId: string,
    consumedAt = Date.now()
  ): Promise<number> {
    const client = await this.getClient()
    const updated = await client.agentResultDelivery.updateMany({
      where: { id: { in: [...ids] }, state: 'claimed', claimToken },
      data: {
        state: 'consumed',
        claimToken: null,
        claimExpiresAt: null,
        continuationMessageId,
        consumedAt: new Date(consumedAt)
      }
    })
    return updated.count
  }
}

export { AgentResultDeliveryRepository }
export type { DeliveryClient }
