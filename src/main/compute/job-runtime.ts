import { broadcastJobUpdated } from './ipc'
import { harvestJob } from './harvest-engine'
import { JobPoller, type JobPollerDeps } from './job-poller'
import type { ComputeJobDeletionOwner } from './job-deletion-owner'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeService } from './compute-service'
import type { ComputeConnectionBroker } from './connection-broker'
import { ComputeJobCancellationReaper } from './compute-job-cancellation-owner'
import type { ComputeJobCancellationRepository } from './compute-job-cancellation-repository'

type ComputeJobRuntime = { start(): void; stop(): Promise<void> }

type ComputeJobRuntimeDeps = {
  computeService: Pick<
    ComputeService,
    | 'handleJobUpdated'
    | 'handleJobCancellationConfirmed'
    | 'startQueueReconciliation'
    | 'stopQueueReconciliation'
  >
  jobDeletionOwner?: Pick<ComputeJobDeletionOwner, 'bindRuntime'>
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  cancellationRepository?: ComputeJobCancellationRepository
  connectionBroker: ComputeConnectionBroker
  storageRoot: string
}

type ComputeJobRuntimeAdapters = {
  broadcast?: typeof broadcastJobUpdated
  harvest?: typeof harvestJob
  createPoller?: (deps: JobPollerDeps) => ComputeJobRuntime & Pick<JobPoller, 'pause' | 'resume'>
  createCancellationReaper?: (
    repository: ComputeJobCancellationRepository
  ) => ComputeJobRuntime & Pick<ComputeJobCancellationReaper, 'pause' | 'resume'>
}

// Owns the production poller's complete job-update contract. Main-process startup supplies only the
// long-lived compute handles; every update is routed through ComputeService, while notifications and
// harvesting retain their dedicated projections.
export const createComputeJobRuntime = (
  deps: ComputeJobRuntimeDeps,
  adapters: ComputeJobRuntimeAdapters = {}
): ComputeJobRuntime => {
  const broadcast = adapters.broadcast ?? broadcastJobUpdated
  const harvest = adapters.harvest ?? harvestJob
  const pollerDeps: JobPollerDeps = {
    connectionBroker: deps.connectionBroker,
    hostRepository: deps.hostRepository,
    jobRepository: deps.jobRepository,
    onJobUpdated: deps.computeService.handleJobUpdated,
    broadcast,
    storageRoot: deps.storageRoot,
    harvestFn: (job) =>
      harvest(job, {
        connectionBroker: deps.connectionBroker,
        hostRepository: deps.hostRepository,
        jobRepository: deps.jobRepository,
        storageRoot: deps.storageRoot,
        broadcast
      })
  }

  const poller = adapters.createPoller?.(pollerDeps) ?? new JobPoller(pollerDeps)
  const cancellationReaper = deps.cancellationRepository
    ? (adapters.createCancellationReaper?.(deps.cancellationRepository) ??
      new ComputeJobCancellationReaper(deps.cancellationRepository, deps.connectionBroker, {
        onConfirmed: async (jobId) => {
          const job = await deps.jobRepository.get(jobId)
          if (!job) return
          try {
            await harvest(job, {
              connectionBroker: deps.connectionBroker,
              hostRepository: deps.hostRepository,
              jobRepository: deps.jobRepository,
              storageRoot: deps.storageRoot,
              broadcast
            })
          } finally {
            const latest = await deps.jobRepository.get(jobId)
            if (latest) await deps.computeService.handleJobCancellationConfirmed(latest)
          }
        }
      }))
    : undefined
  const deletionRuntime = {
    pause: async (): Promise<void> => {
      await Promise.all([poller.pause(), cancellationReaper?.pause()])
    },
    resume: (): void => {
      poller.resume()
      cancellationReaper?.resume()
    }
  }
  const unbindDeletionRuntime = deps.jobDeletionOwner?.bindRuntime(deletionRuntime)
  return {
    start: () => {
      poller.start()
      cancellationReaper?.start()
      deps.computeService.startQueueReconciliation()
    },
    stop: async () => {
      unbindDeletionRuntime?.()
      poller.stop()
      await cancellationReaper?.stop()
      await deps.computeService.stopQueueReconciliation()
    }
  }
}

export type { ComputeJobRuntime, ComputeJobRuntimeAdapters, ComputeJobRuntimeDeps }
