// useJobAnalysisEffect — wires the job-analysis-trigger into the React component tree.
//
// Called from WorkspacePage (which owns `sendMessage` from useWorkspaceAgentRuntime).
// On every `compute:job-updated` broadcast AND once at session hydration time,
// the trigger is fed the job summary and decides whether to fire / queue an analysis turn.
//
// Design decisions:
// - One readiness-scoped effect owns the trigger and every subscription so delayed work cannot cross
//   a persistence recovery boundary.
// - `isSessionInFlight` reads from useSessionStore.getState() synchronously — no subscription needed.
// - The restart-recovery scan fires whenever the active session id changes (session navigation).

import { useEffect, useEffectEvent } from 'react'

import { isComputeJobCompletionAttribution } from '../../../../shared/session-persistence'
import { useSessionJobStore } from '../../stores/session-job-store'
import { useSessionStore } from '../../stores/session-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import { createJobAnalysisTrigger } from '../compute/job-analysis-trigger'

// Matches the sendMessage signature returned by useWorkspaceAgentRuntime.
type SendMessageFn = (input: {
  sessionId?: string
  text: string
  attribution?: Extract<
    NonNullable<ReturnType<typeof useSessionStore.getState>['sessions'][number]['messages'][number]['attribution']>,
    { feature: 'compute' }
  >
  requireExistingSession?: boolean
}) => Promise<{ sessionId: string; messageId: string } | undefined>

type UseJobAnalysisEffectOptions = {
  enabled: boolean
  sendMessage: SendMessageFn
}

// Subscribes to all done-state compute:job-updated broadcasts and runs the analysis turn trigger.
// Also scans for pending notifications on session load (restart recovery path).
export const useJobAnalysisEffect = ({
  enabled,
  sendMessage
}: UseJobAnalysisEffectOptions): void => {
  const sendLatestMessage = useEffectEvent(
    (input: Parameters<SendMessageFn>[0]): ReturnType<SendMessageFn> => sendMessage(input)
  )

  useEffect(() => {
    if (!enabled) return

    let isActive = true
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
        return sendLatestMessage({ sessionId, text, attribution, requireExistingSession: true })
      },
      findPersistedDelivery: (sessionId, jobId) => {
        const session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
        const message = session?.messages.find((candidate) => {
          const attribution = candidate.attribution
          return (
            isComputeJobCompletionAttribution(attribution) && attribution.jobIds.includes(jobId)
          )
        })
        if (!session || !message || !isComputeJobCompletionAttribution(message.attribution)) {
          return undefined
        }
        return {
          deliveryKey: message.attribution.deliveryKey,
          jobIds: [...message.attribution.jobIds],
          messageId: message.id,
          outcome: computeDeliveryOutcome(session, message.id)
        }
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
          // Refresh the in-memory job store so CompletedJobCard re-renders with consumed state.
          void useSessionJobStore.getState().hydrate(sessionId)
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

    const scanPendingJobs = (sessionId: string | undefined): void => {
      if (!sessionId) return
      if (typeof window.api?.compute?.jobsPendingNotification !== 'function') return

      void window.api.compute.jobsPendingNotification(sessionId).then((jobs) => {
        if (!isActive) return
        for (const job of jobs) trigger.onJobDone(job)
      })
    }

    const initialState = useSessionJobStore.getState()
    feedNotifiedJobs(initialState)
    scanPendingJobs(initialState.hydratedSessionId)

    const unsubscribeJobs = useSessionJobStore.subscribe((state, previousState) => {
      feedNotifiedJobs(state)
      if (state.hydratedSessionId !== previousState.hydratedSessionId) {
        scanPendingJobs(state.hydratedSessionId)
      }
    })

    return () => {
      isActive = false
      unsubscribeJobs()
      for (const unsubscribe of turnEndUnsubscribes) unsubscribe()
      turnEndUnsubscribes.clear()
    }
  }, [enabled])
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
  return responses.some((message) => message.status === 'complete' && message.completedAt !== undefined)
    ? 'succeeded'
    : 'pending'
}
