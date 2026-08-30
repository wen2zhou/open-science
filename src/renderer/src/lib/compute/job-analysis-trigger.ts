// Analysis turn trigger — pure renderer logic (design §11).
//
// Receives done-state job broadcasts (notified_at set, notification_consumed_at null) and
// auto-fires a sendPrompt for each affected session. Key behaviors:
//  - Batch: multiple done jobs for the same session in one microtask tick → one prompt.
//  - Admission: hands each batch to the shared application Message queue, which owns readiness.
//  - Idempotent: jobs with notification_consumed_at set are skipped; in-flight job ids are
//    tracked in a memory Set so duplicate broadcasts don't re-queue.
//  - markConsumed only after a successful durable delivery; ACK failures retry with bounded backoff.
//  - Cross-session isolation: prompt goes to job.session_id.

import type { JobSummary } from '../../../../shared/compute'
import type { MessageAttribution } from '../../../../shared/session-persistence'

// Prompt text shown as the user message that kicks off the analysis turn. English per CLAUDE.md.
export const buildAnalysisPrompt = (jobs: JobSummary[]): string => {
  const lines: string[] = [
    `${jobs.length === 1 ? 'A remote job has' : `${jobs.length} remote jobs have`} finished. Please analyze the results.`,
    ''
  ]

  for (const job of jobs) {
    lines.push(`## Job: ${job.job_id}`)
    lines.push(`Status: ${job.status}`)

    if (job.featured_files && job.featured_files.length > 0) {
      lines.push(`Featured output files (workspace-relative paths):`)
      for (const f of job.featured_files) {
        lines.push(`  - ${f}`)
      }
    } else {
      lines.push(`No featured output files (harvest may have been incomplete).`)
    }

    if (job.left_on_remote_count && job.left_on_remote_count > 0) {
      lines.push(
        `Note: ${job.left_on_remote_count} file(s) left on the remote host (too large or marked residency:remote).`
      )
    }

    lines.push('')
    lines.push(
      `Please use \`attachJob("${job.job_id}").result()\` to retrieve the full result dictionary, ` +
        `examine the output files, and call \`write_artifact_file\` to publish any results worth preserving.`
    )

    if (job.status === 'failed' || job.status === 'timeout') {
      lines.push(
        `Note: the job exited with a non-zero status. Harvest completed but the remote workdir has been kept for inspection.`
      )
    }

    lines.push('')
  }

  return lines.join('\n').trim()
}

// Injected dependencies so the trigger is fully testable without React or Electron.
export type JobAnalysisTriggerDeps = {
  // Sends a prompt to a session; resolves to a result object on success or undefined on failure.
  sendPrompt: (
    sessionId: string,
    text: string,
    attribution: Extract<MessageAttribution, { feature: 'compute' }>
  ) => Promise<{ sessionId: string; messageId: string } | undefined>
  // Finds a previously persisted delivery containing this job. This is the restart/crash dedupe seam.
  findPersistedDelivery: (
    sessionId: string,
    jobId: string
  ) =>
    | {
        deliveryKey?: string
        jobIds?: string[]
        messageId: string
        outcome: 'pending' | 'succeeded' | 'failed' | 'cancelled'
      }
    | undefined
  // Reads the terminal state of the exact Message created by this delivery.
  getDeliveryOutcome: (
    sessionId: string,
    messageId: string
  ) => 'pending' | 'succeeded' | 'failed' | 'cancelled'
  // Resolves only after every queued Session JSON write is durable.
  flushPersistence: () => Promise<void>
  // Persists notificationConsumedAt for the given job ids (IPC to main process).
  markConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
  // Registers a one-shot callback for when the given session's turn finishes (idle transition).
  onTurnEnd: (sessionId: string, callback: () => void) => void
  // Structured logger; receives a tag and a detail message for observability.
  log: (tag: string, message: string) => void
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

type PendingBatch = {
  // Jobs waiting for the same-tick batching window to close.
  jobs: Map<string, JobSummary>
}

type InFlightSet = Set<string> // job_id values currently being processed (in analysis turn or queued)

type Delivery = {
  deliveryKey: string
  sessionId: string
  jobIds: string[]
  messageId: string
  waitRegistered: boolean
  ackRunning: boolean
  ackAttempts: number
  ackRetryHandle: ReturnType<typeof setTimeout> | undefined
}

const ACK_RETRY_BASE_MS = 1_000
const ACK_RETRY_MAX_MS = 30_000
const ACK_RETRY_MAX_ATTEMPTS = 5

export const buildComputeDeliveryKey = (sessionId: string, jobIds: readonly string[]): string =>
  `compute_done:${sessionId}:${[...new Set(jobIds)].sort().join(',')}`

// Factory that creates a stateful trigger object. Call trigger.onJobDone(job) for each
// compute:job-updated broadcast where notified_at is set.
export type JobAnalysisTrigger = {
  // Process a new done-state job broadcast.
  onJobDone: (job: JobSummary) => void
  stop: () => void
}

export const createJobAnalysisTrigger = (deps: JobAnalysisTriggerDeps): JobAnalysisTrigger => {
  // Per-session queue of jobs pending analysis.
  const pendingBySession = new Map<string, PendingBatch>()
  // job_ids currently in flight (sendPrompt sent, markConsumed not yet called).
  const inFlight: InFlightSet = new Set()
  // Delivery identity, rather than Session identity, owns ACK state. Two batches in one Session
  // can therefore overlap without replacing each other's job ids or completion callbacks.
  const deliveries = new Map<string, Delivery>()
  const deliveryKeyByJobId = new Map<string, string>()
  const setTimeoutFn = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle))
  let stopped = false

  const isDoneState = (job: JobSummary): boolean =>
    (job.status === 'success' ||
      job.status === 'failed' ||
      job.status === 'timeout' ||
      job.status === 'error') &&
    job.notified_at !== undefined &&
    job.notified_at !== null &&
    job.needs_attention !== true

  const isAlreadyConsumed = (job: JobSummary): boolean =>
    job.notification_consumed_at !== undefined && job.notification_consumed_at !== null

  const releaseDelivery = (delivery: Delivery): void => {
    if (delivery.ackRetryHandle !== undefined) {
      clearTimeoutFn(delivery.ackRetryHandle)
      delivery.ackRetryHandle = undefined
    }
    deliveries.delete(delivery.deliveryKey)
    for (const jobId of delivery.jobIds) {
      inFlight.delete(jobId)
      if (deliveryKeyByJobId.get(jobId) === delivery.deliveryKey) {
        deliveryKeyByJobId.delete(jobId)
      }
    }
  }

  const runAck = (delivery: Delivery): void => {
    void attemptAck(delivery).catch((error) => {
      deps.log(
        'analysis-turn:ack-retry-failed',
        `session=${delivery.sessionId} error=${String(error)}`
      )
    })
  }

  const scheduleAckRetry = (delivery: Delivery): void => {
    if (stopped || deliveries.get(delivery.deliveryKey) !== delivery) return
    if (delivery.ackRetryHandle !== undefined) return
    if (delivery.ackAttempts >= ACK_RETRY_MAX_ATTEMPTS) {
      deps.log(
        'analysis-turn:ack-retry-exhausted',
        `session=${delivery.sessionId} attempts=${delivery.ackAttempts}`
      )
      return
    }
    const delayMs = Math.min(
      ACK_RETRY_BASE_MS * 2 ** Math.max(0, delivery.ackAttempts - 1),
      ACK_RETRY_MAX_MS
    )
    delivery.ackRetryHandle = setTimeoutFn(() => {
      delivery.ackRetryHandle = undefined
      if (!stopped && deliveries.get(delivery.deliveryKey) === delivery) runAck(delivery)
    }, delayMs)
    deps.log(
      'analysis-turn:ack-retry-scheduled',
      `session=${delivery.sessionId} delayMs=${delayMs}`
    )
  }

  const attemptAck = async (delivery: Delivery): Promise<void> => {
    if (stopped || delivery.ackRunning) return
    delivery.ackRunning = true
    delivery.ackAttempts++
    try {
      // The Message is the durable delivery record. Never consume the Compute inbox first.
      await deps.flushPersistence()
      await deps.markConsumed(delivery.sessionId, delivery.jobIds)
      deps.log(
        'analysis-turn:consumed',
        `session=${delivery.sessionId} jobs=[${delivery.jobIds.join(',')}]`
      )
      releaseDelivery(delivery)
    } catch (err) {
      // Keep the delivery and every job fence. A later broadcast/restart retries this ACK path only.
      deps.log(
        'analysis-turn:mark-consumed-failed',
        `session=${delivery.sessionId} error=${String(err)}`
      )
      scheduleAckRetry(delivery)
    } finally {
      delivery.ackRunning = false
    }
  }

  async function settleDelivery(
    delivery: Delivery,
    knownOutcome?: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  ): Promise<void> {
    const persisted = deps.findPersistedDelivery(delivery.sessionId, delivery.jobIds[0]!)
    const outcome =
      knownOutcome ??
      persisted?.outcome ??
      deps.getDeliveryOutcome(delivery.sessionId, delivery.messageId)
    if (outcome === 'pending') {
      registerTurnEnd(delivery)
      return
    }
    if (outcome === 'failed' || outcome === 'cancelled') {
      deps.log('analysis-turn:not-consumed', `session=${delivery.sessionId} outcome=${outcome}`)
      releaseDelivery(delivery)
      return
    }
    await attemptAck(delivery)
  }

  const runSettlement = (
    delivery: Delivery,
    knownOutcome?: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  ): void => {
    void settleDelivery(delivery, knownOutcome).catch((error) => {
      deps.log(
        'analysis-turn:settle-failed',
        `session=${delivery.sessionId} error=${String(error)}`
      )
    })
  }

  const registerTurnEnd = (delivery: Delivery): void => {
    if (stopped || delivery.waitRegistered) return
    delivery.waitRegistered = true
    deps.onTurnEnd(delivery.sessionId, () => {
      delivery.waitRegistered = false
      if (!stopped) runSettlement(delivery)
    })
  }

  const adoptPersistedDelivery = (
    job: JobSummary,
    persisted: NonNullable<ReturnType<JobAnalysisTriggerDeps['findPersistedDelivery']>>
  ): void => {
    const jobIds = persisted.jobIds?.length ? [...persisted.jobIds] : [job.job_id]
    const deliveryKey = persisted.deliveryKey ?? buildComputeDeliveryKey(job.session_id, jobIds)
    let delivery = deliveries.get(deliveryKey)
    if (!delivery) {
      delivery = {
        deliveryKey,
        sessionId: job.session_id,
        jobIds,
        messageId: persisted.messageId,
        waitRegistered: false,
        ackRunning: false,
        ackAttempts: 0,
        ackRetryHandle: undefined
      }
      deliveries.set(deliveryKey, delivery)
      for (const jobId of jobIds) {
        inFlight.add(jobId)
        deliveryKeyByJobId.set(jobId, deliveryKey)
      }
    }
    runSettlement(delivery, persisted.outcome)
  }

  // Attempts to send the batched analysis prompt for a session immediately.
  const flushSession = async (sessionId: string): Promise<void> => {
    if (stopped) return
    const batch = pendingBySession.get(sessionId)
    if (!batch || batch.jobs.size === 0) return

    const jobsToSend = Array.from(batch.jobs.values())
    const jobIds = jobsToSend.map((j) => j.job_id)

    // Mark in-flight so duplicate broadcasts are ignored.
    for (const id of jobIds) inFlight.add(id)

    // Clear the pending queue for this session.
    pendingBySession.delete(sessionId)

    deps.log('analysis-turn:sending', `session=${sessionId} jobs=[${jobIds.join(',')}]`)

    const prompt = buildAnalysisPrompt(jobsToSend)
    const deliveryKey = buildComputeDeliveryKey(sessionId, jobIds)
    const attribution = {
      kind: 'application' as const,
      feature: 'compute' as const,
      purpose: 'job-completion-analysis' as const,
      deliveryKey,
      jobIds
    }

    let result: Awaited<ReturnType<typeof deps.sendPrompt>>

    try {
      result = await deps.sendPrompt(sessionId, prompt, attribution)
    } catch (err) {
      deps.log('analysis-turn:send-failed', `session=${sessionId} error=${String(err)}`)
      // Don't mark consumed — will retry on next broadcast.
      for (const id of jobIds) inFlight.delete(id)
      return
    }

    if (!result) {
      deps.log('analysis-turn:send-returned-undefined', `session=${sessionId}`)
      for (const id of jobIds) inFlight.delete(id)
      return
    }

    if (stopped) {
      for (const id of jobIds) inFlight.delete(id)
      return
    }

    const persisted = deps.findPersistedDelivery(sessionId, jobIds[0]!)
    if (persisted) {
      for (const id of jobIds) inFlight.delete(id)
      adoptPersistedDelivery(jobsToSend[0]!, persisted)
      return
    }

    deps.log('analysis-turn:sent', `session=${sessionId} jobs=[${jobIds.join(',')}]`)

    const delivery: Delivery = {
      deliveryKey,
      sessionId,
      jobIds,
      messageId: result.messageId,
      waitRegistered: false,
      ackRunning: false,
      ackAttempts: 0,
      ackRetryHandle: undefined
    }
    deliveries.set(deliveryKey, delivery)
    for (const jobId of jobIds) deliveryKeyByJobId.set(jobId, deliveryKey)
    registerTurnEnd(delivery)
  }

  const scheduleFlush = (sessionId: string): void => {
    // Use a microtask to batch multiple synchronous onJobDone calls.
    void Promise.resolve()
      .then(() => flushSession(sessionId))
      .catch((error) => {
        deps.log('analysis-turn:flush-failed', `session=${sessionId} error=${String(error)}`)
      })
  }

  const onJobDone = (job: JobSummary): void => {
    if (stopped) return
    if (!isDoneState(job)) return
    if (isAlreadyConsumed(job)) return
    const activeDeliveryKey = deliveryKeyByJobId.get(job.job_id)
    if (activeDeliveryKey) {
      const delivery = deliveries.get(activeDeliveryKey)
      if (delivery && !delivery.waitRegistered) runSettlement(delivery)
      return
    }

    const persisted = deps.findPersistedDelivery(job.session_id, job.job_id)
    if (persisted) {
      adoptPersistedDelivery(job, persisted)
      return
    }
    if (inFlight.has(job.job_id)) return

    const { session_id: sessionId, job_id: jobId } = job

    let batch = pendingBySession.get(sessionId)

    if (!batch) {
      batch = { jobs: new Map() }
      pendingBySession.set(sessionId, batch)
    }

    if (batch.jobs.has(jobId)) return // already queued for this session

    batch.jobs.set(jobId, job)

    deps.log('analysis-turn:queued', `session=${sessionId} job=${jobId}`)

    // Admit on the next microtask so same-tick arrivals batch. The shared application Message queue
    // owns every readiness barrier and keeps the admission pending until this Session is sendable.
    scheduleFlush(sessionId)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    for (const delivery of deliveries.values()) {
      if (delivery.ackRetryHandle !== undefined) clearTimeoutFn(delivery.ackRetryHandle)
    }
    deliveries.clear()
    deliveryKeyByJobId.clear()
    pendingBySession.clear()
    inFlight.clear()
  }

  return { onJobDone, stop }
}
