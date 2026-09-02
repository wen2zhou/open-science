import type { AgentResultDelivery as PrismaAgentResultDelivery, PrismaClient } from '@prisma/client'

import type {
  AgentResultDelivery,
  AgentResultDeliveryContext,
  AgentResultDeliveryState,
  ComputeJobAgentResultDeliveryContext,
  LocalRunAgentResultWaitingContext,
  LocalRunAgentResultDeliveryContext,
  TerminalAgentResultDeliveryContext
} from '../../shared/agent-result-delivery'

type DeliveryClient = Pick<PrismaClient, 'agentResultDelivery' | '$transaction'>

type ComputeJobDeliveryRegistration = Readonly<{
  jobId: string
  projectId: string
  sessionId: string
  providerId: string
  displayName: string
  title?: string
  acceptedAt?: number
}>

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

  async registerComputeJob(
    registration: ComputeJobDeliveryRegistration
  ): Promise<AgentResultDelivery> {
    const client = await this.getClient()
    const context: AgentResultDeliveryContext = {
      sourceKind: 'compute-job',
      jobId: registration.jobId,
      executionType: 'compute-job',
      terminalStatus: 'waiting-result',
      projectId: registration.projectId,
      sessionId: registration.sessionId,
      computeHost: {
        providerId: registration.providerId,
        displayName: registration.displayName
      },
      ...(registration.title ? { title: registration.title } : {}),
      ...(registration.acceptedAt === undefined ? {} : { acceptedAt: registration.acceptedAt })
    }
    const row = await client.agentResultDelivery.upsert({
      where: {
        sourceKind_sourceId: { sourceKind: 'compute-job', sourceId: registration.jobId }
      },
      create: {
        id: `compute-job:${registration.jobId}`,
        sourceKind: 'compute-job',
        sourceId: registration.jobId,
        projectId: registration.projectId,
        sessionId: registration.sessionId,
        executionType: 'compute-job',
        terminalStatus: 'waiting-result',
        contextJson: JSON.stringify(context),
        state: 'waiting-result'
      },
      update: {}
    })
    if (
      row.projectId !== registration.projectId ||
      row.sessionId !== registration.sessionId ||
      row.executionType !== 'compute-job'
    ) {
      throw new Error(`Conflicting delivery registration for Compute Job ${registration.jobId}.`)
    }
    return toDelivery(row)
  }

  async registerLocalRun(context: LocalRunAgentResultWaitingContext): Promise<AgentResultDelivery> {
    const client = await this.getClient()
    const row = await client.agentResultDelivery.upsert({
      where: { sourceKind_sourceId: { sourceKind: 'local-run', sourceId: context.runId } },
      create: {
        id: `local-run:${context.runId}`,
        sourceKind: 'local-run',
        sourceId: context.runId,
        projectId: context.projectId,
        sessionId: context.sessionId,
        agentFrameId: context.agentFrameId,
        executionType: context.executionType,
        terminalStatus: 'waiting-result',
        contextJson: JSON.stringify(context),
        state: 'waiting-result'
      },
      update: {}
    })
    if (row.projectId !== context.projectId || row.sessionId !== context.sessionId) {
      throw new Error(`Conflicting delivery registration for background Run ${context.runId}.`)
    }
    return toDelivery(row)
  }

  async hasComputeJobDeliveryPath(jobId: string): Promise<boolean> {
    const client = await this.getClient()
    return (
      (await client.agentResultDelivery.count({
        where: { sourceKind: 'compute-job', sourceId: jobId }
      })) > 0
    )
  }

  async listWaitingComputeJobIds(): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.agentResultDelivery.findMany({
      where: { sourceKind: 'compute-job', state: 'waiting-result' },
      select: { sourceId: true },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(({ sourceId }) => sourceId)
  }

  async recordTerminalOutcome(
    context: LocalRunAgentResultDeliveryContext
  ): Promise<AgentResultDelivery>
  async recordTerminalOutcome(
    context: ComputeJobAgentResultDeliveryContext
  ): Promise<AgentResultDelivery | undefined>
  async recordTerminalOutcome(
    context: TerminalAgentResultDeliveryContext
  ): Promise<AgentResultDelivery | undefined> {
    const client = await this.getClient()
    const contextJson = JSON.stringify(context)
    if (context.sourceKind === 'compute-job') {
      const updated = await client.agentResultDelivery.updateMany({
        where: {
          sourceKind: 'compute-job',
          sourceId: context.jobId,
          state: 'waiting-result'
        },
        data: {
          terminalStatus: context.terminalStatus,
          contextJson,
          state: 'pending'
        }
      })
      const row = await client.agentResultDelivery.findUnique({
        where: { sourceKind_sourceId: { sourceKind: 'compute-job', sourceId: context.jobId } }
      })
      if (!row) return undefined
      if (updated.count === 0 && row.contextJson !== contextJson) {
        throw new Error(`Conflicting terminal outcome for Compute Job ${context.jobId}.`)
      }
      return toDelivery(row)
    }
    const id = `local-run:${context.runId}`
    const updated = await client.agentResultDelivery.updateMany({
      where: { sourceKind: 'local-run', sourceId: context.runId, state: 'waiting-result' },
      data: {
        terminalStatus: context.terminalStatus,
        contextJson,
        state: 'pending'
      }
    })
    const existing = await client.agentResultDelivery.findUnique({
      where: { sourceKind_sourceId: { sourceKind: 'local-run', sourceId: context.runId } }
    })
    if (existing) {
      if (updated.count === 0 && existing.contextJson !== contextJson) {
        throw new Error(`Conflicting terminal outcome for background Run ${context.runId}.`)
      }
      return toDelivery(existing)
    }
    const row = await client.agentResultDelivery.create({
      data: {
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
      }
    })
    return toDelivery(row)
  }

  async listProjectVisible(projectId: string, limit = 200): Promise<AgentResultDelivery[]> {
    const client = await this.getClient()
    const rows = await client.agentResultDelivery.findMany({
      where: {
        projectId,
        state: { in: ['waiting-result', 'pending', 'claimed', 'needs-attention'] }
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 201))
    })
    return rows.map(toDelivery)
  }

  async projectRevision(projectId: string): Promise<number> {
    const client = await this.getClient()
    const row = await client.agentResultDelivery.findFirst({
      where: { projectId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: { updatedAt: true }
    })
    return row?.updatedAt.getTime() ?? 0
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
export type { ComputeJobDeliveryRegistration, DeliveryClient }
