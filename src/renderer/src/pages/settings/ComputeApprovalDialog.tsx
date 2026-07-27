import { useState } from 'react'
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'

// A modal approval card for a pending compute approval. The card cannot be dismissed without
// a decision — the call is held open in main until the user responds (or a 5-minute timeout fires).
//
// Three scope buttons (design.md §6, no Global):
//   Once             — approve this call only; card shown every time
//   This conversation — approve for (provider, operation) for the rest of this session
//   This project      — approve for (provider, operation) for all future calls in this project
//
// operation='environment_provisioning' renders a dedicated provisioning card (issue 06 / design.md §9):
// a distinct grant scope from an ordinary job. The card shows provider, environment name, build and
// validation script summaries, resources, cache/weight paths, and known egress domains. No secrets.
export function ComputeApprovalDialog(): React.JSX.Element | null {
  const request = useComputeStore((state) => state.pendingApprovals[0])
  const respondApproval = useComputeStore((state) => state.respondApproval)
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null)

  const dialogRequest = useRetainedDialogValue(request)
  if (!dialogRequest) return null

  const deny = (): void => void respondApproval(dialogRequest.id, 'deny')
  const approveOnce = (): void => void respondApproval(dialogRequest.id, 'once')
  const approveConversation = (): void => void respondApproval(dialogRequest.id, 'conversation')
  const approveProject = (): void => void respondApproval(dialogRequest.id, 'project')

  // Track the expand state per request id so advancing to a new approval collapses the command.
  const showFull = expandedRequestId === dialogRequest.id
  const toggleFull = (): void =>
    setExpandedRequestId((id) => (id === dialogRequest.id ? null : dialogRequest.id))

  return (
    <Dialog.Root open={Boolean(request)}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] w-[min(480px,calc(100vw-2rem))] overscroll-contain'
          )}
        >
          {dialogRequest.operation === 'environment_provisioning' ? (
            <ProvisioningCard
              request={dialogRequest}
              onDeny={deny}
              onOnce={approveOnce}
              onConversation={approveConversation}
              onProject={approveProject}
            />
          ) : (
            <CommandCard
              request={dialogRequest}
              showFull={showFull}
              onToggleFull={toggleFull}
              onDeny={deny}
              onOnce={approveOnce}
              onConversation={approveConversation}
              onProject={approveProject}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

type CardProps = {
  request: Extract<ReturnType<typeof useComputeStore.getState>['pendingApprovals'][number], unknown>
  onDeny: () => void
  onOnce: () => void
  onConversation: () => void
  onProject: () => void
}

function ApprovalActions(props: Omit<CardProps, 'request'>): React.JSX.Element {
  return (
    <div className={cn(dialogFooterClassName, 'mt-4 flex-wrap')}>
      <Button type="button" variant="destructive" onClick={props.onDeny}>
        Deny
      </Button>
      <Button type="button" variant="outline" onClick={props.onOnce}>
        Once
      </Button>
      <Button type="button" variant="outline" onClick={props.onConversation}>
        This conversation
      </Button>
      <Button type="button" onClick={props.onProject}>
        This project
      </Button>
    </div>
  )
}

// environment_provisioning card (issue 06). Distinct grant scope; shows the full build/validation plan.
function ProvisioningCard(props: CardProps): React.JSX.Element {
  const { request } = props
  const weights = request.weight_paths ?? []
  const egress = request.egress_domains ?? []
  // provider_id is the canonical provider (e.g. "ssh:biowulf"); provider_name is the human label.
  const providerLabel = request.provider_id || request.provider_name
  // The workflow sets intent = `Provision environment "<name>"`; extract the bare name so the card
  // shows a clean environment label alongside the provider.
  const envName = extractEnvironmentName(request.intent)
  // resources arrives as a JSON string of the ResourceRequest (provisioning-workflow.ts).
  const resourcesSummary = summarizeResources(request.resources)

  return (
    <div>
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
        <div className="min-w-0">
          <Dialog.Title className={dialogTitleClassName}>
            Approve environment provisioning?
          </Dialog.Title>
          <Dialog.Description
            className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
          >
            This installs and validates a remote software environment as your account. It is a
            separate operation from an ordinary job, and this grant covers only this build &amp;
            validation plan.
          </Dialog.Description>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-foreground">
            {envName || 'Environment provisioning'}
          </span>
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-600">
            Provisioning
          </span>
        </div>

        <Field label="Provider" value={providerLabel} />
        {request.provider_name &&
          request.provider_id &&
          request.provider_name !== request.provider_id && (
            <Field label="Host" value={request.provider_name} />
          )}
        {envName && <Field label="Environment" value={envName} />}
        {request.driver && <Field label="Driver" value={request.driver} mono />}
        {request.build_script_summary && (
          <Field label="Build script" value={request.build_script_summary} mono />
        )}
        {request.validation_script_summary && (
          <Field label="Validation" value={request.validation_script_summary} mono />
        )}
        {resourcesSummary && <Field label="Resources" value={resourcesSummary} mono />}
        {request.cache_path && <Field label="Cache path" value={request.cache_path} mono />}
        {weights.length > 0 && <PillsField label="Weight paths" items={weights} />}
        {egress.length > 0 && <PillsField label="Known egress" items={egress} />}
      </div>

      <ApprovalActions {...props} />
    </div>
  )
}

// Pulls the bare environment name out of intent strings like `Provision environment "ml-torch"`.
function extractEnvironmentName(intent?: string): string | undefined {
  if (!intent) return undefined
  const match = intent.match(/"([^"]+)"/)
  return match?.[1]
}

// Renders the JSON-string ResourceRequest as a compact "1 node · 4 CPUs · 1 GPU (a100) · 32 GiB · 1h"
// summary. Falls back to the raw string when it is not valid JSON.
function summarizeResources(resources?: string): string | undefined {
  if (!resources) return undefined
  try {
    const r = JSON.parse(resources) as Record<string, unknown>
    const parts: string[] = []
    if (typeof r.nodes === 'number') parts.push(`${r.nodes} node${r.nodes > 1 ? 's' : ''}`)
    if (typeof r.tasks === 'number') parts.push(`${r.tasks} task${r.tasks > 1 ? 's' : ''}`)
    if (typeof r.cpusPerTask === 'number') parts.push(`${r.cpusPerTask} CPUs/task`)
    if (typeof r.gpus === 'number') {
      parts.push(
        `${r.gpus} GPU${r.gpus > 1 ? 's' : ''}${typeof r.gpuType === 'string' ? ` (${r.gpuType})` : ''}`
      )
    }
    if (typeof r.memoryMib === 'number') parts.push(`${r.memoryMib} MiB`)
    if (typeof r.timeLimitSeconds === 'number')
      parts.push(`${Math.round(r.timeLimitSeconds / 60)} min`)
    if (typeof r.partition === 'string') parts.push(`partition ${r.partition}`)
    if (typeof r.account === 'string') parts.push(`account ${r.account}`)
    return parts.length > 0 ? parts.join(' · ') : resources
  } catch {
    return resources
  }
}

function CommandCard(
  props: CardProps & { showFull: boolean; onToggleFull: () => void }
): React.JSX.Element {
  const { request } = props
  const isLongCommand = request.command_preview !== request.command_full

  return (
    <div>
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
        <div className="min-w-0">
          <Dialog.Title className={dialogTitleClassName}>Allow remote command?</Dialog.Title>
          <Dialog.Description
            className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
          >
            Remote commands run as your account on the host and are not sandboxed. Approve only if
            you trust this command.
          </Dialog.Description>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <Field label="Host" value={request.provider_name} />
        <Field label="Intent" value={request.intent} />
        <div className="flex gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">Command</span>
          <div className="min-w-0 flex-1">
            <span className="break-all font-mono text-muted-foreground">
              {props.showFull ? request.command_full : request.command_preview}
            </span>
            {isLongCommand && (
              <button
                type="button"
                onClick={props.onToggleFull}
                className="mt-1 flex items-center gap-0.5 text-xs text-primary hover:underline"
                aria-expanded={props.showFull}
              >
                {props.showFull ? (
                  <>
                    <ChevronUp className="size-3" aria-hidden="true" /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3" aria-hidden="true" /> Show full command
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        {request.inputs_summary && <Field label="Inputs" value={request.inputs_summary} />}
      </div>

      <ApprovalActions {...props} />
    </div>
  )
}

function Field({
  label,
  value,
  mono
}: {
  label: string
  value?: string
  mono?: boolean
}): React.JSX.Element {
  if (value === undefined || value === '') return <></>
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 break-words text-foreground ${mono ? 'font-mono text-[11px] font-normal text-muted-foreground' : 'font-medium'}`}
      >
        {value}
      </span>
    </div>
  )
}

function PillsField({ label, items }: { label: string; items: string[] }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className="break-all rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}
