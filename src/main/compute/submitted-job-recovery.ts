import type { ComputeJob } from '../../shared/compute'
import { ComputeConnectionError, type ComputeConnectionLease } from './connection-broker'
import type { ComputeJobLifecycle } from './compute-job-lifecycle'
import { classifyComputeJobExit, probeRemoteLaunch } from './remote-launch-recovery'

// A valid recovery witness may observe the deterministic directory after mkdir but before job.pid
// is written. Require two consecutive observations before proving that launch was interrupted.
const DISPATCH_RECOVERY_PENDING_TICKS = 2

export type SubmittedJobRecoveryResult =
  | { kind: 'none' }
  | { kind: 'harvest'; job: ComputeJob }
  | { kind: 'notification'; job: ComputeJob }

/**
 * Owns the stateful policy for adopting submitted jobs after an interrupted dispatcher response.
 * The poller only supplies a durable Job and a shared provider connection, then acts on the small
 * result interface; protocol interpretation, retry sequencing, and lifecycle convergence stay
 * local to this module.
 */
export class SubmittedJobRecovery {
  private readonly pendingTicks = new Map<string, number>()

  constructor(private readonly lifecycle: ComputeJobLifecycle) {}

  async recordUnavailable(jobs: ComputeJob[], errorCode: string): Promise<void> {
    for (const job of jobs) {
      this.pendingTicks.delete(job.job_id)
      await this.lifecycle.recordPollError(job.job_id, 'submitted', errorCode)
    }
  }

  async recover(
    job: ComputeJob,
    connection: ComputeConnectionLease
  ): Promise<SubmittedJobRecoveryResult> {
    let observation
    try {
      observation = await probeRemoteLaunch(connection, job.remote_workdir!)
    } catch (error) {
      this.pendingTicks.delete(job.job_id)
      await this.lifecycle.recordPollError(
        job.job_id,
        'submitted',
        error instanceof ComputeConnectionError ? error.code : 'host_unreachable'
      )
      return { kind: 'none' }
    }

    if (observation.kind === 'running') {
      this.pendingTicks.delete(job.job_id)
      await this.lifecycle.dispatchRunning(job.job_id, JSON.stringify(observation.handle))
      return { kind: 'none' }
    }

    if (observation.kind === 'exited') {
      this.pendingTicks.delete(job.job_id)
      const { status, errorCode } = classifyComputeJobExit(job, observation.exitCode)
      const transition = await this.lifecycle.finishPolled(job.job_id, {
        status,
        exitCode: observation.exitCode,
        stdoutTail: null,
        stderrTail: null,
        errorCode
      })
      return transition.kind === 'applied'
        ? { kind: 'harvest', job: transition.job }
        : { kind: 'none' }
    }

    if (observation.kind === 'vanished') {
      this.pendingTicks.delete(job.job_id)
      const transition = await this.lifecycle.finishPolled(job.job_id, {
        status: 'failed',
        errorCode: 'process_vanished',
        stdoutTail: null,
        stderrTail: null
      })
      return transition.kind === 'applied'
        ? { kind: 'harvest', job: transition.job }
        : { kind: 'none' }
    }

    if (observation.kind === 'not_started') {
      this.pendingTicks.delete(job.job_id)
      return this.interrupt(job)
    }

    if (observation.kind === 'pending') {
      const ticks = (this.pendingTicks.get(job.job_id) ?? 0) + 1
      if (ticks >= DISPATCH_RECOVERY_PENDING_TICKS) {
        this.pendingTicks.delete(job.job_id)
        return this.interrupt(job)
      }
      this.pendingTicks.set(job.job_id, ticks)
      await this.lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_pending')
      return { kind: 'none' }
    }

    this.pendingTicks.delete(job.job_id)
    await this.lifecycle.recordPollError(job.job_id, 'submitted', 'dispatch_recovery_ambiguous')
    return { kind: 'none' }
  }

  async interrupt(job: ComputeJob): Promise<SubmittedJobRecoveryResult> {
    const transition = await this.lifecycle.recoverInterruptedDispatch(job.job_id)
    return transition.kind === 'applied'
      ? { kind: 'notification', job: transition.job }
      : { kind: 'none' }
  }
}
