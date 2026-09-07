import { useEffect, useMemo, useState } from 'react'

import type { AgentResultDelivery } from '../../../../shared/agent-result-delivery'
import type { JobSummary } from '../../../../shared/compute'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'

// Shared data source for the composer-area background-task surfaces: the strip
// summary chip and the expandable "Background tasks" ledger. Local background
// Runs need the session's Notebook; all Compute Jobs stay observable without
// one or an awaiting delivery, so the hook must be callable before the
// Notebook reference exists.
type SessionBackgroundTasks = {
  /** Background Runs, active first, awaiting-delivery rows kept. */
  runs: NotebookRunRecord[]
  /** All Compute Jobs, active first. */
  jobs: JobSummary[]
  deliveryByRunId: Map<string, AgentResultDelivery>
  deliveryByJobId: Map<string, AgentResultDelivery>
  /** Ticks every second while anything is live; frozen otherwise. */
  now: number
  /** Dismisses one awaiting-agent row; removes it locally once the API confirms. */
  dismissDelivery: (deliveryId: string) => void
  /** Counts for the collapsed strip chip (no awaiting/attention breakdown by design). */
  summary: {
    activeCount: number
    oldestActiveStartedAt: number | undefined
    totalTasks: number
  }
}

const isRunActive = (run: NotebookRunRecord): boolean =>
  run.status === 'queued' || run.status === 'running'

const isJobActive = (job: JobSummary): boolean =>
  job.cancellation_status !== 'cancelled' &&
  (job.status === 'queued' || job.status === 'submitted' || job.status === 'running')

const jobStartedAt = (job: JobSummary): number => job.started_at ?? job.created_at

const useSessionBackgroundTasks = (
  sessionId: string | undefined,
  projectId: string | undefined,
  notebook: NotebookSessionReference | undefined
): SessionBackgroundTasks => {
  const [runs, setRuns] = useState<NotebookRunRecord[]>([])
  const [deliveries, setDeliveries] = useState<AgentResultDelivery[]>([])
  const [computeJobs, setComputeJobs] = useState<JobSummary[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!sessionId || !projectId) return
    let active = true
    let requestVersion = 0
    const load = async (): Promise<void> => {
      const version = ++requestVersion
      const [state, activity, jobs] = await Promise.all([
        notebook
          ? window.api.notebook.state(notebook).catch(() => undefined)
          : Promise.resolve(undefined),
        window.api.agentResultDelivery?.getSessionActivity({ sessionId }).catch(() => undefined),
        window.api.compute?.jobsList({ sessionId }).catch(() => undefined)
      ])
      if (!active || version !== requestVersion) return
      if (state) setRuns(state.runs.filter((run) => run.executionMode === 'background'))
      if (activity) setDeliveries([...activity.awaitingAgent])
      if (jobs) setComputeJobs(jobs)
    }
    const stopDelivery =
      window.api.agentResultDelivery?.onChanged?.((event) => {
        if (event.projectId === projectId) void load()
      }) ?? (() => undefined)
    const stop =
      window.api.notebook?.onChanged((event) => {
        if (event.sessionId === sessionId && event.projectId === projectId) {
          void load()
        }
      }) ?? (() => undefined)
    const stopCompute = window.api.compute?.onJobUpdated((job) => {
      if (job.session_id === sessionId && job.project_id === projectId) {
        void load()
      }
    })
    void load()
    const poll = window.setInterval(() => void load(), 30_000)
    return () => {
      active = false
      stopDelivery()
      stop()
      stopCompute?.()
      window.clearInterval(poll)
    }
  }, [notebook, projectId, sessionId])

  const deliveryByRunId = useMemo(
    () =>
      new Map(
        deliveries.flatMap((delivery) =>
          delivery.context.sourceKind === 'compute-job'
            ? []
            : [[delivery.context.runId, delivery] as const]
        )
      ),
    [deliveries]
  )
  const deliveryByJobId = useMemo(
    () =>
      new Map(
        deliveries.flatMap((delivery) =>
          delivery.context.sourceKind === 'compute-job'
            ? [[delivery.context.jobId, delivery] as const]
            : []
        )
      ),
    [deliveries]
  )
  const orderedRuns = useMemo(
    () =>
      [...runs]
        .filter((run) => isRunActive(run) || deliveryByRunId.has(run.runId))
        .sort((left, right) => {
          const leftActive = isRunActive(left)
          const rightActive = isRunActive(right)
          return leftActive === rightActive ? right.startedAt - left.startedAt : leftActive ? -1 : 1
        }),
    [deliveryByRunId, runs]
  )
  const orderedJobs = useMemo(
    () =>
      [...computeJobs].sort((left, right) => {
        const leftActive = isJobActive(left)
        const rightActive = isJobActive(right)
        return leftActive === rightActive ? right.created_at - left.created_at : leftActive ? -1 : 1
      }),
    [computeJobs]
  )

  const hasLiveRun = useMemo(
    () => orderedRuns.some(isRunActive) || orderedJobs.some(isJobActive),
    [orderedJobs, orderedRuns]
  )
  useEffect(() => {
    if (!hasLiveRun) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasLiveRun])

  const summary = useMemo(() => {
    const activeRuns = orderedRuns.filter(isRunActive)
    const activeJobs = orderedJobs.filter(isJobActive)
    const startedAts = [...activeRuns.map((run) => run.startedAt), ...activeJobs.map(jobStartedAt)]
    return {
      activeCount: activeRuns.length + activeJobs.length,
      oldestActiveStartedAt: startedAts.length > 0 ? Math.min(...startedAts) : undefined,
      totalTasks: orderedRuns.length + orderedJobs.length
    }
  }, [orderedJobs, orderedRuns])

  const dismissDelivery = (deliveryId: string): void => {
    if (!sessionId) return
    void window.api.agentResultDelivery
      ?.dismiss({ sessionId, deliveryId })
      .then((dismissed) => {
        if (dismissed) {
          setDeliveries((current) => current.filter((delivery) => delivery.id !== deliveryId))
        }
      })
      .catch(() => undefined)
  }

  return {
    runs: orderedRuns,
    jobs: orderedJobs,
    deliveryByRunId,
    deliveryByJobId,
    now,
    summary,
    dismissDelivery
  }
}

export { isJobActive, isRunActive, useSessionBackgroundTasks }
export type { SessionBackgroundTasks }
