import { useEffect, useState } from 'react'

import type {
  ComputeEnvironment,
  ComputeEnvironmentStatus,
  ComputeEnvironmentVisibility,
  EnvironmentValidationEvidence
} from '../../../../shared/compute-environment'
import { summarizeResolution } from '../../../../shared/compute-environment'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

type ComputeEnvironmentsSectionProps = {
  providerId: string
}

// Status → badge variant + human label (design.md §8.3). `unknown` is reserved for the submit guard;
// here it only appears defensively.
const statusBadge = (status: ComputeEnvironmentStatus): { label: string; className: string } => {
  switch (status) {
    case 'ready':
      return { label: 'Ready', className: 'bg-green-100 text-green-700' }
    case 'stale':
      return { label: 'Stale', className: 'bg-amber-100 text-amber-700' }
    case 'failed':
      return { label: 'Failed', className: 'bg-red-100 text-red-700' }
    case 'building':
      return { label: 'Building', className: 'bg-blue-100 text-blue-700' }
    case 'validating':
      return { label: 'Validating', className: 'bg-blue-100 text-blue-700' }
    case 'draft':
      return { label: 'Draft', className: 'bg-slate-100 text-slate-600' }
  }
}

// Renders a short "X ago" / "failed" validation line from the evidence record.
const validationLine = (env: ComputeEnvironment): string => {
  if (!env.validation) return ''
  const v = env.validation
  const when = env.validatedAt ? new Date(env.validatedAt).toLocaleString() : ''
  const outcome = v.result === 'ready' ? `exit ${v.exitCode}` : `failed (exit ${v.exitCode})`
  return when ? `${v.result} · ${outcome} · ${when}` : outcome
}

// Renders the Environments registry section under a Compute host detail page (design.md §8 / issue 05).
// Lists each environment with status, resolution summary, and last-validation info, and offers a
// controlled register/edit/delete affordance. spec/resolution are entered as JSON and validated by the
// main process; this component shows the structured error from the IPC boundary.
export function ComputeEnvironmentsSection({
  providerId
}: ComputeEnvironmentsSectionProps): React.JSX.Element {
  const [envs, setEnvs] = useState<ComputeEnvironment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<EditState | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const list = await window.api.compute.environmentsList(providerId)
      setEnvs(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // Load environments for the host on mount / when the host changes. The fetch is inlined here (rather
  // than calling refresh) so no setState runs synchronously in the effect body — the state updates
  // happen only after the awaited IPC resolves.
  useEffect(() => {
    let cancelled = false
    window.api.compute
      .environmentsList(providerId)
      .then((list) => {
        if (!cancelled) setEnvs(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  const onSubmit = async (state: EditState): Promise<void> => {
    try {
      if (state.id) {
        await window.api.compute.environmentUpdate(state.id, {
          name: state.name,
          visibility: state.visibility,
          spec: state.specJson ? JSON.parse(state.specJson) : undefined,
          resolution: state.resolutionJson ? JSON.parse(state.resolutionJson) : undefined,
          detailsDoc: state.detailsDoc
        })
      } else {
        await window.api.compute.environmentCreate(providerId, {
          name: state.name,
          visibility: state.visibility,
          spec: JSON.parse(state.specJson),
          resolution: JSON.parse(state.resolutionJson),
          detailsDoc: state.detailsDoc,
          initialStatus: state.initialStatus
        })
      }
      setEditing(undefined)
      await refresh()
    } catch (err) {
      state.setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDelete = async (id: string): Promise<void> => {
    try {
      await window.api.compute.environmentDelete(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-border bg-muted/30 p-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold">Environments</div>
          <div className="text-xs text-muted-foreground">
            Register validated conda / venv, module, or Apptainer environments. A normal job may
            only name a <strong>Ready</strong> environment.
          </div>
        </div>
        <Button
          size="sm"
          onClick={() =>
            setEditing({
              name: '',
              specJson: '{\n  "runtime": "conda",\n  "packages": []\n}',
              resolutionJson:
                '{\n  "kind": "conda",\n  "envName": "ml",\n  "activation": "conda activate ml"\n}',
              visibility: 'provider',
              initialStatus: 'draft',
              detailsDoc: '',
              setError: () => undefined
            })
          }
        >
          + Register environment
        </Button>
      </div>

      {loading ? (
        <div className="px-1 py-3 text-sm text-muted-foreground">Loading environments…</div>
      ) : envs.length === 0 ? (
        <div className="px-1 py-3 text-sm text-muted-foreground">
          No environments registered yet.
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-[1.4fr_90px_1.6fr_1.4fr_90px] gap-3 border-b border-border px-2 pb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <div>Name</div>
            <div>Status</div>
            <div>Resolution</div>
            <div>Last validation</div>
            <div />
          </div>
          {envs.map((env) => {
            const badge = statusBadge(env.status)
            return (
              <div
                key={env.id}
                className="grid grid-cols-[1.4fr_90px_1.6fr_1.4fr_90px] gap-3 border-b border-border px-2 py-2.5 text-sm"
              >
                <div className="font-semibold">
                  {env.name}
                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                    {env.visibility}
                  </span>
                </div>
                <div>
                  <Badge variant="secondary" className={badge.className}>
                    {badge.label}
                  </Badge>
                </div>
                <div className="font-mono text-xs">{summarizeResolution(env.resolution)}</div>
                <div className="text-[11px] text-muted-foreground">{validationLine(env)}</div>
                <div className="flex justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        id: env.id,
                        name: env.name,
                        visibility: env.visibility,
                        specJson: env.spec ? JSON.stringify(env.spec, null, 2) : '',
                        resolutionJson: env.resolution
                          ? JSON.stringify(env.resolution, null, 2)
                          : '',
                        detailsDoc: env.detailsDoc,
                        initialStatus: env.status,
                        setError: () => undefined
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void onDelete(env.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}

      {editing ? (
        <EnvironmentEditDialog
          state={editing}
          isNew={!editing.id}
          onCancel={() => setEditing(undefined)}
          onSubmit={onSubmit}
        />
      ) : null}
    </div>
  )
}

// Internal: the register/edit dialog. Validates JSON client-side for a readable error before sending.
type EditState = {
  id?: string
  name: string
  visibility: ComputeEnvironmentVisibility
  specJson: string
  resolutionJson: string
  detailsDoc: string
  initialStatus: ComputeEnvironmentStatus
  setError: (msg: string | undefined) => void
}

function EnvironmentEditDialog({
  state,
  isNew,
  onCancel,
  onSubmit
}: {
  state: EditState
  isNew: boolean
  onCancel: () => void
  onSubmit: (state: EditState) => Promise<void>
}): React.JSX.Element {
  // Local editable copy of the form fields. The parent passes an immutable initial state; the dialog
  // owns its own edits and hands the final values back via onSubmit (no prop mutation).
  const [name, setName] = useState(state.name)
  const [visibility, setVisibility] = useState<ComputeEnvironmentVisibility>(state.visibility)
  const [specJson, setSpecJson] = useState(state.specJson)
  const [resolutionJson, setResolutionJson] = useState(state.resolutionJson)
  const [detailsDoc, setDetailsDoc] = useState(state.detailsDoc)
  // initialStatus is not editable: a fresh registration is always draft (the IPC boundary rejects
  // 'ready'). Only provisioning validation can flip a row to ready.
  const initialStatus = state.initialStatus
  const [localError, setLocalError] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    setLocalError(undefined)
    try {
      JSON.parse(specJson)
      JSON.parse(resolutionJson)
    } catch (err) {
      setLocalError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await onSubmit({
      id: state.id,
      name,
      visibility,
      specJson,
      resolutionJson,
      detailsDoc,
      initialStatus,
      setError: setLocalError
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[540px] max-w-[92vw] rounded-xl bg-background p-5 shadow-2xl">
        <h3 className="mb-3 text-base font-semibold">
          {isNew ? 'Register environment' : 'Edit environment'}
        </h3>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-semibold">Name</label>
          <input
            className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">
            Unique within this provider. The agent names this in submit_job.
          </div>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-semibold">Visibility</label>
          <select
            className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as ComputeEnvironmentVisibility)}
          >
            <option value="provider">Provider (reusable across projects)</option>
            <option value="project">This project only</option>
          </select>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-semibold">Portable spec (JSON)</label>
          <textarea
            className="min-h-[90px] w-full rounded-md border border-border px-2 py-1.5 font-mono text-xs"
            value={specJson}
            onChange={(e) => setSpecJson(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">
            What the stack intends. Secret-bearing keys are rejected.
          </div>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-semibold">Resolution (JSON)</label>
          <textarea
            className="min-h-[90px] w-full rounded-md border border-border px-2 py-1.5 font-mono text-xs"
            value={resolutionJson}
            onChange={(e) => setResolutionJson(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">
            conda / venv / module / apptainer. Machine-readable; detailsDoc stays human-readable
            only.
          </div>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs font-semibold">Details (human-readable notes)</label>
          <textarea
            className="min-h-[60px] w-full rounded-md border border-border px-2 py-1.5 text-xs"
            value={detailsDoc}
            onChange={(e) => setDetailsDoc(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">
            Documentation only — never parsed into a command or resolution.
          </div>
        </div>

        {isNew ? (
          <div className="mb-3 rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
            New environments start as <strong>Draft</strong>. Run provisioning validation to flip an
            environment to <strong>Ready</strong> — only a Ready environment can be named in a job.
          </div>
        ) : null}

        {localError ? <div className="mb-2 text-xs text-red-600">{localError}</div> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// Re-exported for tests that want to construct an evidence record.
export type { EnvironmentValidationEvidence }
