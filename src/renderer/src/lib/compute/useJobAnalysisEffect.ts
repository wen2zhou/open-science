// useJobAnalysisEffect — wires the job-analysis-trigger into the React component tree.
//
// Owned by the App-level recovery bridge with the shared per-Session application Message queue.
// On every `compute:job-updated` broadcast AND once after App persistence recovery,
// the trigger is fed the job summary and decides whether to fire / queue an analysis turn.
//
// Design decisions:
// - One readiness-scoped effect owns the trigger and every subscription so delayed work cannot cross
//   a persistence recovery boundary.
// - `isSessionInFlight` reads from useSessionStore.getState() synchronously — no subscription needed.
// - The restart-recovery scan fires whenever the active session id changes (session navigation).

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import { isComputeJobCompletionAttribution } from '../../../../shared/session-persistence'
import { useSessionJobStore } from '../../stores/session-job-store'
import { useSessionStore } from '../../stores/session-store'
import {
  flushSessionPersistence,
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '../session-persistence/session-persistence'
import { createJobAnalysisTrigger } from '../compute/job-analysis-trigger'

// Matches the sendMessage signature returned by useWorkspaceAgentRuntime.
type AdmitMessageFn = (input: {
  session: ReturnType<typeof useSessionStore.getState>['sessions'][number]
  text: string
  attribution: Extract<
    NonNullable<
      ReturnType<
        typeof useSessionStore.getState
      >['sessions'][number]['messages'][number]['attribution']
    >,
    { feature: 'compute' }
  >
}) => Promise<{ sessionId: string; messageId: string } | undefined>

type UseJobAnalysisEffectOptions = {
  enabled: boolean
  admitMessage: AdmitMessageFn
}

type JobAnalysisRecoveryStatus = Readonly<{
  error: 'pending-scan-failed' | undefined
  retry: () => void
}>

const RECOVERY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

// Subscribes to all done-state compute:job-updated broadcasts and runs the analysis turn trigger.
// Also scans for pending notifications on session load (restart recovery path).
export const useJobAnalysisEffect = ({
  enabled,
  admitMessage
}: UseJobAnalysisEffectOptions): JobAnalysisRecoveryStatus => {
  const [error, setError] = useState<JobAnalysisRecoveryStatus['error']>()
  const retryScanRef = useRef<() => void>(() => undefined)
  const retry = useCallback(() => retryScanRef.current(), [])
  const admitLatestMessage = useEffectEvent(
    (input: Parameters<AdmitMessageFn>[0]): ReturnType<AdmitMessageFn> => admitMessage(input)
  )

  useEffect(() => {
    if (!enabled) return

    let isActive = true
    let scanRunning = false
    let retryAttempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const turnEndUnsubscribes = new Set<() => void>()
    const trigger = createJobAnalysisTrigger({
      isSessionInFlight: (sessionId) => {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        return (
          session?.status === 'running' ||
          session?.status === 'waiting-for-user' ||
          session?.status === 'waiting-permission' ||
          session?.status === 'waiting-plan-approval'
        )
      },
      sendPrompt: async (sessionId, text, attribution) => {
        if (!isActive) return undefined
        let session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
        if (session?.contentLoaded === false) {
          const persisted = await loadPersistedSession({
            projectId: session.projectId,
            sessionId
          })
          if (!isActive || !persisted) return undefined
          session = hydratePersistedSessionIfPresent(persisted)
        }
        const persistedDelivery = session
          ? findComputeDelivery(session, attribution.jobIds[0]!)
          : undefined
        if (persistedDelivery) {
          return { sessionId, messageId: persistedDelivery.messageId }
        }
        return session ? admitLatestMessage({ session, text, attribution }) : undefined
      },
      findPersistedDelivery: (sessionId, jobId) => {
        const session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
        return session ? findComputeDelivery(session, jobId) : undefined
      },
      getDeliveryOutcome: (sessionId, messageId) => {
        const session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
        return session ? computeDeliveryOutcome(session, messageId) : 'cancelled'
      },
      flushPersistence: () => flushSessionPersistence(),
      markConsumed: async (sessionId, jobIds) => {
        if (!isActive) return
        if (typeof window.api?.compute?.jobsMarkConsumed === 'function') {
          await window.api.compute.jobsMarkConsumed(sessionId, jobIds)
          const consumedAt = Date.now()
          const jobStore = useSessionJobStore.getState()
          for (const jobId of jobIds) {
            const job = jobStore.jobsById.get(jobId)
            if (job?.session_id === sessionId) {
              jobStore.applyUpdate({ ...job, notification_consumed_at: consumedAt })
            }
          }
        }
      },
      onTurnEnd: (sessionId, callback) => {
        // Keep runtime completion listeners inside the same readiness lifecycle as dispatch.
        const unsubscribe = useSessionStore.subscribe((state) => {
          const session = state.sessions.find((candidate) => candidate.id === sessionId)
          if (!session) return
          if (
            session.status !== 'running' &&
            session.status !== 'waiting-for-user' &&
            session.status !== 'waiting-permission' &&
            session.status !== 'waiting-plan-approval'
          ) {
            unsubscribe()
            turnEndUnsubscribes.delete(unsubscribe)
            if (isActive) callback()
          }
        })
        turnEndUnsubscribes.add(unsubscribe)
      },
      log: (tag, message) => {
        console.log(`[compute] ${tag}: ${message}`)
      }
    })

    const feedNotifiedJobs = (state: ReturnType<typeof useSessionJobStore.getState>): void => {
      for (const job of state.jobsById.values()) {
        if (job.notified_at !== undefined && job.notified_at !== null) {
          trigger.onJobDone(job)
        }
      }
    }

    const scanPendingJobs = (): void => {
      if (typeof window.api?.compute?.jobsPendingNotification !== 'function') return
      if (scanRunning) return
      scanRunning = true
      void window.api.compute
        .jobsPendingNotification({ allSessions: true })
        .then((jobs) => {
          if (!isActive) return
          retryAttempt = 0
          setError(undefined)
          const jobStore = useSessionJobStore.getState()
          for (const job of jobs) jobStore.applyUpdate(job)
        })
        .catch((scanError: unknown) => {
          if (!isActive) return
          console.warn('[compute] pending notification recovery scan failed', scanError)
          setError('pending-scan-failed')
          if (retryAttempt >= RECOVERY_RETRY_DELAYS_MS.length) return
          const delay = RECOVERY_RETRY_DELAYS_MS[retryAttempt++]
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            scanPendingJobs()
          }, delay)
        })
        .finally(() => {
          scanRunning = false
        })
    }

    const retryNow = (): void => {
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      retryAttempt = 0
      scanPendingJobs()
    }
    retryScanRef.current = retryNow
    window.addEventListener('focus', retryNow)

    const initialState = useSessionJobStore.getState()
    feedNotifiedJobs(initialState)
    scanPendingJobs()

    const unsubscribeJobs = useSessionJobStore.subscribe((state) => {
      feedNotifiedJobs(state)
    })

    return () => {
      isActive = false
      trigger.stop()
      retryScanRef.current = () => undefined
      window.removeEventListener('focus', retryNow)
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribeJobs()
      for (const unsubscribe of turnEndUnsubscribes) unsubscribe()
      turnEndUnsubscribes.clear()
    }
  }, [enabled])

  return { error, retry }
}

const findComputeDelivery = (
  session: ReturnType<typeof useSessionStore.getState>['sessions'][number],
  jobId: string
):
  | {
      deliveryKey: string
      jobIds: string[]
      messageId: string
      outcome: 'pending' | 'succeeded' | 'failed' | 'cancelled'
    }
  | undefined => {
  const message = session.messages.find((candidate) => {
    const attribution = candidate.attribution
    return isComputeJobCompletionAttribution(attribution) && attribution.jobIds.includes(jobId)
  })
  if (!message || !isComputeJobCompletionAttribution(message.attribution)) return undefined
  return {
    deliveryKey: message.attribution.deliveryKey,
    jobIds: [...message.attribution.jobIds],
    messageId: message.id,
    outcome: computeDeliveryOutcome(session, message.id)
  }
}

const computeDeliveryOutcome = (
  session: ReturnType<typeof useSessionStore.getState>['sessions'][number],
  messageId: string
): 'pending' | 'succeeded' | 'failed' | 'cancelled' => {
  const prompt = session.messages.find((message) => message.id === messageId)
  if (!prompt || !isComputeJobCompletionAttribution(prompt.attribution)) return 'cancelled'
  if (prompt.interrupted) return 'cancelled'
  if (
    session.status === 'running' ||
    session.status === 'waiting-for-user' ||
    session.status === 'waiting-permission' ||
    session.status === 'waiting-plan-approval'
  ) {
    return 'pending'
  }
  const responses = session.messages.filter(
    (message) => message.role === 'agent' && message.responseToMessageId === messageId
  )
  if (session.status === 'error' || responses.some((message) => message.status === 'error')) {
    return 'failed'
  }
  return responses.some(
    (message) => message.status === 'complete' && message.completedAt !== undefined
  )
    ? 'succeeded'
    : 'pending'
}
