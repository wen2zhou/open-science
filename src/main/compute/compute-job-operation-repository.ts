import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import type { ComputeJobCleanupReceipt, ComputeJobStatus } from '../../shared/compute'

type OperationClient = Pick<
  PrismaClient,
  '$transaction' | 'computeJobOperation' | 'computeJobRemoteReference'
>
type OperationClientProvider = () => Promise<OperationClient>

type ComputeJobOperationKind = 'cancel' | 'cleanup'
type ComputeJobOperationPhase = 'active' | 'settled'
type ComputeJobOperationOutcome = 'fulfilled' | 'superseded'

type ComputeJobOperationRecord = Readonly<{
  id: string
  jobId: string
  kind: ComputeJobOperationKind
  phase: ComputeJobOperationPhase
  outcome: ComputeJobOperationOutcome | null
  revision: number
  attemptCount: number
  eligibleAt: Date | null
  claimToken: string | null
  claimExpiresAt: Date | null
  createdAt: Date
  settledAt: Date | null
  updatedAt: Date
  requestId: string | null
  receipt: ComputeJobCleanupReceipt | null
}>

type ComputeJobOperationScope = Readonly<{
  projectId: string
  sessionId: string
  providerId: string
}>

type ClaimedComputeJobOperation = Readonly<{
  operation: ComputeJobOperationRecord
  jobId: string
}>

const ACTIVE_STATUSES = ['queued', 'submitted', 'running'] as const
const TERMINAL_STATUSES = ['success', 'failed', 'timeout', 'error'] as const

const asKind = (value: string): ComputeJobOperationKind => {
  switch (value) {
    case 'cancel':
    case 'cleanup':
      return value
  }
  throw new Error(`Invalid Compute Job operation kind: ${value}`)
}

const asPhase = (value: string): ComputeJobOperationPhase => {
  switch (value) {
    case 'active':
    case 'settled':
      return value
  }
  throw new Error(`Invalid Compute Job operation phase: ${value}`)
}

const asOutcome = (value: string | null): ComputeJobOperationOutcome | null => {
  switch (value) {
    case null:
    case 'fulfilled':
    case 'superseded':
      return value
  }
  throw new Error(`Invalid Compute Job operation outcome: ${value}`)
}

const asJobStatus = (value: string): ComputeJobStatus => value as ComputeJobStatus

const toRecord = (row: {
  id: string
  jobId: string
  kind: string
  phase: string
  outcome: string | null
  revision: number
  attemptCount: number
  eligibleAt: Date | null
  claimToken: string | null
  claimExpiresAt: Date | null
  createdAt: Date
  settledAt: Date | null
  updatedAt: Date
  requestId: string | null
  receipt: string | null
}): ComputeJobOperationRecord => ({
  ...row,
  kind: asKind(row.kind),
  phase: asPhase(row.phase),
  outcome: asOutcome(row.outcome),
  receipt: row.receipt ? (JSON.parse(row.receipt) as ComputeJobCleanupReceipt) : null
})

class ComputeJobOperationRepository {
  constructor(private readonly getClient: OperationClientProvider) {}

  async get(
    jobId: string,
    kind: ComputeJobOperationKind
  ): Promise<ComputeJobOperationRecord | null> {
    const client = await this.getClient()
    const row = await client.computeJobOperation.findUnique({
      where: { jobId_kind: { jobId, kind } }
    })
    return row ? toRecord(row) : null
  }

  // This is the operation request linearization point. Kind-specific atomic job transitions stay
  // exhaustive here so a future kind must define its persistence semantics explicitly.
  async request(
    jobId: string,
    kind: 'cancel',
    scope: ComputeJobOperationScope,
    now: Date
  ): Promise<
    | { found: false }
    | { found: true; jobStatus: ComputeJobStatus; record: ComputeJobOperationRecord }
  > {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const job = await transaction.computeJob.findFirst({
        where: {
          id: jobId,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          providerId: scope.providerId
        },
        select: { status: true }
      })
      if (!job) return { found: false } as const

      const existing = await transaction.computeJobOperation.findUnique({
        where: { jobId_kind: { jobId, kind } }
      })
      if (existing) {
        return {
          found: true,
          jobStatus: asJobStatus(job.status),
          record: toRecord(existing)
        } as const
      }

      switch (kind) {
        case 'cancel': {
          const terminal = (TERMINAL_STATUSES as readonly string[]).includes(job.status)
          const queued = job.status === 'queued'
          const settled = terminal || queued
          const row = await transaction.computeJobOperation.create({
            data: {
              id: randomUUID(),
              jobId,
              kind,
              phase: settled ? 'settled' : 'active',
              outcome: terminal ? 'superseded' : queued ? 'fulfilled' : null,
              revision: 1,
              attemptCount: 0,
              createdAt: now,
              settledAt: settled ? now : null,
              updatedAt: now
            }
          })
          if (queued) {
            await transaction.computeJob.updateMany({
              where: { id: jobId, status: 'queued' },
              data: { status: 'failed', finishedAt: now }
            })
          }
          return {
            found: true,
            jobStatus: queued ? ('failed' as const) : asJobStatus(job.status),
            record: toRecord(row)
          } as const
        }
      }
    })
  }

  // `eligibleAt = null` is ready now; a non-null value delays retry until that instant.
  async claimNext(
    kind: 'cancel',
    now: Date,
    leaseMs: number,
    claimToken: string
  ): Promise<ClaimedComputeJobOperation | null> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      switch (kind) {
        case 'cancel': {
          const terminal = await transaction.computeJobOperation.findFirst({
            where: {
              kind,
              phase: 'active',
              job: { is: { status: { in: [...TERMINAL_STATUSES] } } }
            },
            orderBy: { createdAt: 'asc' }
          })
          if (terminal) {
            await transaction.computeJobOperation.updateMany({
              where: { id: terminal.id, revision: terminal.revision, phase: 'active' },
              data: {
                phase: 'settled',
                outcome: 'superseded',
                revision: { increment: 1 },
                eligibleAt: null,
                claimToken: null,
                claimExpiresAt: null,
                settledAt: now,
                updatedAt: now
              }
            })
          }
          break
        }
      }

      const candidate = await transaction.computeJobOperation.findFirst({
        where: {
          kind,
          phase: 'active',
          job: { is: { status: { in: [...ACTIVE_STATUSES] } } },
          OR: [
            {
              claimToken: null,
              claimExpiresAt: null,
              OR: [{ eligibleAt: null }, { eligibleAt: { lte: now } }]
            },
            { claimToken: { not: null }, claimExpiresAt: { lte: now } }
          ]
        },
        orderBy: { createdAt: 'asc' }
      })
      if (!candidate) return null

      const claimed = await transaction.computeJobOperation.updateMany({
        where: { id: candidate.id, revision: candidate.revision, phase: 'active' },
        data: {
          revision: { increment: 1 },
          attemptCount: { increment: 1 },
          eligibleAt: null,
          claimToken,
          claimExpiresAt: new Date(now.getTime() + leaseMs),
          updatedAt: now
        }
      })
      if (claimed.count === 0) return null
      const row = await transaction.computeJobOperation.findUniqueOrThrow({
        where: { id: candidate.id }
      })
      return { operation: toRecord(row), jobId: candidate.jobId }
    })
  }

  async requestCleanup(
    jobId: string,
    scope: ComputeJobOperationScope,
    requestId: string,
    now: Date
  ): Promise<{ found: false } | { found: true; record: ComputeJobOperationRecord }> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const job = await transaction.computeJob.findFirst({
        where: {
          id: jobId,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          providerId: scope.providerId
        },
        select: { id: true }
      })
      if (!job) return { found: false } as const
      const existing = await transaction.computeJobOperation.findUnique({
        where: { jobId_kind: { jobId, kind: 'cleanup' } }
      })
      if (!existing) {
        const created = await transaction.computeJobOperation.create({
          data: { id: randomUUID(), jobId, kind: 'cleanup', requestId, updatedAt: now }
        })
        return { found: true, record: toRecord(created) } as const
      }
      if (existing.phase === 'active' || existing.requestId === requestId) {
        return { found: true, record: toRecord(existing) } as const
      }
      const restarted = await transaction.computeJobOperation.update({
        where: { id: existing.id },
        data: {
          phase: 'active',
          outcome: null,
          revision: { increment: 1 },
          attemptCount: 0,
          eligibleAt: null,
          claimToken: null,
          claimExpiresAt: null,
          settledAt: null,
          requestId,
          receipt: null,
          updatedAt: now
        }
      })
      return { found: true, record: toRecord(restarted) } as const
    })
  }

  async claimCleanup(
    operation: ComputeJobOperationRecord,
    now: Date,
    leaseMs: number,
    claimToken: string
  ): Promise<ClaimedComputeJobOperation | null> {
    const client = await this.getClient()
    const claimed = await client.computeJobOperation.updateMany({
      where: {
        id: operation.id,
        kind: 'cleanup',
        phase: 'active',
        revision: operation.revision,
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }]
      },
      data: {
        revision: { increment: 1 },
        attemptCount: { increment: 1 },
        claimToken,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        receipt: null,
        updatedAt: now
      }
    })
    if (claimed.count !== 1) return null
    const row = await client.computeJobOperation.findUniqueOrThrow({ where: { id: operation.id } })
    return { operation: toRecord(row), jobId: operation.jobId }
  }

  async settleCleanup(
    claim: ClaimedComputeJobOperation,
    receipt: ComputeJobCleanupReceipt,
    now: Date,
    indeterminate = false
  ): Promise<boolean> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const receiptJson = JSON.stringify(receipt)
      const updated = await transaction.computeJobOperation.updateMany({
        where: {
          id: claim.operation.id,
          kind: 'cleanup',
          phase: 'active',
          revision: claim.operation.revision,
          claimToken: claim.operation.claimToken
        },
        data: indeterminate
          ? {
              revision: { increment: 1 },
              claimToken: null,
              claimExpiresAt: null,
              receipt: receiptJson,
              updatedAt: now
            }
          : {
              phase: 'settled',
              outcome: 'fulfilled',
              revision: { increment: 1 },
              eligibleAt: null,
              claimToken: null,
              claimExpiresAt: null,
              receipt: receiptJson,
              settledAt: now,
              updatedAt: now
            }
      })
      if (updated.count !== 1) return false
      await transaction.computeJob.update({
        where: { id: claim.jobId },
        data: { cleanupReceipt: receiptJson }
      })
      return true
    })
  }

  async findActiveReferences(jobId: string): Promise<Array<{ remotePath: string }>> {
    const client = await this.getClient()
    return client.computeJobRemoteReference.findMany({
      where: {
        producerJobId: jobId,
        consumer: { is: { status: { in: [...ACTIVE_STATUSES] } } }
      },
      select: { remotePath: true }
    })
  }

  async findIndeterminateCleanup(now: Date): Promise<ComputeJobOperationRecord[]> {
    const client = await this.getClient()
    const rows = await client.computeJobOperation.findMany({
      where: {
        kind: 'cleanup',
        phase: 'active',
        receipt: { not: null },
        OR: [
          { claimToken: null, claimExpiresAt: null },
          { claimToken: { not: null }, claimExpiresAt: { lte: now } }
        ]
      },
      orderBy: { updatedAt: 'asc' }
    })
    return rows.map(toRecord).filter(({ receipt }) => receipt?.outcome === 'indeterminate')
  }

  async fulfill(claim: ClaimedComputeJobOperation, now: Date): Promise<boolean> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      switch (claim.operation.kind) {
        case 'cancel': {
          const terminalized = await transaction.computeJob.updateMany({
            where: {
              id: claim.jobId,
              status: { in: [...ACTIVE_STATUSES] },
              operations: {
                some: {
                  id: claim.operation.id,
                  phase: 'active',
                  revision: claim.operation.revision,
                  claimToken: claim.operation.claimToken
                }
              }
            },
            data: { status: 'failed', finishedAt: now }
          })
          if (terminalized.count === 0) return false
          break
        }
      }

      const settled = await transaction.computeJobOperation.updateMany({
        where: {
          id: claim.operation.id,
          phase: 'active',
          revision: claim.operation.revision,
          claimToken: claim.operation.claimToken
        },
        data: {
          phase: 'settled',
          outcome: 'fulfilled',
          revision: { increment: 1 },
          eligibleAt: null,
          claimToken: null,
          claimExpiresAt: null,
          settledAt: now,
          updatedAt: now
        }
      })
      if (settled.count !== 1) throw new Error('Operation fulfillment lost its ownership claim')
      return true
    })
  }

  async retry(claim: ClaimedComputeJobOperation, now: Date, eligibleAt: Date): Promise<boolean> {
    const client = await this.getClient()
    const data: Prisma.ComputeJobOperationUpdateManyMutationInput = {
      revision: { increment: 1 },
      eligibleAt,
      claimToken: null,
      claimExpiresAt: null,
      updatedAt: now
    }
    const result = await client.computeJobOperation.updateMany({
      where: {
        id: claim.operation.id,
        phase: 'active',
        revision: claim.operation.revision,
        claimToken: claim.operation.claimToken
      },
      data
    })
    return result.count === 1
  }
}

export { ComputeJobOperationRepository }
export type {
  ClaimedComputeJobOperation,
  ComputeJobOperationKind,
  ComputeJobOperationOutcome,
  ComputeJobOperationPhase,
  ComputeJobOperationRecord,
  ComputeJobOperationScope,
  OperationClient,
  OperationClientProvider
}
