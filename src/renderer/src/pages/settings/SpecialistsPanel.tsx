import { Plus, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type {
  ConnectorView,
  CustomServerView,
  SkillView,
  SpecialistDraft,
  SpecialistView
} from '../../../../shared/settings'
import { validateSpecialistDraft } from '../../../../shared/specialist-validation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type Filter = 'all' | 'custom' | 'builtin'
type CapabilityState = 'available' | 'disabled' | 'missing'
type Capability = { id: string; label: string; state: CapabilityState }

const COLORS = ['blue', 'green', 'orange', 'pink', 'purple', 'red', 'slate']
const ICONS = ['beaker', 'book-open', 'brain', 'flask-conical', 'microscope', 'search']

const blankDraft = (): SpecialistDraft => ({
  agentId: '',
  name: '',
  description: '',
  instructions: '',
  colorKey: 'purple',
  iconKey: 'brain',
  skillIds: [],
  connectorIds: []
})

const draftFor = (item: SpecialistView): SpecialistDraft => ({
  agentId: item.agentId,
  name: item.name,
  description: item.description,
  instructions: item.instructions,
  colorKey: item.colorKey,
  iconKey: item.iconKey,
  skillIds: [...item.skillIds],
  connectorIds: [...item.connectorIds],
  enabled: item.enabled
})

const isConflict = (error: unknown): boolean =>
  error instanceof Error && /reload or duplicate/i.test(error.message)

const capabilityLabel = (capability: Capability): string =>
  `${capability.label}${capability.state === 'available' ? '' : ` (${capability.state})`}`

// Settings CRUD surface. The renderer validates only for immediate field feedback. The main
// process repeats the exact validation and owns capability authorization and revisions.
export const SpecialistsPanel = (): React.JSX.Element => {
  const [specialists, setSpecialists] = useState<SpecialistView[]>([])
  const [skills, setSkills] = useState<SkillView[]>([])
  const [connectors, setConnectors] = useState<ConnectorView[]>([])
  const [customServers, setCustomServers] = useState<CustomServerView[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SpecialistView | undefined>()
  const [creating, setCreating] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [draft, setDraft] = useState<SpecialistDraft>(blankDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [conflicted, setConflicted] = useState(false)

  const load = async (): Promise<void> => {
    const [nextSpecialists, nextSkills, nextConnectors] = await Promise.all([
      window.api.settings.listSpecialists(),
      window.api.settings.listSkills(),
      window.api.settings.listConnectors()
    ])
    setSpecialists(nextSpecialists)
    setSkills(nextSkills)
    setConnectors(nextConnectors.connectors)
    setCustomServers(nextConnectors.customServers)
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const skillCapabilities = useMemo<Capability[]>(() => {
    const known = new Map(
      skills.map((skill) => [
        skill.id,
        { label: skill.name, state: skill.enabled ? 'available' : ('disabled' as CapabilityState) }
      ])
    )
    return (draft.skillIds ?? []).map((id) => {
      const entry = known.get(id)
      return entry ? { id, ...entry } : { id, label: id, state: 'missing' }
    })
  }, [draft.skillIds, skills])
  const connectorCapabilities = useMemo<Capability[]>(() => {
    const known = new Map<string, { label: string; state: CapabilityState }>([
      ...connectors.map(
        (connector) =>
          [
            connector.id,
            {
              label: connector.displayName,
              state: connector.enabled ? 'available' : ('disabled' as CapabilityState)
            }
          ] as const
      ),
      ...customServers.map(
        (server) =>
          [
            server.id,
            {
              label: server.name,
              state: server.enabled ? 'available' : ('disabled' as CapabilityState)
            }
          ] as const
      )
    ])
    return (draft.connectorIds ?? []).map((id) => {
      const entry = known.get(id)
      return entry ? { id, ...entry } : { id, label: id, state: 'missing' }
    })
  }, [connectors, customServers, draft.connectorIds])
  const effectiveSkillCount = skillCapabilities.filter((item) => item.state === 'available').length
  const effectiveConnectorCount = connectorCapabilities.filter(
    (item) => item.state === 'available'
  ).length

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
        [item.name, item.agentId, item.description ?? ''].some((value) =>
          value.toLowerCase().includes(term)
        )
      )
    })
  }, [specialists, filter, query])

  const beginCreate = (): void => {
    setEditing(undefined)
    setCreating(true)
    setAddMenuOpen(false)
    setError(undefined)
    setConflicted(false)
    // Connector defaults are an explicit fixed snapshot, not an implicit "all" mode.
    setDraft({
      ...blankDraft(),
      connectorIds: [...connectors, ...customServers]
        .filter((item) => item.enabled)
        .map((item) => item.id)
    })
  }
  const open = (item: SpecialistView): void => {
    setEditing(item)
    setCreating(false)
    setError(undefined)
    setConflicted(false)
    setDraft(draftFor(item))
  }
  const close = (): void => {
    setEditing(undefined)
    setCreating(false)
    setError(undefined)
    setConflicted(false)
  }
  const removeCapability = (kind: 'skillIds' | 'connectorIds', id: string): void =>
    setDraft((current) => ({
      ...current,
      [kind]: (current[kind] ?? []).filter((entry) => entry !== id)
    }))
  const addCapability = (kind: 'skillIds' | 'connectorIds', id: string): void =>
    setDraft((current) => ({ ...current, [kind]: [...(current[kind] ?? []), id] }))

  const save = async (): Promise<void> => {
    try {
      validateSpecialistDraft(draft, {
        agentIds: specialists.filter((item) => item.id !== editing?.id).map((item) => item.agentId),
        skillIds: skills.filter((skill) => skill.enabled).map((skill) => skill.id),
        connectorIds: [...connectors, ...customServers]
          .filter((item) => item.enabled)
          .map((item) => item.id),
        retainedSkillIds: editing?.skillIds,
        retainedConnectorIds: editing?.connectorIds
      })
      setSaving(true)
      setError(undefined)
      setConflicted(false)
      if (editing)
        await window.api.settings.updateSpecialist({
          ...draft,
          id: editing.id,
          expectedRevision: editing.revision
        })
      else await window.api.settings.createSpecialist(draft)
      await load()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save specialist.')
      setConflicted(isConflict(cause))
    } finally {
      setSaving(false)
    }
  }
  const reloadAfterConflict = async (): Promise<void> => {
    if (!editing) return
    await load()
    const latest = (await window.api.settings.listSpecialists()).find(
      (item) => item.id === editing.id
    )
    if (latest) {
      setEditing(latest)
      setDraft(draftFor(latest))
      setError(undefined)
      setConflicted(false)
    }
  }
  const duplicateDraftAfterConflict = async (): Promise<void> => {
    if (!editing) return
    try {
      setSaving(true)
      // The service intentionally permits duplication from a stale source. The follow-up update
      // applies this editor's unsaved draft to the independent copy, leaving the newer original alone.
      const copy = await window.api.settings.duplicateSpecialist({
        id: editing.id,
        expectedRevision: editing.revision
      })
      const updated = await window.api.settings.updateSpecialist({
        ...draft,
        id: copy.id,
        expectedRevision: copy.revision
      })
      await load()
      open(updated)
      setError(undefined)
      setConflicted(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not duplicate your draft.')
    } finally {
      setSaving(false)
    }
  }

  if (editing !== undefined || creating) {
    const readOnly = editing?.kind !== undefined && editing.kind !== 'custom'
    const selectableSkills = skills.filter(
      (skill) => skill.enabled && !(draft.skillIds ?? []).includes(skill.id)
    )
    const selectableConnectors = [...connectors, ...customServers].filter(
      (item) => item.enabled && !(draft.connectorIds ?? []).includes(item.id)
    )
    return (
      <div className="space-y-5 p-5" data-testid="specialist-editor">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{editing ? editing.name : 'New specialist'}</h2>
            {editing?.kind === 'builtin-customize' ? (
              <p className="text-sm text-muted-foreground">Built-in specialist</p>
            ) : null}
          </div>
          <Button variant="ghost" onClick={close}>
            Back
          </Button>
        </div>

        <section className="space-y-3" aria-labelledby="specialist-identity">
          <h3 id="specialist-identity" className="font-medium">
            Identity
          </h3>
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
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">
              Color
              <select
                aria-label="Color"
                disabled={readOnly}
                value={draft.colorKey ?? ''}
                onChange={(event) => setDraft({ ...draft, colorKey: event.target.value })}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2"
              >
                {COLORS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium">
              Icon
              <select
                aria-label="Icon"
                disabled={readOnly}
                value={draft.iconKey ?? ''}
                onChange={(event) => setDraft({ ...draft, iconKey: event.target.value })}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2"
              >
                {ICONS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="space-y-2" aria-labelledby="specialist-instructions">
          <h3 id="specialist-instructions" className="font-medium">
            Instructions
          </h3>
          <p className="text-sm text-muted-foreground">
            These instructions are appended to the framework’s base prompt; they do not replace it.
          </p>
          <Textarea
            aria-label="Instructions"
            disabled={readOnly}
            value={draft.instructions ?? ''}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          />
        </section>

        <CapabilityEditor
          title="Skills"
          addLabel="Add a skill…"
          capabilities={skillCapabilities}
          choices={selectableSkills.map((skill) => ({ id: skill.id, label: skill.name }))}
          readOnly={readOnly}
          onAdd={(id) => addCapability('skillIds', id)}
          onRemove={(id) => removeCapability('skillIds', id)}
        />
        <CapabilityEditor
          title="Connectors"
          addLabel="Add a connector…"
          capabilities={connectorCapabilities}
          choices={selectableConnectors.map((item) => ({
            id: item.id,
            label: 'displayName' in item ? item.displayName : item.name
          }))}
          readOnly={readOnly}
          onAdd={(id) => addCapability('connectorIds', id)}
          onRemove={(id) => removeCapability('connectorIds', id)}
        />

        <section className="rounded-md border p-3" aria-label="Specialist preview">
          <h3 className="font-medium">Preview</h3>
          <p className="text-sm text-muted-foreground">
            {draft.name || 'Specialist'} · {effectiveSkillCount} effective skills ·{' '}
            {effectiveConnectorCount} effective connectors
          </p>
          {skillCapabilities.some((item) => item.state !== 'available') ||
          connectorCapabilities.some((item) => item.state !== 'available') ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Unavailable references are retained safely and excluded from effective counts.
              Disabled capabilities recover automatically when re-enabled; missing capabilities can
              be removed.
            </p>
          ) : null}
        </section>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {conflicted ? (
          <div className="flex gap-2" aria-label="Revision conflict actions">
            <Button variant="outline" disabled={saving} onClick={() => void reloadAfterConflict()}>
              Reload
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => void duplicateDraftAfterConflict()}
            >
              Duplicate draft
            </Button>
          </div>
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
              onClick={() =>
                void (async () => {
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
                })()
              }
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
        <Button aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen(!addMenuOpen)}>
          <Plus data-icon="inline-start" />
          Add specialist
        </Button>
      </div>
      {addMenuOpen ? (
        <div className="mb-4 rounded-md border p-2">
          <Button variant="ghost" className="w-full justify-start" onClick={beginCreate}>
            Write from scratch
          </Button>
        </div>
      ) : null}
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
                onChange={() =>
                  void (async () => {
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
                  })()
                }
              />
            ) : null}
            {item.kind === 'custom' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${item.name}`}
                onClick={() =>
                  void (async () => {
                    try {
                      await window.api.settings.deleteSpecialist({
                        id: item.id,
                        expectedRevision: item.revision
                      })
                      await load()
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : 'Could not delete specialist.'
                      )
                    }
                  })()
                }
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

function CapabilityEditor({
  title,
  addLabel,
  capabilities,
  choices,
  readOnly,
  onAdd,
  onRemove
}: {
  title: string
  addLabel: string
  capabilities: Capability[]
  choices: Array<{ id: string; label: string }>
  readOnly: boolean
  onAdd: (id: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="font-medium">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {capabilities.length === 0 ? (
          <span className="text-sm text-muted-foreground">None selected</span>
        ) : (
          capabilities.map((capability) => (
            <span
              key={capability.id}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
              data-capability-state={capability.state}
            >
              {capabilityLabel(capability)}{' '}
              {!readOnly ? (
                <button
                  type="button"
                  aria-label={`Remove ${capability.label}`}
                  onClick={() => onRemove(capability.id)}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>
      {!readOnly && choices.length > 0 ? (
        <select
          aria-label={addLabel}
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) {
              onAdd(event.target.value)
              event.currentTarget.value = ''
            }
          }}
          className="h-9 rounded-md border bg-background px-2"
        >
          <option value="">{addLabel}</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : null}
    </section>
  )
}
