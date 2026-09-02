/**
 * job-notifier.ts — emits compute_done notifications for finished jobs.
 *
 * Triggered from three terminal outcomes (design §8):
 *  1. harvest_clean: harvestedAt set, harvestError null
 *  2. harvest_failed: harvestedAt set, harvestError non-null
 *  3. execution error: status='error' (dispatch never succeeded, no harvest dir)
 *
 * This module is EMIT-ONLY (design §2):
 *  - writes notifiedAt to DB (persistent inbox, survives restart)
 *  - broadcasts updated JobSummary via broadcastJobUpdated (reuses COMPUTE_JOB_UPDATED_CHANNEL)
 *  - does NOT write notificationConsumedAt (that belongs to issue 05 renderer-side)
 *  - does NOT start any analysis turn or wait-broker
 *
 * Idempotency: if job.notified_at is already set, returns immediately without re-emitting.
 *
 * Payload shape aligns with spec §11.3:
 *  { job_id, provider_id, status, exit_code,
 *    featured_files, featured_file_count,
 *    left_on_remote_count, left_on_remote }
 *
 * Paths are workspace-relative (hpc/<jobId>/featured/...) per design §4.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { ComputeJob, JobSummary } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './harvest-engine'
import { workspaceRelativePath } from './workspace-path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobNotifierDeps = {
  jobRepository: Pick<ComputeJobRepository, 'claimNotification'>
  hostRepository: Pick<ComputeHostRepository, 'get'>
  storageRoot: string
  // Injectable broadcast function; defaults to the production broadcastJobUpdated.
  // Injected in tests to capture the emitted summary without touching Electron IPC.
  broadcast: (summary: JobSummary) => void
}

export type JobNotificationProjectionDeps = Pick<JobNotifierDeps, 'hostRepository' | 'storageRoot'>

// The compute_done payload fields embedded into the JobSummary broadcast (spec §11.3).
export type ComputeDonePayload = {
  featured_files: string[]
  featured_file_count: number
  left_on_remote_count: number
  left_on_remote: Array<{ uri: string; size_mb: number; reason: string }>
}

// ---------------------------------------------------------------------------
// Payload builder: scans the harvest directory for featured files
// ---------------------------------------------------------------------------

/**
 * Scans the job's local harvest directory and builds the compute_done payload.
 * Returns empty arrays if the directory does not exist (e.g. execution-error jobs).
 *
 * featured_files: relative paths under hpc/<jobId>/featured/ (workspace-relative).
 * featured_file_count: total featured file count (scandir).
 * left_on_remote_count / left_on_remote: from job.left_on_remote JSON column.
 */
export const buildComputeDonePayload = async (
  job: ComputeJob,
  storageRoot: string
): Promise<ComputeDonePayload> => {
  const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
  const featuredDir = join(harvestDir, 'featured')

  // Workspace root for computing relative paths (everything under <workspaceCwd>).
  // getJobHarvestDir returns <workspaceCwd>/hpc/<jobId>, so two levels up is workspaceCwd.
  const workspaceCwd = join(harvestDir, '..', '..')

  // Scan featured dir — may not exist for error jobs or if harvest failed before creating it.
  let featuredFiles: string[] = []
  if (!job.harvest_error) {
    try {
      const entries = await readdirRecursive(featuredDir)
      featuredFiles = entries.map((abs) => workspaceRelativePath(workspaceCwd, abs))
    } catch {
      // Directory does not exist or is unreadable — emit an empty list.
    }
  }

  // Parse left_on_remote from the job DB column (JSON array).
  let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
  if (job.left_on_remote) {
    try {
      leftOnRemote = JSON.parse(job.left_on_remote) as typeof leftOnRemote
    } catch {
      // Malformed — treat as empty.
    }
  }

  return {
    featured_files: featuredFiles,
    featured_file_count: featuredFiles.length,
    left_on_remote_count: leftOnRemote.length,
    left_on_remote: leftOnRemote
  }
}

// ---------------------------------------------------------------------------
// Recursive readdir helper (returns absolute paths of all files)
// ---------------------------------------------------------------------------

const readdirRecursive = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await readdirRecursive(full)))
    } else {
      results.push(full)
    }
  }
  return results
}

/**
 * Rebuilds the complete durable notification projection without claiming or broadcasting it.
 * Release certification and recovery checks use this same production projector to prove that
 * cleanup leaves every payload field readable, including the locally harvested featured files.
 */
export const buildJobNotificationSummary = async (
  job: ComputeJob,
  deps: JobNotificationProjectionDeps
): Promise<JobSummary> => {
  let displayName = job.provider_id
  try {
    const host = await deps.hostRepository.get(job.provider_id)
    if (host) displayName = host.displayName
  } catch {
    // Transient lookup failure — fall back to provider_id so projection remains available.
  }

  const payload = await buildComputeDonePayload(job, deps.storageRoot)
  return {
    job_id: job.job_id,
    provider_id: job.provider_id,
    project_id: job.project_id,
    display_name: displayName,
    shape: job.shape,
    session_id: job.session_id,
    status: job.status,
    cancellation_status: job.cancellation_status,
    intent: job.intent,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    exit_code: job.exit_code,
    error_code: job.error_code,
    last_poll_error: job.last_poll_error,
    remote_workdir: job.remote_workdir,
    stdout_tail: job.stdout_tail,
    stderr_tail: job.stderr_tail,
    notified_at: job.notified_at,
    notification_consumed_at: job.notification_consumed_at,
    featured_files: payload.featured_files,
    featured_file_count: payload.featured_file_count,
    left_on_remote_count: payload.left_on_remote_count,
    left_on_remote: payload.left_on_remote,
    harvest_error: job.harvest_error
  }
}

// ---------------------------------------------------------------------------
// Main emitter
// ---------------------------------------------------------------------------

/**
 * Emits a compute_done notification for a job that has reached a final resting state.
 * Idempotent: if job.notified_at is already set, returns immediately.
 *
 * Steps:
 *  1. Check idempotency guard.
 *  2. Claim notification delivery and read the current row.
 *  3. Build payload from that claimed row (scan harvest dir + parse leftOnRemote column).
 *  4. Broadcast updated job summary (carrying payload fields + notified_at).
 *
 * This is EMIT-ONLY — does not touch notificationConsumedAt (issue 05).
 */
export const emitJobNotification = async (
  job: ComputeJob,
  deps: JobNotifierDeps
): Promise<void> => {
  const { jobRepository, hostRepository, storageRoot, broadcast } = deps

  // Idempotency: do not re-emit if already notified.
  if (job.notified_at != null) return

  // Persist notifiedAt as a compare-and-set claim. Every notification entrance uses this seam, so
  // overlapping stale projections cannot both broadcast. The returned row is also the freshness
  // fence for every field used below: a caller may have entered with a pre-harvest projection.
  const notifiedAt = new Date()
  const updatedJob = await jobRepository.claimNotification(job.job_id, notifiedAt)
  if (!updatedJob) return

  // Broadcast the summary with notification payload fields embedded. Reuses
  // COMPUTE_JOB_UPDATED_CHANNEL via the injected broadcast fn (no new IPC channel).
  const summary = await buildJobNotificationSummary(updatedJob, { hostRepository, storageRoot })

  broadcast(summary)
}
