import { randomUUID } from 'node:crypto'

import {
  ComputeHostUnavailableError,
  type ComputeJob,
  type ComputeJobCleanupReason,
  type ComputeJobCleanupReceipt
} from '../../shared/compute'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import {
  ComputeJobOperationRepository,
  type ClaimedComputeJobOperation,
  type ComputeJobOperationScope
} from './compute-job-operation-repository'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { parseRemoteJobHandle, parseRemoteJobWorkdir } from './remote-job-handle'
import {
  runRemoteComputeJobCleanup,
  verifyRemoteComputeJobWorkspaceAbsent
} from './compute-job-cleanup-remote'
import { decodeManagedRemoteUriPath } from './managed-remote-uri'

const TERMINAL_STATUSES = new Set<ComputeJob['status']>(['success', 'failed', 'timeout', 'error'])

const receipt = (
  jobId: string,
  outcome: ComputeJobCleanupReceipt['outcome'],
  options: Partial<Omit<ComputeJobCleanupReceipt, 'job_id' | 'outcome'>> = {}
): ComputeJobCleanupReceipt => ({
  job_id: jobId,
  outcome,
  workspace_removed: false,
  deleted_object_count: 0,
  retained_object_counts: {},
  retained_object_count_unknown: false,
  retry_recommended: false,
  retry_conditions: [],
  disposition: 'No remote objects were deleted.',
  ...options
})

const relativeRemotePath = (workdir: string, absolutePath: string): string | undefined => {
  const prefix = `${workdir}/`
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : undefined
}

const parseLeftOnRemotePaths = (job: ComputeJob): Set<string> => {
  const paths = new Set<string>()
  if (!job.left_on_remote || !job.remote_workdir) return paths
  try {
    const entries = JSON.parse(job.left_on_remote) as Array<{ uri?: string }>
    for (const entry of entries) {
      if (!entry.uri) continue
      const relative = relativeRemotePath(job.remote_workdir, decodeManagedRemoteUriPath(entry.uri))
      if (relative) paths.add(relative)
    }
  } catch {
    // Malformed historical evidence cannot authorize deletion.
  }
  return paths
}

class ComputeJobCleanupOwner {
  private readonly inFlight = new Map<string, Promise<ComputeJobCleanupReceipt>>()

  constructor(
    private readonly operations: ComputeJobOperationRepository,
    private readonly jobs: Pick<ComputeJobRepository, 'get' | 'admitCleanup'>,
    private readonly hosts: Pick<ComputeHostRepository, 'get'>,
    private readonly connectionBroker: ComputeConnectionBrokerAcquirer,
    private readonly now: () => Date = () => new Date()
  ) {}

  private settlementLostReceipt(jobId: string): ComputeJobCleanupReceipt {
    return receipt(jobId, 'indeterminate', {
      retained_object_counts: { remote_state_uncertain: 1 },
      retained_object_count_unknown: true,
      retry_recommended: true,
      retry_conditions: ['host_reachable'],
      disposition:
        'Cleanup finished after its durable operation claim changed; read the latest Job state before retrying.'
    })
  }

  private async settleOrReadAuthoritative(
    claim: ClaimedComputeJobOperation,
    candidate: ComputeJobCleanupReceipt,
    indeterminate = false
  ): Promise<ComputeJobCleanupReceipt> {
    if (await this.operations.settleCleanup(claim, candidate, this.now(), indeterminate)) {
      return candidate
    }
    try {
      const latest = await this.operations.get(claim.jobId, 'cleanup')
      if (latest?.phase === 'settled' && latest.receipt) return latest.receipt
      if (latest?.phase === 'active' && latest.receipt?.outcome === 'indeterminate') {
        return latest.receipt
      }
    } catch {
      // The caller still needs a conservative result when the authoritative operation cannot be read.
    }
    return this.settlementLostReceipt(claim.jobId)
  }

  async recoverIndeterminate(): Promise<void> {
    const operations = await this.operations.findIndeterminateCleanup(this.now())
    for (const operation of operations) {
      const claim = await this.operations.claimCleanup(operation, this.now(), 35_000, randomUUID())
      if (!claim || !operation.receipt) continue
      const keepPending = async (): Promise<void> => {
        await this.operations.settleCleanup(claim, operation.receipt!, this.now(), true)
      }
      try {
        const job = await this.jobs.get(operation.jobId)
        if (!job) {
          await keepPending()
          continue
        }
        const workdir = parseRemoteJobWorkdir(job.job_id, job.remote_workdir)
        const host = await this.hosts.get(job.provider_id)
        if (!workdir || !host) {
          await keepPending()
          continue
        }
        const connection = await this.connectionBroker.acquire(job.provider_id, {
          intent: 'job_cleanup'
        })
        const absent = await verifyRemoteComputeJobWorkspaceAbsent(connection, {
          scratchRoot: host.scratchRoot?.trim() || '~',
          workdir
        })
        if (!absent) {
          await keepPending()
          continue
        }
        await this.operations.settleCleanup(
          claim,
          receipt(job.job_id, 'workspace_removed', {
            workspace_removed: true,
            disposition:
              'Startup recovery confirmed that the remote Job workspace is already absent.'
          }),
          this.now()
        )
      } catch {
        await keepPending()
      }
    }
  }

  async cleanup(
    jobId: string,
    scope: ComputeJobOperationScope,
    invocationId: string,
    signal?: AbortSignal
  ): Promise<ComputeJobCleanupReceipt> {
    await this.requireOwnedJob(jobId, scope)
    const inFlightKey = [jobId, scope.projectId, scope.sessionId, scope.providerId].join('\0')
    const existing = this.inFlight.get(inFlightKey)
    if (existing) return existing
    const cleanup = this.performCleanup(jobId, scope, invocationId, signal)
    this.inFlight.set(inFlightKey, cleanup)
    try {
      return await cleanup
    } finally {
      if (this.inFlight.get(inFlightKey) === cleanup) this.inFlight.delete(inFlightKey)
    }
  }

  private async performCleanup(
    jobId: string,
    scope: ComputeJobOperationScope,
    invocationId: string,
    signal?: AbortSignal
  ): Promise<ComputeJobCleanupReceipt> {
    const job = await this.requireOwnedJob(jobId, scope)
    if (!TERMINAL_STATUSES.has(job.status)) {
      return receipt(jobId, 'not_ready', {
        retained_object_counts: { source_job_active: 1 },
        retained_object_count_unknown: true,
        retry_recommended: true,
        retry_conditions: ['job_terminal'],
        disposition: 'The source Job is still active; no remote objects were modified.'
      })
    }
    const cancelledBeforeRemoteSubmission =
      job.status === 'failed' &&
      job.cancellation_status === 'cancelled' &&
      job.submitted_at === undefined &&
      job.started_at === undefined &&
      job.remote_handle === undefined
    if (
      !cancelledBeforeRemoteSubmission &&
      job.status !== 'error' &&
      job.harvested_at === undefined
    ) {
      return receipt(jobId, 'not_ready', {
        retained_object_counts: { harvest_pending: 1 },
        retained_object_count_unknown: true,
        retry_recommended: true,
        retry_conditions: ['harvest_settled'],
        disposition: 'Result collection has not settled; no remote objects were modified.'
      })
    }
    const workdir = parseRemoteJobWorkdir(job.job_id, job.remote_workdir) ?? undefined
    if (!cancelledBeforeRemoteSubmission && (!job.owner_marker || !workdir)) {
      return receipt(jobId, 'nothing_deleted', {
        retained_object_counts: { ownership_unproven: 1 },
        retained_object_count_unknown: true,
        retry_conditions: ['manual_review'],
        disposition: 'Remote workspace ownership could not be proven; all objects were retained.'
      })
    }
    const remoteHandle = parseRemoteJobHandle(job.remote_handle, workdir)
    if (
      !cancelledBeforeRemoteSubmission &&
      (job.status !== 'error' || job.remote_handle !== undefined) &&
      !remoteHandle
    ) {
      return receipt(jobId, 'nothing_deleted', {
        retained_object_counts: { ownership_unproven: 1 },
        retained_object_count_unknown: true,
        retry_conditions: ['manual_review'],
        disposition:
          'The tracked remote process identity could not be proven; all objects were retained.'
      })
    }

    const admitted = await this.jobs.admitCleanup(job.project_id, job.session_id, () =>
      this.operations.requestCleanup(jobId, scope, invocationId, this.now())
    )
    if (!admitted) {
      return receipt(jobId, 'not_ready', {
        retained_object_counts: { scope_deletion_active: 1 },
        retained_object_count_unknown: true,
        retry_recommended: true,
        retry_conditions: ['scope_deletion_finished'],
        disposition:
          'A containing Session or Project deletion is active; no remote objects were modified.'
      })
    }
    try {
      const requested = admitted.result
      if (!requested.found) throw new ComputeHostUnavailableError()
      if (requested.record.phase === 'settled' && requested.record.receipt)
        return requested.record.receipt
      if (
        requested.record.receipt?.outcome === 'indeterminate' &&
        requested.record.requestId === invocationId
      ) {
        // The same transport replay retries the conservative inventory instead of claiming success.
      }
      const claim = await this.operations.claimCleanup(
        requested.record,
        this.now(),
        35_000,
        randomUUID()
      )
      if (!claim) {
        const latest = await this.operations.get(jobId, 'cleanup')
        if (latest?.receipt) return latest.receipt
        return receipt(jobId, 'indeterminate', {
          retained_object_counts: { remote_state_uncertain: 1 },
          retained_object_count_unknown: true,
          retry_recommended: true,
          retry_conditions: ['host_reachable'],
          disposition:
            'Another cleanup attempt is active; read the latest Job state before retrying.'
        })
      }

      if (cancelledBeforeRemoteSubmission) {
        return this.settleOrReadAuthoritative(
          claim,
          receipt(jobId, 'nothing_deleted', {
            disposition:
              'The Job was cancelled before remote submission; no remote cleanup was required.'
          })
        )
      }
      if (!workdir || !job.owner_marker) throw new ComputeHostUnavailableError()

      const host = await this.hosts.get(job.provider_id)
      if (!host) throw new ComputeHostUnavailableError()
      const leftOnRemote = parseLeftOnRemotePaths({ ...job, remote_workdir: workdir })
      const activeReferences = await this.operations.findActiveReferences(jobId)
      const referenced = new Set(
        activeReferences
          .map(({ remotePath }) => relativeRemotePath(workdir, remotePath))
          .filter((path): path is string => path !== undefined)
      )
      const retainedPaths = new Set([...leftOnRemote, ...referenced])
      let result: Awaited<ReturnType<typeof runRemoteComputeJobCleanup>>
      try {
        const connection = await this.connectionBroker.acquire(job.provider_id, {
          intent: 'job_cleanup',
          signal
        })
        result = await runRemoteComputeJobCleanup(connection, {
          scratchRoot: host.scratchRoot?.trim() || '~',
          workdir,
          ownerMarker: job.owner_marker,
          ...(remoteHandle ? { trackedPid: remoteHandle.pid } : {}),
          candidates: (job.remote_object_evidence ?? []).filter(
            (candidate) => !retainedPaths.has(candidate.path)
          ),
          knownRetainedPaths: [...retainedPaths]
        })
      } catch {
        const uncertain = receipt(jobId, 'indeterminate', {
          retained_object_counts: { remote_state_uncertain: 1 },
          retained_object_count_unknown: true,
          retry_recommended: true,
          retry_conditions: ['host_reachable'],
          disposition:
            'The remote cleanup result could not be confirmed; inspect the latest Job state and retry.'
        })
        return this.settleOrReadAuthoritative(claim, uncertain, true)
      }

      if (result.verification === 'ownership_unproven') {
        const denied = receipt(jobId, 'nothing_deleted', {
          retained_object_counts: { ownership_unproven: 1 },
          retained_object_count_unknown: true,
          retry_conditions: ['manual_review'],
          disposition: 'Remote workspace ownership could not be proven; all objects were retained.'
        })
        return this.settleOrReadAuthoritative(claim, denied)
      }
      if (result.verification === 'source_active') {
        const notReady = receipt(jobId, 'not_ready', {
          retained_object_counts: { source_job_active: 1 },
          retained_object_count_unknown: true,
          retry_recommended: true,
          retry_conditions: ['job_terminal'],
          disposition:
            'The tracked source process is still active; no remote objects were modified.'
        })
        return this.settleOrReadAuthoritative(claim, notReady)
      }
      const retained: Partial<Record<ComputeJobCleanupReason, number>> = {}
      if (referenced.size > 0) retained.active_downstream_reference = referenced.size
      if (leftOnRemote.size > 0) retained.only_remote_copy = leftOnRemote.size
      const unknownCount = result.unknownObjectCount + result.mismatchedCandidateCount
      if (unknownCount > 0) retained.unknown_or_changed_object = unknownCount
      const outcome = result.workspaceRemoved
        ? 'workspace_removed'
        : result.deletedObjectCount > 0
          ? 'partially_cleaned'
          : 'nothing_deleted'
      const settled = receipt(jobId, outcome, {
        workspace_removed: result.workspaceRemoved,
        deleted_object_count: result.deletedObjectCount,
        retained_object_counts: retained,
        retry_recommended: referenced.size > 0,
        retry_conditions: referenced.size > 0 ? ['downstream_terminal'] : [],
        disposition: result.workspaceRemoved
          ? 'The verified remote Job workspace was removed.'
          : result.deletedObjectCount > 0
            ? 'Safe remote objects were deleted; protected or unknown objects remain.'
            : 'No remote object could currently be proven safe to delete.'
      })
      return this.settleOrReadAuthoritative(claim, settled)
    } finally {
      admitted.release()
    }
  }

  private async requireOwnedJob(
    jobId: string,
    scope: ComputeJobOperationScope
  ): Promise<ComputeJob> {
    const job = await this.jobs.get(jobId)
    if (
      !job ||
      job.project_id !== scope.projectId ||
      job.session_id !== scope.sessionId ||
      job.provider_id !== scope.providerId
    ) {
      throw new ComputeHostUnavailableError()
    }
    return job
  }
}

export { ComputeJobCleanupOwner }
