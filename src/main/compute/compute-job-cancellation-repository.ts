import type { Prisma, PrismaClient } from '@prisma/client'

import type { ComputeJobCancellationStatus, ComputeJobStatus } from '../../shared/compute'

type CancellationClient = Pick<PrismaClient, '$transaction' | 'computeJobCancellation'>
type CancellationClientProvider = () => Promise<CancellationClient>

type CancellationState = 'requested' | 'claimed' | 'retry_wait' | 'confirmed' | 'superseded'

type CancellationRecord = Readonly<{
  jobId: string
  state: CancellationState
  revision: number
  attempt: number
  nextAttemptAt: Date | null
  leaseToken: string | null
  leaseExpiresAt: Date | null
  lastError: string | null
  requestedAt: Date
  claimedAt: Date | null
  confirmedAt: Date | null
  supersededAt: Date | null
  updatedAt: Date
}>

type CancellationScope = Readonly<{
  projectId: string
  sessionId: string
  providerId: string
}>

type ClaimedCancellation = Readonly<{
  cancellation: CancellationRecord
  job: {
    id: string
    providerId: string
    status: ComputeJobStatus
    remoteWorkdir: string | null
    remoteHandle: string | null
  }
}>

const ACTIVE_STATUSES = ['queued', 'submitted', 'running'] as const
const TERMINAL_STATUSES = ['success', 'failed', 'timeout', 'error'] as const

const asState = (value: string): CancellationState => {
  const states: CancellationState[] = [
    'requested',
    'claimed',
    'retry_wait',
    'confirmed',
    'superseded'
  ]
  if (!states.includes(value as CancellationState)) {
    throw new Error(`Invalid Compute Job cancellation state: ${value}`)
  }
  return value as CancellationState
}

const asJobStatus = (value: string): ComputeJobStatus => value as ComputeJobStatus

const toRecord = (row: {
  jobId: string
  state: string
  revision: number
  attempt: number
  nextAttemptAt: Date | null
  leaseToken: string | null
  leaseExpiresAt: Date | null
  lastError: string | null
  requestedAt: Date
  claimedAt: Date | null
  confirmedAt: Date | null
  supersededAt: Date | null
  updatedAt: Date
}): CancellationRecord => ({ ...row, state: asState(row.state) })

const cancellationStatus = (
  cancellation: Pick<CancellationRecord, 'state'> | null | undefined
): ComputeJobCancellationStatus | undefined => {
  if (!cancellation || cancellation.state === 'superseded') return undefined
  return cancellation.state === 'confirmed' ? 'cancelled' : 'cancelling'
}

class ComputeJobCancellationRepository {
  constructor(private readonly getClient: CancellationClientProvider) {}

  async get(jobId: string): Promise<CancellationRecord | null> {
    const client = await this.getClient()
    const row = await client.computeJobCancellation.findUnique({ where: { jobId } })
    return row ? toRecord(row) : null
  }

  // The Job owner tuple, terminal check, and sidecar insert share one SQLite transaction. This is
  // the request linearization point used by polling, dispatch, and queue-promotion CAS predicates.
  async request(
    jobId: string,
    scope: CancellationScope,
    now: Date
  ): Promise<
    { found: false } | { found: true; jobStatus: ComputeJobStatus; record: CancellationRecord }
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

      const existing = await transaction.computeJobCancellation.findUnique({ where: { jobId } })
      if (existing) {
        return {
          found: true,
          jobStatus: asJobStatus(job.status),
          record: toRecord(existing)
        } as const
      }

      const terminal = (TERMINAL_STATUSES as readonly string[]).includes(job.status)
      const queued = job.status === 'queued'
      const row = await transaction.computeJobCancellation.create({
        data: {
          jobId,
          state: terminal ? 'superseded' : queued ? 'confirmed' : 'requested',
          revision: 1,
          attempt: 0,
          requestedAt: now,
          updatedAt: now,
          ...(terminal ? { supersededAt: now } : {}),
          ...(queued ? { confirmedAt: now } : {})
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
    })
  }

  async claimNext(
    now: Date,
    leaseMs: number,
    leaseToken: string
  ): Promise<ClaimedCancellation | null> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      // A terminal observation that committed before the cancellation request always wins.
      const terminal = await transaction.computeJobCancellation.findFirst({
        where: {
          state: { in: ['requested', 'claimed', 'retry_wait'] },
          job: { is: { status: { in: [...TERMINAL_STATUSES] } } }
        },
        orderBy: { requestedAt: 'asc' }
      })
      if (terminal) {
        await transaction.computeJobCancellation.updateMany({
          where: { jobId: terminal.jobId, revision: terminal.revision },
          data: {
            state: 'superseded',
            revision: { increment: 1 },
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            confirmedAt: null,
            supersededAt: now,
            updatedAt: now
          }
        })
      }

      const candidate = await transaction.computeJobCancellation.findFirst({
        where: {
          job: { is: { status: { in: [...ACTIVE_STATUSES] } } },
          OR: [
            { state: 'requested' },
            { state: 'retry_wait', nextAttemptAt: { lte: now } },
            { state: 'claimed', leaseExpiresAt: { lte: now } }
          ]
        },
        orderBy: { requestedAt: 'asc' }
      })
      if (!candidate) return null

      const claimed = await transaction.computeJobCancellation.updateMany({
        where: { jobId: candidate.jobId, revision: candidate.revision, state: candidate.state },
        data: {
          state: 'claimed',
          revision: { increment: 1 },
          attempt: { increment: 1 },
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          nextAttemptAt: null,
          claimedAt: now,
          lastError: null,
          updatedAt: now
        }
      })
      if (claimed.count === 0) return null
      const row = await transaction.computeJobCancellation.findUniqueOrThrow({
        where: { jobId: candidate.jobId },
        include: { job: true }
      })
      return {
        cancellation: toRecord(row),
        job: {
          id: row.job.id,
          providerId: row.job.providerId,
          status: asJobStatus(row.job.status),
          remoteWorkdir: row.job.remoteWorkdir,
          remoteHandle: row.job.remoteHandle
        }
      }
    })
  }

  async confirm(claim: ClaimedCancellation, now: Date): Promise<boolean> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const terminalized = await transaction.computeJob.updateMany({
        where: {
          id: claim.job.id,
          status: { in: [...ACTIVE_STATUSES] },
          cancellation: {
            is: {
              state: 'claimed',
              revision: claim.cancellation.revision,
              leaseToken: claim.cancellation.leaseToken
            }
          }
        },
        data: { status: 'failed', finishedAt: now }
      })
      if (terminalized.count === 0) return false
      const confirmed = await transaction.computeJobCancellation.updateMany({
        where: {
          jobId: claim.cancellation.jobId,
          state: 'claimed',
          revision: claim.cancellation.revision,
          leaseToken: claim.cancellation.leaseToken
        },
        data: {
          state: 'confirmed',
          revision: { increment: 1 },
          leaseToken: null,
          leaseExpiresAt: null,
          confirmedAt: now,
          supersededAt: null,
          nextAttemptAt: null,
          lastError: null,
          updatedAt: now
        }
      })
      if (confirmed.count !== 1) {
        throw new Error('Cancellation confirmation lost its ownership claim')
      }
      return true
    })
  }

  async retry(
    claim: ClaimedCancellation,
    now: Date,
    nextAttemptAt: Date,
    error: string
  ): Promise<boolean> {
    return this.settleClaim(claim, {
      state: 'retry_wait',
      confirmedAt: null,
      supersededAt: null,
      nextAttemptAt,
      lastError: error.slice(0, 2_000),
      updatedAt: now
    })
  }

  private async settleClaim(
    claim: ClaimedCancellation,
    data: Prisma.ComputeJobCancellationUpdateManyMutationInput
  ): Promise<boolean> {
    const client = await this.getClient()
    const result = await client.computeJobCancellation.updateMany({
      where: {
        jobId: claim.cancellation.jobId,
        state: 'claimed',
        revision: claim.cancellation.revision,
        leaseToken: claim.cancellation.leaseToken
      },
      data: {
        ...data,
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null
      }
    })
    return result.count === 1
  }
}

export { ComputeJobCancellationRepository, cancellationStatus }
export type {
  CancellationClient,
  CancellationClientProvider,
  CancellationRecord,
  CancellationScope,
  CancellationState,
  ClaimedCancellation
}
