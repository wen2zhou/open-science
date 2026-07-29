// Approval card that renders the structured Specialist mutation preview produced by the app-owned
// Specialist management MCP (issue 04a). When Customize proposes a create/update/enable/disable/
// duplicate/delete/switch, the preview is shown here for an explicit user decision before anything
// is written. Declining changes nothing; approving confirms the mutation through the management MCP.
//
// The card shows identity, an instructions-change summary (never the raw text), the COMPLETE target
// Skill and Connector sets, the expected revision, and affected-session availability — the full
// post-mutation state, not just the diff.

import { Check, ShieldAlert, Sparkles, X } from 'lucide-react'

import type { SpecialistMutationPreview } from '../../../../shared/specialist-preview'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const ACTION_LABELS: Record<string, string> = {
  create: 'Create specialist',
  update: 'Update specialist',
  duplicate: 'Duplicate specialist',
  enable: 'Enable specialist',
  disable: 'Disable specialist',
  delete: 'Delete specialist',
  switch: 'Switch session specialist'
}

const actionLabel = (action: string): string => ACTION_LABELS[action] ?? action

type SpecialistMutationApprovalCardProps = {
  preview: SpecialistMutationPreview
  // True while the confirmation call is in flight; disables both buttons.
  pending?: boolean
  // Approving routes the stored mutationId through the management MCP to execute exactly once.
  onApprove: () => void
  // Declining cancels the staged mutation with no side effects.
  onDecline: () => void
}

export const SpecialistMutationApprovalCard = ({
  preview,
  pending = false,
  onApprove,
  onDecline
}: SpecialistMutationApprovalCardProps): React.JSX.Element => {
  const isDelete = preview.action === 'delete'
  const isDisable = preview.action === 'disable'
  const destructive = isDelete || isDisable
  const instructionsChanged = preview.instructionsSummary.changed
  const sessionsAvailable = preview.affectedSessions?.available

  return (
    <div
      data-testid="specialist-mutation-approval"
      data-action={preview.action}
      className="overflow-hidden rounded-xl border border-border bg-bg-000"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            destructive
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
              : 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
          )}
        >
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            Customize proposes: {actionLabel(preview.action)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Review the change before it is written. Approving runs it once; declining leaves
            everything untouched.
          </p>
        </div>
      </div>

      <dl className="divide-y divide-border px-4 text-sm">
        {/* Identity */}
        <div className="grid grid-cols-[max-content_1fr] gap-x-3 py-2.5">
          <dt className="text-muted-foreground">Identity</dt>
          <dd data-testid="approval-identity" className="min-w-0">
            <span className="font-medium">{preview.identity.name}</span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {preview.identity.agentId}
            </span>
          </dd>
        </div>

        {/* Instructions change summary (never the raw text) */}
        <div className="grid grid-cols-[max-content_1fr] gap-x-3 py-2.5">
          <dt className="text-muted-foreground">Instructions</dt>
          <dd data-testid="approval-instructions" className="min-w-0 text-muted-foreground">
            {instructionsChanged
              ? `Appended guidance (${preview.instructionsSummary.length} chars)`
              : preview.instructionsSummary.length > 0
                ? `Unchanged (${preview.instructionsSummary.length} chars)`
                : 'Empty — uses the base prompt'}
          </dd>
        </div>

        {/* COMPLETE Skill set after the mutation */}
        <div className="grid grid-cols-[max-content_1fr] gap-x-3 py-2.5">
          <dt className="text-muted-foreground">Skills</dt>
          <dd data-testid="approval-skills" className="min-w-0">
            <CapabilitySet ids={preview.skills} emptyLabel="No skills" />
          </dd>
        </div>

        {/* COMPLETE Connector set after the mutation */}
        <div className="grid grid-cols-[max-content_1fr] gap-x-3 py-2.5">
          <dt className="text-muted-foreground">Connectors</dt>
          <dd data-testid="approval-connectors" className="min-w-0">
            <CapabilitySet ids={preview.connectors} emptyLabel="No connectors" />
          </dd>
        </div>

        {/* Expected revision (create has none yet) */}
        {preview.expectedRevision !== undefined ? (
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 py-2.5">
            <dt className="text-muted-foreground">Expected revision</dt>
            <dd data-testid="approval-revision" className="font-mono text-xs text-muted-foreground">
              {preview.expectedRevision}
            </dd>
          </div>
        ) : null}

        {/* Affected-session availability */}
        {preview.affectedSessions ? (
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 py-2.5">
            <dt className="text-muted-foreground">Bound sessions</dt>
            <dd data-testid="approval-sessions" className="min-w-0">
              {sessionsAvailable ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3.5" aria-hidden="true" />
                  Stay available
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <ShieldAlert className="size-3.5" aria-hidden="true" />
                  Become unavailable until rebound
                </span>
              )}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onDecline}
          data-testid="approval-decline"
        >
          <X className="size-4" aria-hidden="true" />
          Decline
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={onApprove}
          data-testid="approval-approve"
          className={destructive ? 'bg-rose-600 text-white hover:bg-rose-700' : undefined}
        >
          <Check className="size-4" aria-hidden="true" />
          {pending ? 'Approving…' : 'Approve'}
        </Button>
      </div>
    </div>
  )
}

type CapabilitySetProps = {
  ids: string[]
  emptyLabel: string
}

const CapabilitySet = ({ ids, emptyLabel }: CapabilitySetProps): React.JSX.Element => {
  if (ids.length === 0) {
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <li
          key={id}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        >
          {id}
        </li>
      ))}
    </ul>
  )
}
