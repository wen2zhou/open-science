import type { JobSummary } from '../../../shared/compute'

// Formats elapsed milliseconds as "Xm Ys" (e.g. "3m 33s") or "Xs" for under a minute.
export const formatDuration = (ms: number): string => {
  const totalSecs = Math.max(0, Math.floor(ms / 1000))
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

// Returns the elapsed time in ms for a job, measuring from started_at (or created_at as fallback).
export const jobElapsedMs = (job: JobSummary, now: number): number => {
  const start = job.started_at ?? job.created_at
  return now - start
}

// A terminal diagnostic the UI can render distinctly (issue 04 cross-cutting: failure hints must be
// actionable, not collapsed into one generic error). `tone` drives colour; `title` is the short label;
// `detail` is a one-line human explanation the job detail view shows below the status.
// `info` is the one NON-terminal tone: a scheduler job that is queued and has told us why. It is not
// a failure, so it must not read like one, but leaving it silent is what made a queued job
// indistinguishable from a stuck one.
export type JobDiagnostic = {
  tone: 'success' | 'failed' | 'timeout' | 'cancelled' | 'error' | 'info' | 'neutral'
  title: string
  detail: string
}

// Slurm pending reasons that mean "waiting for capacity" rather than "something is wrong with the
// request". These get the resource-sizing hint, because the usual cause is a request the partition
// cannot grant — most often an unset memory request, which claims a whole node on many clusters and
// silently serializes jobs that were meant to run concurrently.
const CAPACITY_WAIT_REASONS = new Set([
  'RESOURCES',
  'PRIORITY',
  'NODES_REQUIRED_FOR_JOB',
  'REQNODENOTAVAIL',
  'PARTITION_NODE_LIMIT',
  'PARTITION_TIME_LIMIT'
])

// Maps a job's status + error_code + scheduler remote_state to a distinct, actionable diagnostic.
//
// The cross-provider `status` intentionally collapses several scheduler outcomes (OOM, preemption,
// node failure) into `failed`, so the UI must consult `remote_state` (Slurm's native state name) to
// tell them apart. Likewise `cancelled` vs `timeout` vs dispatch `error` each get their own message.
//
// Slurm remote states of interest (design.md §4.4, issue 03 finding #2):
//   OUT_OF_MEMORY → the job exceeded its memory allocation (raise memoryMib).
//   PREEMPTED     → a higher-priority job reclaimed the node (resubmit; consider a longer QOS).
//   NODE_FAIL     → the compute node failed mid-run (resubmit; not your workload's fault).
//   TIMEOUT       → walltime exceeded (raise timeLimitSeconds or shorten the workload).
export const jobDiagnostic = (job: JobSummary): JobDiagnostic => {
  const rs = (job.remote_state ?? '').toUpperCase()

  switch (job.status) {
    case 'success':
      return { tone: 'success', title: 'Finished', detail: 'The job completed successfully.' }

    case 'cancelled':
      return {
        tone: 'cancelled',
        title: 'Cancelled',
        detail: 'You cancelled this job. Any files already written to the workdir were harvested.'
      }

    case 'timeout':
      return {
        tone: 'timeout',
        title: 'Timed out',
        detail:
          rs === 'TIMEOUT'
            ? 'The scheduler killed the job at its walltime limit. Raise the time limit or shorten the workload.'
            : 'The job exceeded its Open Science time limit. Raise timeout_seconds or shorten the workload.'
      }

    case 'failed': {
      // Scheduler-originated failures share `failed` status but differ by remote_state.
      if (rs === 'OUT_OF_MEMORY') {
        return {
          tone: 'failed',
          title: 'Out of memory',
          detail:
            'The scheduler killed the job for exceeding its memory allocation. Increase the requested memory and resubmit.'
        }
      }
      if (rs === 'PREEMPTED') {
        return {
          tone: 'failed',
          title: 'Preempted',
          detail:
            'A higher-priority job reclaimed the node. This is not a workload error — resubmit, optionally on a non-preemptible QOS.'
        }
      }
      if (rs === 'NODE_FAIL' || rs === 'BOOT_FAIL') {
        return {
          tone: 'failed',
          title: 'Node failure',
          detail:
            'The compute node failed during the run. This is a cluster fault, not your workload — resubmit.'
        }
      }
      if (rs === 'DEADLINE') {
        return {
          tone: 'failed',
          title: 'Deadline exceeded',
          detail:
            'The job hit the partition/QOS deadline before completing. Resubmit within limits.'
        }
      }
      return {
        tone: 'failed',
        title: 'Failed',
        detail:
          job.exit_code !== undefined
            ? `The workload exited with a non-zero status (exit code ${job.exit_code}). Check stderr for details.`
            : 'The workload failed. Check stderr for details.'
      }
    }

    case 'error':
      // Dispatch / infrastructure error — distinct from a workload failure. error_code disambiguates.
      if (job.error_code === 'host_unreachable') {
        return {
          tone: 'error',
          title: 'Host unreachable',
          detail:
            'Open Science could not reach the host to dispatch or observe this job. This is a connectivity error, not a workload failure — check the host and retry.'
        }
      }
      if (job.error_code === 'dispatch_failed') {
        return {
          tone: 'error',
          title: 'Dispatch error',
          detail:
            'The job could not be submitted to the backend. No trustworthy remote result exists. Check the host configuration and retry.'
        }
      }
      if (job.error_code === 'invalid_directives') {
        return {
          tone: 'error',
          title: 'Script rejected',
          detail:
            'The job was refused before it reached the cluster: a scheduler directive the runner owns, one that duplicates a structured resource, or a command that submits its own job. Read stderr for which, then fix the command and resubmit.'
        }
      }
      if (job.error_code === 'process_vanished') {
        return {
          tone: 'error',
          title: 'Process vanished',
          detail:
            'The remote process disappeared before writing an exit marker. The result is indeterminate — inspect the workdir and retry.'
        }
      }
      return {
        tone: 'error',
        title: 'Error',
        detail:
          'Dispatch, persistence, or recovery failed before a trustworthy remote result existed. Retry the job.'
      }

    default: {
      // Non-terminal states (queued / submitted / running) have no terminal diagnostic — but a
      // scheduler job parked in the queue does have something to say. Without this the UI showed a
      // motionless `submitted` badge whether the job was waiting its turn or genuinely wedged.
      const reason = job.queue_reason?.trim()
      if (reason && job.status !== 'running') {
        const capacity = CAPACITY_WAIT_REASONS.has(reason.toUpperCase())
        return {
          tone: 'info',
          title: 'Queued — waiting for resources.',
          detail: capacity
            ? 'The cluster has not allocated a slot yet. If this persists, the request may be larger than the partition can grant — an unset memory request claims the whole node on many clusters.'
            : 'The scheduler is holding this job. See the reason below; it usually points at a partition, account, or QOS limit.'
        }
      }
      return { tone: 'neutral', title: '', detail: '' }
    }
  }
}

// Whether a job can be cancelled: only non-terminal (queued / submitted / running) jobs (design.md §6).
export const canCancelJob = (job: JobSummary): boolean =>
  job.status === 'queued' || job.status === 'submitted' || job.status === 'running'

// Whether a job can be cleaned up: only terminal AND harvested jobs (design.md §6). Cleanup deletes
// only the job's own workdir; it is never offered for running or un-harvested jobs.
const TERMINAL_STATUSES = new Set(['success', 'failed', 'timeout', 'cancelled', 'error'])
export const canCleanupJob = (job: JobSummary): boolean =>
  TERMINAL_STATUSES.has(job.status) && job.harvested_at !== undefined && job.harvested_at !== null
