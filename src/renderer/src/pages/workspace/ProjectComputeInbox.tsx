import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Circle, Clock3, Cpu, Loader2, RadioTower } from 'lucide-react'

import type {
  AgentResultExecutionType,
  ProjectBackgroundActivityItem
} from '../../../../shared/agent-result-delivery'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectBackgroundActivityStore } from '@/stores/project-background-activity-store'
import { useSessionStore } from '@/stores/session-store'

type TypeFilter = 'all' | AgentResultExecutionType

const statusIcon = (item: ProjectBackgroundActivityItem): typeof Circle => {
  if (item.needsAttention) return AlertTriangle
  if (item.status === 'running') return Circle
  if (item.status === 'queued' || item.status === 'submitted') return Clock3
  if (item.status === 'cancelling') return Loader2
  return CheckCircle2
}

const localExecutionLabel = (
  type: AgentResultExecutionType,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  if (type === 'python') return t('Python Notebook Run')
  if (type === 'r') return t('R Notebook Run')
  if (type === 'repl') return t('JavaScript REPL')
  if (type === 'shell') return t('Shell Command')
  return t('Compute Job')
}

const ProjectComputeInbox = (): React.JSX.Element => {
  const { t } = useTranslation()
  const projectId = useNavigationStore((state) => state.activeProjectId)
  const openSession = useNavigationStore((state) => state.openSession)
  const sessions = useSessionStore((state) => state.sessions)
  const currentSessionId = useSessionStore((state) => state.selectedSessionId)
  const snapshot = useProjectBackgroundActivityStore((state) => state.snapshot)
  const hydrate = useProjectBackgroundActivityStore((state) => state.hydrate)
  const clear = useProjectBackgroundActivityStore((state) => state.clear)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [announcementRevision, setAnnouncementRevision] = useState(0)

  useEffect(() => {
    if (!projectId) {
      clear()
      return
    }
    let alive = true
    let requestVersion = 0
    const load = async (): Promise<void> => {
      const version = ++requestVersion
      const next = await window.api.agentResultDelivery
        .getProjectActivity({ projectId })
        .catch(() => undefined)
      if (alive && version === requestVersion && next) hydrate(projectId, next)
    }
    void load()
    const stopNotebook = window.api.notebook.onChanged((event) => {
      if (event.projectId === projectId) void load()
    })
    const stopCompute = window.api.compute?.onJobUpdated((job) => {
      if (job.project_id === projectId) void load()
    })
    const poll = window.setInterval(() => void load(), 2_000)
    return () => {
      alive = false
      stopNotebook()
      stopCompute?.()
      window.clearInterval(poll)
    }
  }, [clear, hydrate, projectId])

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session] as const)),
    [sessions]
  )
  const presentedItems = useMemo(
    () =>
      snapshot.items.map((item) => {
        const session = sessionById.get(item.sessionId)
        if (session && session.archivedAt === undefined) return item
        return {
          ...item,
          needsAttention: true,
          ...(!session ? { status: 'result-unavailable' as const, active: false } : {})
        }
      }),
    [sessionById, snapshot.items]
  )
  const visible = useMemo(
    () =>
      presentedItems.filter(
        (item) =>
          (typeFilter === 'all' || item.executionType === typeFilter) &&
          (!attentionOnly || item.needsAttention)
      ),
    [attentionOnly, presentedItems, typeFilter]
  )
  const groups = useMemo(() => {
    const grouped = new Map<string, ProjectBackgroundActivityItem[]>()
    for (const item of visible)
      grouped.set(item.sessionId, [...(grouped.get(item.sessionId) ?? []), item])
    return [...grouped.entries()]
      .map(([sessionId, items]) => ({
        sessionId,
        items,
        needsAttention: items.some((item) => item.needsAttention),
        updatedAt: Math.max(...items.map((item) => item.updatedAt))
      }))
      .sort((left, right) => {
        const leftCurrent = left.sessionId === currentSessionId
        const rightCurrent = right.sessionId === currentSessionId
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
        if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1
        return right.updatedAt - left.updatedAt
      })
  }, [currentSessionId, visible])

  const statusLabel = (item: ProjectBackgroundActivityItem): string => {
    const outcome = item.outcomeStatus
      ? item.outcomeStatus === 'completed' || item.outcomeStatus === 'success'
        ? t('Completed')
        : item.outcomeStatus === 'timeout'
          ? t('Timed out')
          : item.outcomeStatus === 'interrupted'
            ? t('Interrupted')
            : item.outcomeStatus === 'cancelled'
              ? t('Cancelled')
              : t('Failed')
      : undefined
    if (item.status === 'needs-attention')
      return outcome ? `${outcome} · ${t('Needs Agent')}` : t('Needs Agent')
    if (item.status === 'result-unavailable') return t('Result unavailable')
    if (item.status === 'pending-delivery')
      return outcome ? `${outcome} · ${t('Pending delivery')}` : t('Pending delivery')
    if (item.status === 'queued' || item.status === 'submitted') return t('Queued')
    if (item.status === 'running') return t('Running')
    if (item.status === 'cancelling') return t('Cancelling')
    if (item.status === 'completed' || item.status === 'success') return t('Completed')
    if (item.status === 'timeout') return t('Timed out')
    if (item.status === 'interrupted') return t('Interrupted')
    if (item.status === 'cancelled') return t('Cancelled')
    return t('Failed')
  }

  useEffect(() => {
    const signature = groups
      .flatMap((group) =>
        group.items.map(
          (item) =>
            `${item.id}:${item.status}:${item.outcomeStatus ?? ''}:${item.needsAttention}:${item.updatedAt}`
        )
      )
      .join('|')
    if (!signature) return
    const timer = window.setTimeout(() => setAnnouncementRevision((revision) => revision + 1), 500)
    return () => window.clearTimeout(timer)
  }, [groups])

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-bg-10"
      aria-labelledby="project-compute-title"
    >
      <header className="flex flex-wrap items-start gap-4 border-b border-border-200 px-6 py-4">
        <div className="min-w-[260px] flex-1">
          <h1 id="project-compute-title" className="text-lg font-semibold">
            {t('Compute')}
          </h1>
          <p className="mt-1 text-xs text-text-100">
            {t(
              'Project-level read-only inbox for active work and results awaiting Agent delivery.'
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-100">
          <span>{t('Type')}</span>
          <select
            className="rounded-md border border-border-200 bg-bg-000 px-2 py-1.5 text-text-000"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
          >
            <option value="all">{t('All types')}</option>
            <option value="python">{t('Python Notebook Run')}</option>
            <option value="r">{t('R Notebook Run')}</option>
            <option value="repl">{t('JavaScript REPL')}</option>
            <option value="shell">{t('Shell Command')}</option>
            <option value="compute-job">{t('Compute Job')}</option>
          </select>
        </label>
        <button
          type="button"
          aria-pressed={attentionOnly}
          className="rounded-md border border-border-200 bg-bg-000 px-2.5 py-1.5 text-xs hover:bg-bg-200"
          onClick={() => setAttentionOnly((value) => !value)}
        >
          {t('Needs attention')}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <aside className="mb-4 rounded-lg border border-status-info-border bg-status-info-surface p-3 text-xs leading-5 text-status-info-foreground dark:text-status-info-dark-foreground">
          <p>
            {t('Local Runs execute in this app. Compute Jobs execute on a remote Compute Host.')}
          </p>
          <p>
            {t(
              'Active means queued, running, or cancelling. Awaiting Agent means the execution ended but its outcome has not been successfully delivered.'
            )}
          </p>
          <p>
            {t(
              "Viewing this page does not consume a result. Consumed means the result was saved into the original Session's Agent context and that Agent Turn completed and was saved."
            )}
          </p>
          <p>{t("Lifecycle management is available only in the task's Session.")}</p>
        </aside>

        {groups.length === 0 ? (
          <div className="grid min-h-48 place-items-center rounded-lg border border-dashed border-border-200 text-sm text-text-100">
            {t('No visible compute activity')}
          </div>
        ) : (
          <div className="space-y-4" data-testid="project-compute-groups">
            {groups.map((group) => {
              const session = sessionById.get(group.sessionId)
              const active = group.items.filter((item) => item.active)
              const awaiting = group.items.filter((item) => !item.active)
              return (
                <section
                  key={group.sessionId}
                  className="overflow-hidden rounded-lg border border-border-200 bg-bg-000"
                >
                  <header className="flex items-center gap-2 bg-bg-200 px-3 py-2 text-sm font-semibold">
                    {group.needsAttention ? (
                      <AlertTriangle
                        className="size-4 text-status-warning-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <Cpu className="size-4 text-text-100" aria-hidden="true" />
                    )}
                    <span>{session?.title ?? t('Deleted Session')}</span>
                    {group.sessionId === currentSessionId ? (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] text-accent-foreground">
                        {t('Current Session')}
                      </span>
                    ) : null}
                    {session?.archivedAt !== undefined ? (
                      <span className="text-[10px] font-normal text-text-100">
                        {t('Archived Session')}
                      </span>
                    ) : null}
                  </header>
                  {[
                    { label: t('Active'), items: active },
                    { label: t('Awaiting Agent'), items: awaiting }
                  ].map((section) =>
                    section.items.length ? (
                      <div key={section.label}>
                        <div className="border-t border-border-200 bg-bg-100 px-3 py-1 text-[10px] font-semibold tracking-wide text-text-300 uppercase">
                          {section.label}
                        </div>
                        {section.items.map((item) => {
                          const StatusIcon = statusIcon(item)
                          return (
                            <div
                              key={item.id}
                              className="grid min-w-[720px] grid-cols-[minmax(240px,1.5fr)_minmax(150px,1fr)_140px_130px] items-center gap-3 border-t border-border-200 px-3 py-2 text-xs"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                {item.sourceKind === 'compute-job' ? (
                                  <RadioTower className="size-4 shrink-0" aria-hidden="true" />
                                ) : (
                                  <Cpu className="size-4 shrink-0" aria-hidden="true" />
                                )}
                                <div className="min-w-0">
                                  <div className="truncate font-medium" title={item.title}>
                                    {item.title}
                                  </div>
                                  <div className="text-[10px] text-text-100">
                                    {item.sourceKind === 'compute-job'
                                      ? t('Remote Compute Job')
                                      : `${t('Local Run')} · ${localExecutionLabel(item.executionType, t)}`}
                                  </div>
                                </div>
                              </div>
                              <span className="truncate text-text-100" title={item.lane}>
                                {item.lane ?? '—'}
                              </span>
                              <span className="flex items-center gap-1.5 text-text-100">
                                <StatusIcon
                                  className={
                                    item.status === 'cancelling'
                                      ? 'size-3.5 animate-spin motion-reduce:animate-none'
                                      : 'size-3.5'
                                  }
                                  aria-hidden="true"
                                />
                                {statusLabel(item)}
                              </span>
                              <button
                                type="button"
                                disabled={!session}
                                className="rounded-md border border-border-200 px-2 py-1 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={() =>
                                  projectId && openSession(projectId, item.sessionId, 'user')
                                }
                              >
                                {t('Go to Session')}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    ) : null
                  )}
                </section>
              )
            })}
          </div>
        )}
        {snapshot.truncated ? (
          <p className="mt-3 text-xs text-text-100">
            {t('Showing the 200 most recently updated visible tasks.')}
          </p>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={announcementRevision}>
          {announcementRevision > 0 ? t('Compute activity updated.') : null}
        </span>
      </p>
    </section>
  )
}

export { ProjectComputeInbox }
