import { Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { SpecialistDraft, SpecialistView } from '../../../../shared/settings'
import { validateSpecialistDraft } from '../../../../shared/specialist-validation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type Filter = 'all' | 'custom' | 'builtin'

const blankDraft = (): SpecialistDraft => ({
  agentId: '',
  name: '',
  description: '',
  instructions: '',
  skillIds: [],
  connectorIds: []
})
const splitIds = (value: string): string[] =>
  value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

// Settings CRUD surface. All writes still go through main's same validator and revision boundary;
// client validation is solely to give immediate, draft-preserving field feedback.
export const SpecialistsPanel = (): React.JSX.Element => {
  const [specialists, setSpecialists] = useState<SpecialistView[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SpecialistView | undefined>()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<SpecialistDraft>(blankDraft)
  const [skillText, setSkillText] = useState('')
  const [connectorText, setConnectorText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const load = async (): Promise<void> =>
    setSpecialists(await window.api.settings.listSpecialists())
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const counts = {
    all: specialists.length,
    custom: specialists.filter((item) => item.kind === 'custom').length,
    builtin: specialists.filter((item) => item.kind !== 'custom').length
  }
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return specialists.filter((item) => {
      if (filter === 'custom' && item.kind !== 'custom') return false
      if (filter === 'builtin' && item.kind === 'custom') return false
      return (
        !term ||
        [item.name, item.agentId, item.description ?? ''].some((field) =>
          field.toLowerCase().includes(term)
        )
      )
    })
  }, [specialists, filter, query])

  const open = (item?: SpecialistView): void => {
    setEditing(item)
    setCreating(!item)
    setError(undefined)
    setDraft(
      item
        ? {
            agentId: item.agentId,
            name: item.name,
            description: item.description,
            instructions: item.instructions,
            colorKey: item.colorKey,
            iconKey: item.iconKey,
            skillIds: [...item.skillIds],
            connectorIds: [...item.connectorIds],
            enabled: item.enabled
          }
        : blankDraft()
    )
    setSkillText(item?.skillIds.join(', ') ?? '')
    setConnectorText(item?.connectorIds.join(', ') ?? '')
  }
  const close = (): void => {
    setEditing(undefined)
    setCreating(false)
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    const next = { ...draft, skillIds: splitIds(skillText), connectorIds: splitIds(connectorText) }
    try {
      // Main validates against live catalogs; this client pass covers identity syntax without claiming
      // missing capabilities are newly allowed.
      validateSpecialistDraft(next, {
        agentIds: specialists.filter((item) => item.id !== editing?.id).map((item) => item.agentId),
        skillIds: next.skillIds ?? [],
        connectorIds: next.connectorIds ?? []
      })
      setSaving(true)
      setError(undefined)
      if (editing)
        await window.api.settings.updateSpecialist({
          ...next,
          id: editing.id,
          expectedRevision: editing.revision
        })
      else await window.api.settings.createSpecialist(next)
      await load()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save specialist.')
    } finally {
      setSaving(false)
    }
  }

  if (editing !== undefined || creating) {
    const readOnly = editing?.kind !== undefined && editing.kind !== 'custom'
    return (
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editing ? editing.name : 'New specialist'}</h2>
          <Button variant="ghost" onClick={close}>
            Back
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Instructions are appended to the framework’s base prompt; they do not replace it.
        </p>
        <label className="block text-sm font-medium">
          Name
          <Input
            disabled={readOnly}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Agent ID
          <Input
            disabled={readOnly}
            value={draft.agentId}
            onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Description
          <Input
            disabled={readOnly}
            value={draft.description ?? ''}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Instructions
          <Textarea
            disabled={readOnly}
            value={draft.instructions ?? ''}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Skills (comma-separated)
          <Input
            disabled={readOnly}
            value={skillText}
            onChange={(event) => setSkillText(event.target.value)}
          />
        </label>
        <label className="block text-sm font-medium">
          Connectors (comma-separated)
          <Input
            disabled={readOnly}
            value={connectorText}
            onChange={(event) => setConnectorText(event.target.value)}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Preview: {draft.name || 'Specialist'} · {splitIds(skillText).length} skills ·{' '}
          {splitIds(connectorText).length} connectors
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          {!readOnly ? (
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create specialist'}
            </Button>
          ) : null}
          {editing?.kind !== 'builtin-reviewer' ? (
            <Button
              variant="outline"
              disabled={saving}
              onClick={async () => {
                try {
                  setSaving(true)
                  await window.api.settings.duplicateSpecialist({
                    id: editing?.id ?? '',
                    expectedRevision: editing?.revision ?? 1
                  })
                  await load()
                  close()
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : 'Could not duplicate specialist.'
                  )
                } finally {
                  setSaving(false)
                }
              }}
            >
              Duplicate
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="p-5">
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search specialists"
            className="pl-8"
            placeholder="Search name, Agent ID, or description…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button onClick={() => open()}>
          <Plus data-icon="inline-start" />
          Add specialist
        </Button>
      </div>
      <div className="mb-4 flex gap-2">
        {(['all', 'custom', 'builtin'] as const).map((item) => (
          <Button
            key={item}
            variant={filter === item ? 'secondary' : 'ghost'}
            onClick={() => setFilter(item)}
          >
            {item === 'all' ? 'All' : item === 'custom' ? 'Custom' : 'Built-in'} ({counts[item]})
          </Button>
        ))}
      </div>
      <div className="divide-y rounded-lg border">
        {visible.map((item) => (
          <div key={item.id} className="flex items-center gap-3 p-3">
            <button
              type="button"
              disabled={item.kind === 'builtin-reviewer'}
              className="min-w-0 flex-1 text-left disabled:cursor-default"
              onClick={() => open(item)}
            >
              <div className="font-medium">
                {item.name}{' '}
                {item.kind !== 'custom' ? (
                  <span className="text-xs text-muted-foreground">Built-in</span>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {item.kind === 'builtin-reviewer'
                  ? 'Used by Auto-review'
                  : `${item.description ?? item.agentId} · ${item.effectiveSkillCount} skills · ${item.effectiveConnectorCount} connectors`}
              </div>
            </button>
            {item.kind !== 'builtin-reviewer' ? (
              <input
                aria-label={`Enable ${item.name}`}
                type="checkbox"
                checked={item.enabled}
                onChange={async () => {
                  try {
                    await window.api.settings.setSpecialistEnabled({
                      id: item.id,
                      expectedRevision: item.revision,
                      enabled: !item.enabled
                    })
                    await load()
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : 'Could not update specialist.'
                    )
                  }
                }}
              />
            ) : null}
            {item.kind === 'custom' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${item.name}`}
                onClick={async () => {
                  await window.api.settings.deleteSpecialist({
                    id: item.id,
                    expectedRevision: item.revision
                  })
                  await load()
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
