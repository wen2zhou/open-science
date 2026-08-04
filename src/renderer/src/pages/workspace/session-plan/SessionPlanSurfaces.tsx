import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { useState } from 'react'

type PlanSurfaceProps = Readonly<{ projection: ActivePlanProjection }>

const plural = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? '' : 's'}`

const lifecycleLabel = (projection: ActivePlanProjection): string => {
  switch (projection.lifecycle) {
    case 'awaiting_approval':
      return 'Plan ready for review'
    case 'completed':
      return 'Plan completed'
    case 'rejected':
      return 'Plan rejected'
    case 'approved':
      return 'Plan approved'
    case 'interrupted':
      return 'Plan interrupted'
    case 'blocked':
      return 'Plan blocked'
    default:
      return 'Plan in progress'
  }
}

const progressTitle = (projection: ActivePlanProjection): string => {
  if (projection.lifecycle === 'awaiting_approval') return 'Awaiting plan approval'
  if (projection.lifecycle === 'completed') return `Completed · ${projection.counts.steps} steps`
  if (projection.lifecycle === 'interrupted') return 'Plan interrupted'
  const running = Object.entries(projection.stepStatuses).filter(
    ([, value]) => value.status === 'in_progress'
  )
  if (running.length > 1) return `${running.length} steps running in parallel`
  if (running.length === 1) return running[0][0]
  const blocked = Object.entries(projection.stepStatuses).find(
    ([, value]) => value.status === 'blocked'
  )
  if (blocked) return `Blocked · ${blocked[0]}`
  return lifecycleLabel(projection)
}

const stepStatusLabel = (status: ActivePlanProjection['stepStates'][string]['status']): string =>
  status.replaceAll('_', ' ')

type StepProjectionStatus = ActivePlanProjection['stepStates'][string]['status']

const STEP_STATUS_PRESENTATION: Record<
  StepProjectionStatus,
  Readonly<{ mark: string; className: string }>
> = {
  completed: { mark: '✓', className: 'border-primary bg-primary text-primary-foreground' },
  in_progress: {
    mark: '●',
    className: 'rounded-full border-primary/30 bg-primary/10 text-primary'
  },
  blocked: {
    mark: '!',
    className: 'border-destructive/30 bg-destructive/10 text-destructive'
  },
  skipped: { mark: '–', className: 'bg-muted text-muted-foreground' },
  not_run: { mark: '', className: 'bg-muted text-muted-foreground' },
  not_started: { mark: '', className: 'border-border text-muted-foreground' }
}

const WorkspacePlanCard = ({
  projection,
  onOpen,
  onRespond,
  onSubmitApprovalText
}: PlanSurfaceProps &
  Readonly<{
    onOpen: () => void
    onRespond: (decision: 'approved' | 'rejected') => Promise<void>
    onSubmitApprovalText?: (text: string) => Promise<void>
  }>): React.JSX.Element => {
  const decisionPending = projection.approval === 'pending'
  const [responseText, setResponseText] = useState('')
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionError, setDecisionError] = useState<string>()
  const respond = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (decisionBusy) return
    setDecisionBusy(true)
    setDecisionError(undefined)
    try {
      await onRespond(decision)
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : 'Unable to update the Plan.')
    } finally {
      setDecisionBusy(false)
    }
  }
  return (
    <article className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-56 flex-1">
            <div className="text-xs text-muted-foreground">{lifecycleLabel(projection)}</div>
            <div className="mt-1 text-[17px] font-medium text-foreground">
              {projection.document.task_summary}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {plural(projection.counts.phases, 'phase')} ·{' '}
              {plural(projection.counts.delegations, 'delegation')} ·{' '}
              {plural(projection.counts.steps, 'step')}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={onOpen}
            >
              Open
            </button>
            {decisionPending ? (
              <>
                <button
                  type="button"
                  className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  disabled={decisionBusy}
                  onClick={() => void respond('rejected')}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="h-8 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  disabled={decisionBusy}
                  onClick={() => void respond('approved')}
                >
                  Approve
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="mt-3 inline-flex rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
          ● {projection.document.feasibility.confidence} confidence
        </div>
        {decisionPending ? (
          <form
            className="mt-3 border-t border-border pt-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (decisionBusy) return
              if (responseText.trim().toLowerCase() !== 'approve') {
                setDecisionError('This Plan version supports explicit approval only.')
                return
              }
              setDecisionBusy(true)
              setDecisionError(undefined)
              void (onSubmitApprovalText?.(responseText) ?? onRespond('approved'))
                .catch((error: unknown) =>
                  setDecisionError(
                    error instanceof Error ? error.message : 'Unable to update the Plan.'
                  )
                )
                .finally(() => setDecisionBusy(false))
            }}
          >
            <label className="sr-only" htmlFor={`plan-response-${projection.artifactVersionId}`}>
              Respond to Plan
            </label>
            <input
              id={`plan-response-${projection.artifactVersionId}`}
              className="h-9 w-full rounded bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="Describe changes, or type “approve”…"
              value={responseText}
              disabled={decisionBusy}
              onChange={(event) => setResponseText(event.target.value)}
            />
            {decisionError ? (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {decisionError}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="mt-3 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary">
            {projection.lifecycle === 'completed'
              ? 'Completed · This plan remains active until a new plan is generated.'
              : `${lifecycleLabel(projection)}.`}
          </div>
        )}
      </div>
    </article>
  )
}

const PlanProgressDock = ({
  projection,
  onOpen
}: PlanSurfaceProps & Readonly<{ onOpen: () => void }>): React.JSX.Element => {
  const percent =
    projection.counts.steps === 0
      ? 0
      : Math.round((projection.counts.completed / projection.counts.steps) * 100)
  const running =
    projection.lifecycle === 'in_progress'
      ? Object.values(projection.stepStatuses).filter((value) => value.status === 'in_progress')
          .length
      : 0
  return (
    <div className="mb-2 grid grid-cols-[auto_minmax(120px,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-bg-200/95 px-3 py-2 shadow-card">
      <div className="min-w-0">
        <strong className="block truncate text-xs">{progressTitle(projection)}</strong>
        <span className="text-[11px] text-muted-foreground">
          {running > 0 ? `${running} running · ` : ''}
          {projection.counts.completed}/{projection.counts.steps} done
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <button
        type="button"
        className="rounded text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onOpen}
      >
        Open plan
      </button>
    </div>
  )
}

const PlanPreviewSurface = ({ projection }: PlanSurfaceProps): React.JSX.Element => (
  <div className="h-full overflow-auto bg-bg-10 px-8 py-8 text-foreground">
    <h1 className="text-[22px] font-semibold">{projection.document.task_summary}</h1>
    <p className="mt-1 text-sm text-muted-foreground">
      Complete phases in order. Delegations within a phase may run in parallel.
    </p>
    {projection.document.phases.map((phase, phaseIndex) => (
      <section key={phase.name} className="mt-7 border-t border-border pt-6">
        <div className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
          PHASE {phaseIndex + 1}
        </div>
        <h2 className="mt-1 text-lg font-medium">{phase.name}</h2>
        {phase.delegations.map((delegation) => (
          <div key={delegation.name} className="mt-4 border-l border-border pl-5">
            <div className="font-medium">{delegation.name}</div>
            {delegation.steps.map((step) => {
              const runtime = projection.stepStatuses[step.title]
              const state = projection.stepStates?.[step.title] ?? {
                status: runtime?.status ?? ('not_started' as const),
                ...(runtime?.notes ? { notes: runtime.notes } : {})
              }
              const showNote =
                state?.notes && (state.status === 'blocked' || state.status === 'skipped')
              const presentation = STEP_STATUS_PRESENTATION[state.status]
              return (
                <div key={step.title} className="mt-3 grid grid-cols-[18px_1fr] gap-2">
                  <span
                    aria-label={`${step.title} status: ${stepStatusLabel(state.status)}`}
                    className={`mt-0.5 grid size-4 place-items-center rounded border text-[10px] ${presentation.className}`}
                  >
                    {presentation.mark}
                  </span>
                  <div>
                    <div className="text-sm font-medium">{step.title}</div>
                    <div className="text-xs text-muted-foreground">{step.description}</div>
                    {showNote ? (
                      <div className="mt-1.5 rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                        {state.notes}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </section>
    ))}
    <div className="mt-7 rounded-lg bg-muted p-4">
      <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground">
        SCOPE &amp; FEASIBILITY · {projection.document.feasibility.confidence.toUpperCase()}{' '}
        CONFIDENCE
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {projection.document.feasibility.rationale}
      </p>
    </div>
  </div>
)

export { PlanPreviewSurface, PlanProgressDock, WorkspacePlanCard }
