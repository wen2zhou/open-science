import { AlertCircle, Bot, ChevronRight, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ChatSession } from '@/stores/session-store'
import {
  createSessionSubagentsPreviewItem,
  type PreviewToolItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import { cn } from '@/lib/utils'

import { WorkspaceMessageEditStateProvider } from './workspace-message-edit-state'
import { WorkspaceMessageScroller } from './WorkspaceMessageScroller'
import {
  projectSessionSubagents,
  resolveDelegatedWorkAvailability,
  selectSubagentFrame,
  type SessionSubagentChild,
  type SubagentRawStatus
} from './subagent-release-projection'

const returnFocusBySession = new Map<string, HTMLElement>()

const statusDotClassName: Record<SubagentRawStatus, string> = {
  running: 'bg-primary',
  completed: 'bg-success-000',
  cancelled: 'bg-warning-100',
  error: 'bg-danger-000'
}

const SubagentStatus = ({
  status,
  awaitingPermission = false
}: {
  status: SubagentRawStatus
  awaitingPermission?: boolean
}): React.JSX.Element => (
  <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-text-300">
    <span className={cn('size-1.5 rounded-full', statusDotClassName[status])} aria-hidden="true" />
    <span className="capitalize" data-subagent-status={status}>
      {status}
    </span>
    {awaitingPermission ? <span className="text-primary">Waiting for permission</span> : null}
  </span>
)

const openSubagentPreview = (
  session: ChatSession,
  child: SessionSubagentChild,
  trigger?: HTMLElement,
  preserveSelection = false
): void => {
  if (trigger) returnFocusBySession.set(session.id, trigger)
  const store = usePreviewWorkbenchStore.getState()
  const existing = store.items.find((item) => item.id === `tool:${session.id}:subagents`)
  const selectedAgentFrameId =
    preserveSelection && existing?.type === 'tool' && existing.selectedAgentFrameId
      ? existing.selectedAgentFrameId
      : child.frameId
  store.upsertAndActivateItem(
    createSessionSubagentsPreviewItem(session.id, session.projectId, selectedAgentFrameId)
  )
}

type SubagentSurfaceProps = {
  session: ChatSession | undefined
  permissions: readonly AcpPermissionRequest[]
}

const SubagentSummaryCard = ({
  session,
  permissions
}: SubagentSurfaceProps): React.JSX.Element | null => {
  const summary = useMemo(
    () => projectSessionSubagents(session, permissions),
    [permissions, session]
  )
  if (!session || summary.children.length === 0) return null

  return (
    <section
      role="region"
      aria-label="Subagent summary"
      className="mx-auto my-3 w-full max-w-[56rem] overflow-hidden rounded-xl border border-border-200 bg-bg-000 shadow-card"
    >
      <div className="flex items-center gap-2 px-4 py-3 text-[12px] font-semibold text-text-000">
        <Bot className="size-4" aria-hidden="true" />
        <span>Subagents</span>
        <span className="font-normal text-text-300">{summary.children.length} · read-only</span>
      </div>
      <div className="border-t border-border-200">
        {summary.children.map((child) => (
          <button
            key={child.frameId}
            type="button"
            aria-label={`${child.title}, ${child.status}${child.awaitingPermission ? ', waiting for permission' : ''}`}
            className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-100 px-4 py-2 text-left last:border-b-0 hover:bg-bg-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
            onClick={(event) => openSubagentPreview(session, child, event.currentTarget)}
          >
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-text-000">
                {child.title}
              </span>
              <span className="block truncate text-[10px] text-text-300">{child.agentLabel}</span>
            </span>
            <SubagentStatus status={child.status} awaitingPermission={child.awaitingPermission} />
            <ChevronRight className="size-3.5 text-text-300" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  )
}

const SubagentComposerAggregate = ({
  session,
  permissions
}: SubagentSurfaceProps): React.JSX.Element | null => {
  const summary = useMemo(
    () => projectSessionSubagents(session, permissions),
    [permissions, session]
  )
  const firstRunning = summary.children.find(({ status }) => status === 'running')
  if (!session || !firstRunning || summary.runningCount === 0) return null
  const label = `${summary.runningCount} ${summary.runningCount === 1 ? 'subagent' : 'subagents'} running`

  return (
    <button
      type="button"
      aria-label={label}
      aria-live="polite"
      className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-text-300 hover:bg-bg-200 hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={(event) => openSubagentPreview(session, firstRunning, event.currentTarget, true)}
    >
      <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {label}
    </button>
  )
}

const SubagentAvailabilityNotice = ({
  frameworkId,
  frameworks,
  unavailableReason,
  onOpenSettings
}: {
  frameworkId: AgentFrameworkId
  frameworks: readonly AgentFrameworkView[]
  unavailableReason?: string
  onOpenSettings: () => void
}): React.JSX.Element | null => {
  const availability = resolveDelegatedWorkAvailability(frameworkId, frameworks)
  if (availability.available && !unavailableReason) return null
  const framework = frameworks.find(({ id }) => id === frameworkId)
  const title = unavailableReason
    ? 'Subagents unavailable for this configuration'
    : availability.available
      ? `Subagents unavailable for ${framework?.displayName ?? frameworkId}`
      : availability.title
  const description = unavailableReason ?? (availability.available ? '' : availability.description)

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded-lg border border-border-200 bg-bg-200 px-3 py-2 text-[11px] leading-4 text-text-300"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong className="block text-text-100">{title}</strong>
        {description}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md border border-border-200 bg-bg-000 px-2 py-1 text-text-100 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onOpenSettings}
      >
        Open Settings
      </button>
    </div>
  )
}

const childConversationSession = (
  session: ChatSession,
  detail: NonNullable<ReturnType<typeof selectSubagentFrame>>
): ChatSession => ({
  ...session,
  status: detail.status === 'running' ? 'running' : detail.status === 'error' ? 'error' : 'idle',
  error: detail.attempt?.error?.message,
  activeRun: undefined,
  messages: [...detail.messages],
  // Child activities already live in the authoritative graph. The transcript selects message-owned
  // artifacts and Reviews through the same Session owners as the root surface.
  activities: session.conversationGraph?.activities
    .filter((activity) => activity.agentFrameId === detail.frameId)
    .map(({ agentFrameId, messageBranchId, runtimeSegmentId, ...activity }) => {
      void agentFrameId
      void messageBranchId
      void runtimeSegmentId
      return activity
    }) as ChatSession['activities'],
  activityGroups: session.conversationGraph?.activityGroups
    .filter((group) => group.agentFrameId === detail.frameId)
    .map(({ agentFrameId, messageBranchId, ...group }) => {
      void agentFrameId
      void messageBranchId
      return group
    })
})

const SubagentPreview = ({
  item,
  returnFocus
}: {
  item: PreviewToolItem
  returnFocus?: HTMLElement
}): React.JSX.Element => {
  const session = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.id === item.sessionId)
  )
  const summary = useMemo(() => projectSessionSubagents(session, []), [session])
  const initialFrameId = item.selectedAgentFrameId ?? summary.children[0]?.frameId
  const [selectedFrameId, setSelectedFrameId] = useState(
    item.selectedAgentFrameId ?? initialFrameId ?? ''
  )
  const effectiveFrameId = selectedFrameId || initialFrameId || ''
  const [isRetrying, setIsRetrying] = useState(false)
  const detail = useMemo(
    () => selectSubagentFrame(session, effectiveFrameId),
    [effectiveFrameId, session]
  )

  const selectFrame = (frameId: string): void => {
    setSelectedFrameId(frameId)
    usePreviewWorkbenchStore
      .getState()
      .upsertItem(createSessionSubagentsPreviewItem(item.sessionId, item.projectId, frameId))
  }

  const close = (): void => {
    usePreviewWorkbenchStore.getState().collapsePanel()
    const target = returnFocus ?? returnFocusBySession.get(item.sessionId)
    returnFocusBySession.delete(item.sessionId)
    target?.focus()
  }

  const retryRead = async (): Promise<void> => {
    if (isRetrying) return
    setIsRetrying(true)
    try {
      const result = await window.api.sessions.loadAll()
      const durable = result.sessions.find((candidate) => candidate.id === item.sessionId)
      if (durable) useSessionStore.getState().upsertPersistedSession(durable)
    } catch {
      // The alert remains visible and the action remains retryable.
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <section className="flex size-full min-h-0 flex-col bg-bg-000" aria-label="Subagents">
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border-200 bg-bg-10 px-3 py-2">
        <label htmlFor={`subagent-frame-${item.sessionId}`} className="sr-only">
          Subagent Frame
        </label>
        <select
          id={`subagent-frame-${item.sessionId}`}
          aria-label="Subagent Frame"
          value={effectiveFrameId}
          className="min-w-0 flex-1 rounded-md border border-border-200 bg-bg-000 px-2 py-1.5 text-[12px] text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onChange={(event) => selectFrame(event.target.value)}
        >
          {summary.children.map((child) => (
            <option key={child.frameId} value={child.frameId}>
              {child.title}
            </option>
          ))}
        </select>
        {detail ? <SubagentStatus status={detail.status} /> : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Close Subagents preview"
                className="grid size-8 shrink-0 place-items-center rounded-md text-text-300 hover:bg-bg-200 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={close}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close Subagents preview</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>

      {!detail || !session ? (
        <div role="alert" className="m-auto max-w-sm p-6 text-center text-[12px] text-text-300">
          <AlertCircle className="mx-auto mb-2 size-5" aria-hidden="true" />
          <p>This Subagent conversation could not be read.</p>
          <button
            type="button"
            aria-label="Retry Subagent preview"
            disabled={isRetrying}
            className="mt-3 rounded-md border border-border-200 px-3 py-1.5 text-text-100 hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => void retryRead()}
          >
            {isRetrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" aria-live="off">
          <div className="shrink-0 border-b border-border-100 px-4 py-2 text-[11px] text-text-300">
            <span className="font-medium text-text-100">{detail.agentLabel}</span>
            {detail.attempt?.cancellationReason ? (
              <span> · {detail.attempt.cancellationReason}</span>
            ) : null}
            {detail.attempt?.error?.message ? (
              <span className="block pt-1 text-danger-000">{detail.attempt.error.message}</span>
            ) : null}
          </div>
          <WorkspaceMessageEditStateProvider canEditMessage={false}>
            <WorkspaceMessageScroller
              activeSession={childConversationSession(session, detail)}
              onSendEditedMessage={() => undefined}
            />
          </WorkspaceMessageEditStateProvider>
        </div>
      )}
    </section>
  )
}

export {
  SubagentComposerAggregate,
  SubagentAvailabilityNotice,
  SubagentPreview,
  SubagentSummaryCard
}
