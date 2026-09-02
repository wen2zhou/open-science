import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleCheck, CircleX, Clock3, Loader2 } from 'lucide-react'

import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'

type Props = {
  notebook: NotebookSessionReference
  onOpenNotebook: (notebook: NotebookSessionReference) => void
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

const SessionBackgroundActivity = ({
  notebook,
  onOpenNotebook
}: Props): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<NotebookRunRecord[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const state = await window.api.notebook.state(notebook).catch(() => undefined)
      if (!active || !state) return
      setRuns(state.runs.filter((run) => run.executionMode === 'background'))
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

  const ordered = useMemo(
    () => [...runs].sort((left, right) => right.startedAt - left.startedAt),
    [runs]
  )
  if (ordered.length === 0) return null

  const statusLabel = (run: NotebookRunRecord): string => {
    if (cancelling.has(run.runId)) return t('Cancelling')
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
      {ordered.map((run) => {
        const isActive = run.status === 'queued' || run.status === 'running'
        const isCancelling = cancelling.has(run.runId)
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
          <div
            key={run.runId}
            className="grid min-h-10 min-w-[680px] grid-cols-[minmax(180px,1.4fr)_110px_110px_90px_140px] items-center gap-2 border-t border-border-200 px-3 py-1.5 text-[11px]"
          >
            <span className="min-w-0 truncate font-medium" title={taskName(run)}>
              <span className="mr-2 inline-grid size-6 place-items-center rounded-md bg-bg-200 font-mono text-[10px] text-text-100">
                {run.kernelKind === 'r' ? 'R' : 'Python'}
              </span>
              {taskName(run)}
            </span>
            <span className="truncate text-text-100">
              {run.environment ?? (run.kernelKind === 'r' ? 'R' : 'Python')}
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
                onClick={() => onOpenNotebook(notebook)}
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
                      .cancelBackgroundRun({ ...notebook, runId: run.runId })
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
              ) : null}
            </span>
          </div>
        )
      })}
    </section>
  )
}

export { SessionBackgroundActivity }
