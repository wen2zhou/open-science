import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleCheck, CircleX, Clock3, Loader2 } from 'lucide-react'

import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import type { AgentResultDelivery } from '../../../../shared/agent-result-delivery'

type Props = {
  notebook: NotebookSessionReference
  onOpenNotebook: (notebook: NotebookSessionReference, runId?: string) => void
}

const terminalStatuses = new Set<NotebookRunRecord['status']>([
  'completed',
  'failed',
  'timeout',
  'interrupted',
  'cancelled'
])

const elapsed = (run: NotebookRunRecord, now: number): string => {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

const taskName = (run: NotebookRunRecord): string =>
  run.script
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 80) || run.runId

const shellLaneLabel = (
  run: NotebookRunRecord,
  t: (key: string, values?: Record<string, number>) => string
): string | undefined => {
  if (run.kernelKind !== 'bash') return undefined
  const concurrency = run.shellConcurrency
  return concurrency?.slot
    ? t('Shell slot {{slot}} of {{limit}}', {
        slot: concurrency.slot,
        limit: concurrency.limit
      })
    : t('Waiting for shell slot')
}

const SessionBackgroundActivity = ({
  notebook,
  onOpenNotebook
}: Props): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<NotebookRunRecord[]>([])
  const [deliveries, setDeliveries] = useState<AgentResultDelivery[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const [state, activity] = await Promise.all([
        window.api.notebook.state(notebook).catch(() => undefined),
        window.api.agentResultDelivery
          .getSessionActivity({ sessionId: notebook.sessionId })
          .catch(() => undefined)
      ])
      if (!active || !state) return
      setRuns(state.runs.filter((run) => run.executionMode === 'background'))
      if (activity) setDeliveries([...activity.awaitingAgent])
      setCancelling((current) => {
        const next = new Set(
          [...current].filter((runId) =>
            state.runs.some(
              (run) => run.runId === runId && (run.status === 'queued' || run.status === 'running')
            )
          )
        )
        return next
      })
    }
    void load()
    const stop = window.api.notebook.onChanged((event) => {
      if (event.sessionId === notebook.sessionId && event.projectId === notebook.projectId) {
        void load()
      }
    })
    return () => {
      active = false
      stop()
    }
  }, [notebook])

  const hasLiveRun = runs.some((run) => run.status === 'queued' || run.status === 'running')
  useEffect(() => {
    if (!hasLiveRun) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasLiveRun])

  useEffect(() => {
    if (deliveries.length === 0) return
    const timer = window.setInterval(() => {
      void window.api.agentResultDelivery
        .getSessionActivity({ sessionId: notebook.sessionId })
        .then((activity) => setDeliveries([...activity.awaitingAgent]))
        .catch(() => undefined)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [deliveries.length, notebook.sessionId])

  const deliveryByRunId = useMemo(
    () => new Map(deliveries.map((delivery) => [delivery.context.runId, delivery])),
    [deliveries]
  )
  const ordered = useMemo(
    () =>
      [...runs]
        .filter(
          (run) =>
            run.status === 'queued' || run.status === 'running' || deliveryByRunId.has(run.runId)
        )
        .sort((left, right) => {
          const leftActive = left.status === 'queued' || left.status === 'running'
          const rightActive = right.status === 'queued' || right.status === 'running'
          return leftActive === rightActive ? right.startedAt - left.startedAt : leftActive ? -1 : 1
        }),
    [deliveryByRunId, runs]
  )
  if (ordered.length === 0) return null

  const statusLabel = (run: NotebookRunRecord): string => {
    if (cancelling.has(run.runId)) return t('Cancelling')
    const delivery = deliveryByRunId.get(run.runId)
    if (delivery?.state === 'needs-attention') return t('Needs Agent')
    if (delivery) return t('Pending delivery')
    switch (run.status) {
      case 'queued':
        return t('Queued')
      case 'running':
        return t('Running')
      case 'completed':
        return t('Completed')
      case 'failed':
        return t('Failed')
      case 'timeout':
        return t('Timed out')
      case 'interrupted':
        return t('Interrupted')
      case 'cancelled':
        return t('Cancelled')
    }
  }

  return (
    <section
      className="relative z-10 mb-2 overflow-x-auto rounded-xl border border-border-200 bg-bg-000"
      aria-label={t('Session activity')}
      data-testid="session-background-activity"
    >
      <div className="grid min-w-[680px] grid-cols-[minmax(180px,1.4fr)_110px_110px_90px_140px] items-center gap-2 bg-bg-200 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-text-300 uppercase">
        <span>{t('Session activity')}</span>
        <span>{t('Lane')}</span>
        <span>{t('Status')}</span>
        <span>{t('Elapsed')}</span>
        <span className="text-right">{t('Manage in Session')}</span>
      </div>
      {ordered.map((run, index) => {
        const isActive = run.status === 'queued' || run.status === 'running'
        const previous = ordered[index - 1]
        const previousActive =
          previous && (previous.status === 'queued' || previous.status === 'running')
        const showGroup = index === 0 || previousActive !== isActive
        const isCancelling = cancelling.has(run.runId)
        const delivery = deliveryByRunId.get(run.runId)
        const StatusIcon = isCancelling
          ? Loader2
          : run.status === 'completed'
            ? CircleCheck
            : terminalStatuses.has(run.status)
              ? CircleX
              : run.status === 'queued'
                ? Clock3
                : Circle
        return (
          <Fragment key={run.runId}>
            {showGroup ? (
              <div className="min-w-[680px] border-t border-border-200 bg-bg-100 px-3 py-1 text-[10px] font-semibold tracking-wide text-text-300 uppercase">
                {isActive ? t('Active') : t('Awaiting Agent')}
              </div>
            ) : null}
            <div className="grid min-h-10 min-w-[680px] grid-cols-[minmax(180px,1.4fr)_110px_110px_90px_140px] items-center gap-2 border-t border-border-200 px-3 py-1.5 text-[11px]">
              <span className="min-w-0 truncate font-medium" title={taskName(run)}>
                <span className="mr-2 inline-grid min-h-6 place-items-center rounded-md bg-bg-200 px-2 font-mono text-[10px] text-text-100">
                  {run.kernelKind === 'bash'
                    ? t('Shell Command')
                    : run.kernelKind === 'repl'
                      ? t('JavaScript REPL')
                      : run.kernelKind === 'r'
                        ? 'R'
                        : 'Python'}
                </span>
                {taskName(run)}
              </span>
              <span className="truncate text-text-100">
                {run.kernelKind === 'repl'
                  ? t('Persistent REPL')
                  : (shellLaneLabel(run, t) ??
                    run.environment ??
                    (run.kernelKind === 'r' ? 'R' : 'Python'))}
              </span>
              <span className="flex items-center gap-1.5 text-text-100" aria-live="polite">
                <StatusIcon
                  className={
                    isCancelling ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'
                  }
                  aria-hidden="true"
                />
                {statusLabel(run)}
              </span>
              <span className="tabular-nums text-text-100">{elapsed(run, now)}</span>
              <span className="flex justify-end gap-1">
                <button
                  type="button"
                  className="rounded-md border border-border-200 px-2 py-1 hover:bg-bg-200"
                  onClick={() => onOpenNotebook(notebook, run.runId)}
                >
                  {t('Open')}
                </button>
                {isActive ? (
                  <button
                    type="button"
                    disabled={isCancelling}
                    className="rounded-md border border-border-200 px-2 py-1 text-status-failure-foreground hover:bg-status-failure-surface disabled:opacity-50 dark:text-status-failure-dark-foreground"
                    onClick={() => {
                      setCancelling((current) => new Set(current).add(run.runId))
                      void window.api.notebook
                        .cancelBackgroundRun({
                          ...notebook,
                          runId: run.runId,
                          agentFrameId: run.agentFrameId
                        })
                        .catch(() =>
                          setCancelling((current) => {
                            const next = new Set(current)
                            next.delete(run.runId)
                            return next
                          })
                        )
                    }}
                  >
                    {t('Cancel')}
                  </button>
                ) : delivery ? (
                  <button
                    type="button"
                    className="rounded-md border border-border-200 px-2 py-1 hover:bg-bg-200"
                    onClick={() => {
                      void window.api.agentResultDelivery
                        .dismiss({ sessionId: notebook.sessionId, deliveryId: delivery.id })
                        .then((dismissed) => {
                          if (dismissed) {
                            setDeliveries((current) =>
                              current.filter((candidate) => candidate.id !== delivery.id)
                            )
                          }
                        })
                    }}
                  >
                    {t('Dismiss')}
                  </button>
                ) : null}
              </span>
            </div>
          </Fragment>
        )
      })}
    </section>
  )
}

export { SessionBackgroundActivity }
