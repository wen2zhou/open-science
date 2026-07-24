import type { ComputeJob, JobSummary } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import { parseRemoteHandle, type ParsedRemoteHandle } from '../../shared/remote-handle'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { emitJobNotification } from './job-notifier'
import {
  resolveJobDriver,
  type ComputeDriver,
  type ComputeDriverRegistry,
  type DriverJob,
  type RemoteObservation
} from './compute-driver'
import { DirectDriver } from './direct-driver'

// Polling interval: 15 seconds (design.md §8).
export const POLL_INTERVAL_MS = 15_000

// Consecutive ticks without exit_code before declaring process_vanished (design.md §8 §3).
const PROCESS_VANISHED_TICKS = 2

// Grace period added to timeout_seconds before the poller forcibly kills a still-running job
// (design.md §10). This gives the remote `timeout` command time to deliver SIGTERM+SIGKILL
// cleanly and write the exit_code file (exit 124) before the poller intervenes.
const POLLER_KILL_GRACE_SECONDS = 60

// Maximum concurrent harvest operations (design.md §3: concurrency limit 2).
const HARVEST_CONCURRENCY_LIMIT = 2

/**
 * Injectable harvest function type. The poller calls this for each terminal job that needs
 * harvesting (design §3). In production this is `harvestJob` from harvest-engine.ts.
 * Accepting the full job object lets the function access all fields without extra lookups.
 */
export type HarvestFn = (job: ComputeJob) => Promise<void>

export type JobPollerDeps = {
  runner: SshRunner
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted.
  onJobUpdated?: (job: ComputeJob) => void
  // Injectable timer for tests (defaults to global setInterval/clearInterval).
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
  // The compute driver registry used to resolve each job's snapshotted driver for batched polling
  // (design.md §4.2). When omitted the poller builds a per-provider DirectDriver from `runner` —
  // the only driver that existed before this seam — so legacy callers and tests keep working.
  driverRegistry?: ComputeDriverRegistry
  // Shared with the dispatcher so the poller can tell a job that is still actively dispatching
  // (in-flight in this process) from one orphaned by an app restart. Defaults to the shared tracker.
  dispatchTracker?: DispatchTracker
  // Injectable harvest function (design §3). When omitted, harvest is disabled (no-op).
  // In production, wire this to harvestJob from harvest-engine.ts.
  harvestFn?: HarvestFn
  /**
   * Broadcast hook for compute_done notification (issue 06).
   * Used when emitting the notification for execution-error jobs (dispatch_failed).
   * Harvest-triggered notifications use harvestFn's own broadcast dep.
   * When omitted, no notification is emitted for error-state jobs.
   */
  broadcast?: (summary: JobSummary) => void
  /**
   * Storage root for the workspace path (issue 06).
   * Required when broadcast is set; used to compute the harvest dir path.
   */
  storageRoot?: string
}

// Per-job vanish counter (lives here because the poller is the only thing that increments it).
type VanishState = { ticks: number }

// JobPoller runs in the main process, independent of any kernel lifetime. It polls all non-terminal
// jobs every 15 s, batching by provider to minimise SSH connections. App restart resumes from DB.
// In 3b it also drives harvest: on terminal transition it async-dispatches harvestFn (no-await),
// bounded by a concurrency semaphore of 2 and an in-flight dedup Set (design §3).
export class JobPoller {
  private handle: ReturnType<typeof setInterval> | undefined
  private readonly vanishCounters = new Map<string, VanishState>()

  // Injectable timers (tests override to control ticks synchronously).
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void
  // Per-provider driver cache so a poll tick reuses one DirectDriver instance rather than rebuilding
  // it for every provider when no registry is wired. Drivers are stateless across calls (the nonce is
  // generated per call), so caching is safe.
  private readonly directDriverCache = new Map<string, DirectDriver>()
  // Shared dispatch tracker (see JobPollerDeps.dispatchTracker).
  private readonly dispatchTracker: DispatchTracker
  // Optional injectable harvest function (design §3).
  private readonly harvestFn: HarvestFn | undefined

  // Harvest concurrency state (design §3):
  //   inFlightHarvests: jobIds whose harvest is currently running — prevents duplicate dispatches
  //   harvestSemaphore: count of available harvest slots (starts at HARVEST_CONCURRENCY_LIMIT)
  //   harvestQueue: jobs waiting for a semaphore slot
  private readonly inFlightHarvests = new Set<string>()
  private harvestSemaphore = HARVEST_CONCURRENCY_LIMIT
  private readonly harvestQueue: ComputeJob[] = []
  //   inFlightErrorNotifs: jobIds whose error-notification emit is in progress — prevents a second
  //   overlapping tick from re-emitting before notified_at is persisted (ticks are not serialized)
  private readonly inFlightErrorNotifs = new Set<string>()

  constructor(private readonly deps: JobPollerDeps) {
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h))
    this.dispatchTracker = deps.dispatchTracker ?? sharedDispatchTracker
    this.harvestFn = deps.harvestFn
  }

  // Starts the poller. Polls once immediately (picks up jobs that were running before restart),
  // then on every interval.
  start(): void {
    if (this.handle) return // already running

    void this.tick() // first tick immediately (restart recovery)
    this.handle = this.setIntervalFn(() => void this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.handle) {
      this.clearIntervalFn(this.handle)
      this.handle = undefined
    }
  }

  // One poll cycle: group non-terminal jobs by provider, poll each provider's jobs.
  // Also runs the restart-recovery harvest scan (design §3): re-queues terminal+unharvested jobs.
  async tick(): Promise<void> {
    // Restart-recovery harvest scan: re-queue terminal jobs whose harvest was interrupted by restart.
    // harvestFn must be configured; without it, harvest is disabled entirely.
    if (this.harvestFn) {
      const unharvested = await this.deps.jobRepository.findTerminalUnharvested()
      for (const job of unharvested) {
        this._dispatchHarvest(job)
      }
    }

    // Error-notification recovery scan: the dispatcher writes status='error' (dispatch_failed /
    // host_unreachable) but never emits a compute_done notification, and 'error' is excluded from
    // both the harvest scan and findNonTerminal. Without this, a dispatch failure would never reach
    // notify→analyze. emitJobNotification is idempotent (guards on notified_at), so a job already
    // notified via another path (e.g. the noHandle branch below) is skipped.
    if (this.deps.broadcast && this.deps.storageRoot) {
      const { broadcast, storageRoot } = this.deps
      const errorUnnotified = await this.deps.jobRepository.findErrorUnnotified()
      for (const job of errorUnnotified) {
        // emitJobNotification guards on notified_at (idempotent), but that is a check-then-act
        // with a real window: ticks are not serialized, so a second tick could re-select this row
        // before the notified_at write commits and emit a duplicate user-visible notification. The
        // in-flight set closes that window (mirrors inFlightHarvests for the harvest scan).
        if (this.inFlightErrorNotifs.has(job.job_id)) continue
        this.inFlightErrorNotifs.add(job.job_id)
        void emitJobNotification(job, {
          jobRepository: this.deps.jobRepository,
          hostRepository: this.deps.hostRepository,
          storageRoot,
          broadcast
        })
          .catch(() => {
            // Non-fatal: job status is already persisted; retry on the next tick.
          })
          .finally(() => {
            this.inFlightErrorNotifs.delete(job.job_id)
          })
      }
    }

    const jobs = await this.deps.jobRepository.findNonTerminal()
    if (jobs.length === 0) return

    // Group by provider.
    const byProvider = new Map<string, ComputeJob[]>()
    for (const job of jobs) {
      const list = byProvider.get(job.provider_id) ?? []
      list.push(job)
      byProvider.set(job.provider_id, list)
    }

    // Poll each provider's jobs in parallel (different SSH connections, no ordering dependency).
    await Promise.all(
      Array.from(byProvider.entries()).map(([providerId, providerJobs]) =>
        this._pollProvider(providerId, providerJobs)
      )
    )
  }

  // ---------------------------------------------------------------------------
  // Harvest dispatch helpers (design §3)
  // ---------------------------------------------------------------------------

  // Dispatches a harvest for a terminal job. Fire-and-forget: does NOT await the harvest so the
  // poller tick returns immediately (hard constraint: design §3 "never await in tick loop").
  // Enforces: in-flight dedup (same job not re-dispatched while harvest is running), and the
  // concurrency semaphore (at most HARVEST_CONCURRENCY_LIMIT harvests run simultaneously).
  private _dispatchHarvest(job: ComputeJob): void {
    if (!this.harvestFn) return
    // In-flight dedup: if already harvesting this job, skip.
    if (this.inFlightHarvests.has(job.job_id)) return

    this.inFlightHarvests.add(job.job_id)

    if (this.harvestSemaphore > 0) {
      // Slot available — start immediately.
      this._runHarvest(job)
    } else {
      // No slot — enqueue; will be started when a running harvest completes.
      this.harvestQueue.push(job)
    }
  }

  // Acquires a semaphore slot, runs harvestFn, then releases the slot and drains the queue.
  private _runHarvest(job: ComputeJob): void {
    if (!this.harvestFn) return
    this.harvestSemaphore--

    // Fire-and-forget: intentionally not awaited.
    void this.harvestFn(job)
      .catch(() => {
        // Individual harvest failures must not propagate to the poller (design §3: error isolation).
      })
      .finally(() => {
        this.inFlightHarvests.delete(job.job_id)
        this.harvestSemaphore++
        // Drain one item from the queue if any are waiting.
        const next = this.harvestQueue.shift()
        if (next) {
          this._runHarvest(next)
        }
      })
  }

  // Polls all jobs for one provider in a single SSH round-trip (where possible).
  private async _pollProvider(providerId: string, jobs: ComputeJob[]): Promise<void> {
    // Handle jobs stuck in 'submitted' with no pid. A job sits in this state for the whole dispatch
    // window (mkdir + input staging + launch), and input staging can scp GB-scale files for up to
    // 30 min. So 'submitted'+no-handle does NOT by itself mean a failed dispatch: it only means a
    // failed dispatch if no dispatch is actively running for it in this process. The shared
    // DispatchTracker disambiguates — an untracked such job was orphaned by an app restart and is
    // marked error/dispatch_failed (design.md §8 boundary 3); a tracked one is still dispatching and
    // is left alone until the dispatcher writes its terminal or running state.
    const noHandle: ComputeJob[] = []
    const withHandle: ComputeJob[] = []
    for (const job of jobs) {
      if (job.status === 'submitted' && !job.remote_handle) {
        if (this.dispatchTracker.has(job.job_id)) continue // still dispatching — not orphaned
        noHandle.push(job)
      } else {
        withHandle.push(job)
      }
    }

    for (const job of noHandle) {
      const updated = await this.deps.jobRepository.update(job.job_id, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: 'dispatch interrupted by restart',
        finishedAt: new Date()
      })
      this.deps.onJobUpdated?.(updated)
      // Emit compute_done notification for execution-error jobs (design §8: error is a final
      // resting state). Fire-and-forget: notification failure must not break the poller tick.
      if (this.deps.broadcast && this.deps.storageRoot) {
        void emitJobNotification(updated, {
          jobRepository: this.deps.jobRepository,
          hostRepository: this.deps.hostRepository,
          storageRoot: this.deps.storageRoot,
          broadcast: this.deps.broadcast
        }).catch(() => {
          // Non-fatal: job status is already persisted.
        })
      }
    }

    if (withHandle.length === 0) return

    const host = await this.deps.hostRepository.get(providerId)
    if (!host) return // host deleted

    let target
    try {
      target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
    } catch {
      // Can't reach host — do not flip job status (design.md §8 boundary 2).
      return
    }

    // Group by driver instance, then poll each driver's jobs in one batched call (design.md §4.2). A
    // job is always polled by the driver snapshotted at submit time; the Direct driver sub-batches
    // internally. Mixing drivers for one provider becomes possible once Slurm lands (Issue 03) — each
    // driver gets its own pollMany call sharing the resolved target.
    const driverGroups = new Map<
      ComputeDriver | undefined,
      { job: ComputeJob; handle: ParsedRemoteHandle }[]
    >()
    for (const job of withHandle) {
      const handle = parseRemoteHandle(job.remote_handle)
      if (!handle) continue // corrupt handle: leave non-terminal, re-polled next tick (design.md §10)
      const key = this._driverFor(job)
      const list = driverGroups.get(key) ?? []
      list.push({ job, handle })
      driverGroups.set(key, list)
    }

    for (const [driver, entries] of driverGroups) {
      await this._pollDriverGroup(driver, entries, target)
    }
  }

  // Resolves the driver instance to poll a job. Returns the registered driver for the job's
  // snapshotted kind, or a cached per-provider DirectDriver when no registry is wired (legacy path),
  // or undefined if no driver is registered for a non-direct kind.
  private _driverFor(job: ComputeJob): ComputeDriver | undefined {
    const resolved = resolveJobDriver(job, this.deps.driverRegistry)
    if (resolved) return resolved
    // No registry / no driver for this kind. Only 'direct' is supported without a registry.
    if (job.driver && job.driver !== 'direct') return undefined
    const cached = this.directDriverCache.get(job.provider_id)
    if (cached) return cached
    const fresh = new DirectDriver({ runner: this.deps.runner })
    this.directDriverCache.set(job.provider_id, fresh)
    return fresh
  }

  // Polls one driver's jobs for one provider in a single batched call, then applies the state machine
  // per observed job. Driver connectivity failures become lastPollError with NO status flip
  // (design.md §8 boundary 2).
  private async _pollDriverGroup(
    driver: ComputeDriver | undefined,
    entries: { job: ComputeJob; handle: ParsedRemoteHandle }[],
    target: import('./ssh-runner').ResolvedSshTarget
  ): Promise<void> {
    if (!driver || entries.length === 0) return

    const driverJobs: DriverJob[] = entries.map((e) => ({ jobId: e.job.job_id, handle: e.handle }))
    // Use the first job's workdir as the driver context workdir. The Direct driver does not read
    // workdir from the context for polling (it reads per-job handle paths), so any workdir suffices;
    // the field exists for forward-compat with future drivers.
    const context = {
      target,
      workdir: entries[0]!.job.remote_workdir ?? entries[0]!.handle.paths.workdir
    }

    let result
    try {
      result = await driver.pollMany(context, driverJobs)
    } catch (err) {
      // Unexpected driver throw — record lastPollError per job, do NOT flip status (design.md §8 b2).
      const msg = err instanceof Error ? err.message : String(err)
      await this._recordPollError(
        entries.map((e) => e.job),
        msg
      )
      return
    }

    if (result.kind === 'unreachable') {
      // Whole batch unreachable — record per-job lastPollError, flip NO status.
      await this._recordPollError(
        entries.map((e) => e.job),
        result.message
      )
      return
    }

    // Apply the state machine per observed job. Pass the driver + context so the fallback-kill path
    // can delegate to driver.cancel (process-group semantics).
    for (const { job } of entries) {
      const obs = result.observations.get(job.job_id)
      if (!obs) continue // not observed this tick — leave non-terminal, re-poll next tick
      await this._applyPollResult(job, obs, driver, context)
    }

    // Per-job transient errors (partial unreachable within the batch) → lastPollError, no flip.
    if (result.errors) {
      for (const { job } of entries) {
        const msg = result.errors.get(job.job_id)
        if (!msg) continue
        const updated = await this.deps.jobRepository.update(job.job_id, {
          lastPollError: msg,
          retryAfterUserAction: true
        })
        this.deps.onJobUpdated?.(updated)
      }
    }
  }

  // Records a transient SSH connectivity error for each job without changing job status.
  // Implements design.md §8 boundary 2: "host unreachable ≠ job failed".
  private async _recordPollError(jobs: ComputeJob[], message: string): Promise<void> {
    for (const job of jobs) {
      const updated = await this.deps.jobRepository.update(job.job_id, {
        lastPollError: message,
        retryAfterUserAction: true
      })
      this.deps.onJobUpdated?.(updated)
    }
  }

  private async _applyPollResult(
    job: ComputeJob,
    result: RemoteObservation,
    driver: ComputeDriver | undefined,
    context: { target: import('./ssh-runner').ResolvedSshTarget; workdir: string }
  ): Promise<void> {
    const {
      alive,
      exitCode,
      hasExitCode,
      stdoutTail,
      stderrTail,
      remoteState,
      queueReason,
      schedulerDiagnostic
    } = result

    // Terminal: exit_code file exists — this is authoritative.
    if (hasExitCode && exitCode !== null) {
      // Reset vanish counter since we have a definitive result.
      this.vanishCounters.delete(job.job_id)

      let status: 'success' | 'failed' | 'timeout'
      let errorCode: string | undefined

      if (exitCode === 0) {
        status = 'success'
      } else if (exitCode === 124) {
        status = 'timeout'
        errorCode = 'timeout'
      } else if (exitCode === 137) {
        // SIGKILL: check elapsed time to disambiguate timeout vs OOM kill.
        const startedAt = job.started_at
        const timeoutSecs = job.timeout_seconds ?? 86400
        const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0
        if (elapsed >= timeoutSecs) {
          status = 'timeout'
          errorCode = 'timeout'
        } else {
          status = 'failed'
          errorCode = 'job_failed'
        }
      } else {
        status = 'failed'
        errorCode = 'job_failed'
      }

      const updated = await this.deps.jobRepository.update(job.job_id, {
        status,
        exitCode,
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        errorCode: errorCode ?? null,
        // Persist scheduler diagnostics alongside the terminal status (design.md §4.4 — remote state
        // and a detailed diagnostic are kept separate from the cross-provider status).
        remoteState: remoteState ?? null,
        queueReason: null,
        schedulerDiagnostic: schedulerDiagnostic ?? null,
        finishedAt: new Date()
      })
      this.deps.onJobUpdated?.(updated)
      // Async-dispatch harvest for success/failed/timeout (design §3). Not awaited — must not
      // block the tick loop. 'error' status is never reached here (only in the noHandle path).
      this._dispatchHarvest(updated)
      return
    }

    // Process gone but no exit_code file — potential process_vanished.
    if (!alive && !hasExitCode) {
      const state = this.vanishCounters.get(job.job_id) ?? { ticks: 0 }
      state.ticks++
      this.vanishCounters.set(job.job_id, state)

      if (state.ticks >= PROCESS_VANISHED_TICKS) {
        this.vanishCounters.delete(job.job_id)
        const updated = await this.deps.jobRepository.update(job.job_id, {
          status: 'failed',
          errorCode: 'process_vanished',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null,
          finishedAt: new Date()
        })
        this.deps.onJobUpdated?.(updated)
        // process_vanished is a terminal state — dispatch harvest (design §3).
        this._dispatchHarvest(updated)
      }
      // else: keep running, check again next tick
      return
    }

    // Still alive (running) — check poller fallback timeout, then update tails. Reset vanish counter.
    this.vanishCounters.delete(job.job_id)

    // Poller fallback: if job is still alive past startedAt + timeout + grace, the remote `timeout`
    // command may have been absent or hung. Cancel via the driver (process-group kill) and mark as
    // timeout (design.md §10). The pre-refactor path sent a bare `kill pid`; the driver uses the
    // process group (setsid pgid == pid), which is the testable cancel semantics (acceptance criterion).
    const startedAt = job.started_at
    const timeoutSecs = job.timeout_seconds ?? 86400
    if (startedAt) {
      const elapsedSecs = (Date.now() - startedAt) / 1000
      if (elapsedSecs >= timeoutSecs + POLLER_KILL_GRACE_SECONDS) {
        const handle = parseRemoteHandle(job.remote_handle)
        if (handle && handle.kind !== 'legacy-direct') {
          // driver.cancel owns the kill command + swallows connectivity errors.
          await driver?.cancel(context, { ...handle.raw })
        }
        const updated = await this.deps.jobRepository.update(job.job_id, {
          status: 'timeout',
          errorCode: 'timeout',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null,
          remoteState: remoteState ?? null,
          schedulerDiagnostic: schedulerDiagnostic ?? null,
          finishedAt: new Date()
        })
        this.deps.onJobUpdated?.(updated)
        // Poller-fallback timeout is a terminal state — dispatch harvest (design §3).
        this._dispatchHarvest(updated)
        return
      }
    }

    // Still alive — reset vanish counter, then apply the scheduler-aware non-terminal mapping below.
    this.vanishCounters.delete(job.job_id)

    // Scheduler-aware non-terminal mapping (design.md §4.4). For a Slurm job the driver surfaces the
    // scheduler-native state in `remoteState`: PENDING keeps the app status `submitted`; RUNNING
    // promotes it to `running`. Direct jobs have no remoteState and follow the original behavior
    // (alive → running). The scheduler state is always persisted alongside, separate from `status`.
    const isSchedulerPending = remoteState === 'PENDING'
    const desiredStatus: 'submitted' | 'running' = isSchedulerPending ? 'submitted' : 'running'

    if (job.status !== desiredStatus) {
      const updated = await this.deps.jobRepository.update(job.job_id, {
        status: desiredStatus,
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        remoteState: remoteState ?? null,
        queueReason: queueReason ?? null,
        schedulerDiagnostic: null,
        lastPollError: null
      })
      this.deps.onJobUpdated?.(updated)
    } else {
      // Just update tails + scheduler diagnostics. Clear any stale lastPollError now that this poll
      // succeeded, so a transient SSH blip's error banner does not stick to a healthy job forever.
      const updated = await this.deps.jobRepository.update(job.job_id, {
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        remoteState: remoteState ?? null,
        queueReason: queueReason ?? null,
        schedulerDiagnostic: null,
        lastPollError: null
      })
      this.deps.onJobUpdated?.(updated)
    }
  }
}
