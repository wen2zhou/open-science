import {
  ArrowLeft,
  Beaker,
  BookOpen,
  Brain,
  ChevronDown,
  Copy,
  FlaskConical,
  Microscope,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { SettingsToggle } from './SettingsLayout'

type Filter = 'all' | 'custom' | 'builtin'
type CapabilityState = 'available' | 'disabled' | 'missing'
type Capability = { id: string; label: string; state: CapabilityState }
type CapabilityKind = 'skills' | 'connectors'

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  custom: 'Custom',
  builtin: 'Built-in'
}

const COLOR_OPTIONS: ReadonlyArray<{ key: string; label: string; className: string }> = [
  { key: 'blue', label: 'Blue', className: 'bg-blue-100 text-blue-700' },
  { key: 'green', label: 'Green', className: 'bg-emerald-100 text-emerald-700' },
  { key: 'orange', label: 'Orange', className: 'bg-orange-100 text-orange-700' },
  { key: 'pink', label: 'Pink', className: 'bg-pink-100 text-pink-700' },
  { key: 'purple', label: 'Purple', className: 'bg-violet-100 text-violet-700' },
  { key: 'red', label: 'Red', className: 'bg-rose-100 text-rose-700' },
  { key: 'slate', label: 'Slate', className: 'bg-slate-100 text-slate-700' }
]

const ICON_OPTIONS: ReadonlyArray<{ key: string; label: string; Icon: LucideIcon }> = [
  { key: 'brain', label: 'Brain', Icon: Brain },
  { key: 'beaker', label: 'Beaker', Icon: Beaker },
  { key: 'book-open', label: 'Book', Icon: BookOpen },
  { key: 'flask-conical', label: 'Flask', Icon: FlaskConical },
  { key: 'microscope', label: 'Microscope', Icon: Microscope },
  { key: 'search', label: 'Search', Icon: Search }
]

const GROUPS: ReadonlyArray<{
  key: Exclude<Filter, 'all'>
  label: string
  subtitle: string
  empty: string
  match: (item: SpecialistView) => boolean
}> = [
  {
    key: 'custom',
    label: 'Custom',
    subtitle: 'Created by you.',
    empty: 'No custom specialists yet.',
    match: (item) => item.kind === 'custom'
  },
  {
    key: 'builtin',
    label: 'Built-in',
    subtitle: 'Shipped with the app · can be disabled, not deleted.',
    empty: 'No built-in specialists.',
    match: (item) => item.kind !== 'custom'
  }
]

const colorClassName = (key?: string): string =>
  COLOR_OPTIONS.find((option) => option.key === key)?.className ?? COLOR_OPTIONS[4].className

const iconOption = (key?: string): { key: string; label: string; Icon: LucideIcon } =>
  ICON_OPTIONS.find((option) => option.key === key) ?? ICON_OPTIONS[0]

const blankDraft = (): SpecialistDraft => ({
  agentId: '',
  name: '',
  description: '',
  instructions: '',
  colorKey: 'purple',
  iconKey: 'brain',
  skillIds: [],
  connectorIds: [],
  enabled: true
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

type AvatarProps = { iconKey?: string; colorKey?: string; variant?: 'row' | 'head' }

const Avatar = ({ iconKey, colorKey, variant = 'row' }: AvatarProps): React.JSX.Element => {
  const { Icon } = iconOption(iconKey)
  const large = variant === 'head'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg',
        large ? 'size-10 rounded-xl' : 'size-7',
        colorClassName(colorKey)
      )}
    >
      <Icon className={large ? 'size-5' : 'size-3.5'} strokeWidth={2} />
    </span>
  )
}

// Settings CRUD surface. The renderer validates only for immediate field feedback. The main
// process repeats the exact validation and owns capability authorization and revisions.
export const SpecialistsPanel = (): React.JSX.Element => {
  const [specialists, setSpecialists] = useState<SpecialistView[]>([])
  const [skills, setSkills] = useState<SkillView[]>([])
  const [connectors, setConnectors] = useState<ConnectorView[]>([])
  const [customServers, setCustomServers] = useState<CustomServerView[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<Exclude<Filter, 'all'>, boolean>>>({})
  const [editing, setEditing] = useState<SpecialistView | undefined>()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<SpecialistDraft>(blankDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [conflicted, setConflicted] = useState(false)
  const [capTab, setCapTab] = useState<CapabilityKind>('skills')

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
    setError(undefined)
    setConflicted(false)
    setCapTab('skills')
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
    setCapTab('skills')
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

  const toggleEnabled = async (item: SpecialistView): Promise<void> => {
    try {
      await window.api.settings.setSpecialistEnabled({
        id: item.id,
        expectedRevision: item.revision,
        enabled: !item.enabled
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update specialist.')
    }
  }
  const duplicateActive = async (): Promise<void> => {
    if (!editing) return
    try {
      setSaving(true)
      await window.api.settings.duplicateSpecialist({
        id: editing.id,
        expectedRevision: editing.revision
      })
      await load()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not duplicate specialist.')
    } finally {
      setSaving(false)
    }
  }
  const deleteActive = async (): Promise<void> => {
    if (!editing) return
    try {
      setSaving(true)
      await window.api.settings.deleteSpecialist({
        id: editing.id,
        expectedRevision: editing.revision
      })
      await load()
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete specialist.')
    } finally {
      setSaving(false)
    }
  }

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
    const readOnly = editing !== undefined && editing.kind !== 'custom'
    const editorTitle = editing ? editing.name : 'New specialist'
    const badgeLabel = creating || editing?.kind === 'custom' ? 'Custom' : 'Built-in'
    const showOverflow = editing !== undefined && editing.kind !== 'builtin-reviewer'
    const canDelete = editing?.kind === 'custom'
    const selectableSkills = skills.filter(
      (skill) => skill.enabled && !(draft.skillIds ?? []).includes(skill.id)
    )
    const selectableConnectors = [...connectors, ...customServers].filter(
      (item) => item.enabled && !(draft.connectorIds ?? []).includes(item.id)
    )
    const hasUnavailable =
      skillCapabilities.some((item) => item.state !== 'available') ||
      connectorCapabilities.some((item) => item.state !== 'available')

    return (
      <div className="flex min-h-full flex-col" data-testid="specialist-editor">
        <div className="flex h-12 items-center gap-1 border-b border-border px-3">
          <Button variant="ghost" size="icon-sm" aria-label="Back to specialists" onClick={close}>
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <nav className="flex items-center gap-1 text-sm" aria-label="Breadcrumb">
            <button type="button" className="text-muted-foreground hover:underline" onClick={close}>
              Specialists
            </button>
            <span className="text-muted-foreground" aria-hidden="true">
              /
            </span>
            <span className="font-semibold">{editorTitle}</span>
          </nav>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-2xl">
            <div className="mb-5 flex items-center gap-3 border-b border-border pb-4">
              <Avatar iconKey={draft.iconKey} colorKey={draft.colorKey} variant="head" />
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-base font-semibold">
                  {draft.name || 'New specialist'}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {badgeLabel}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {!readOnly ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {draft.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <SettingsToggle
                      enabled={draft.enabled ?? true}
                      aria-label={`Toggle ${editorTitle}`}
                      onToggle={() => setDraft({ ...draft, enabled: !(draft.enabled ?? true) })}
                    />
                  </>
                ) : null}
                {showOverflow ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${editorTitle}`}
                      >
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="gap-2"
                        disabled={saving}
                        onSelect={() => void duplicateActive()}
                      >
                        <Copy className="size-4" aria-hidden="true" />
                        Duplicate
                      </DropdownMenuItem>
                      {canDelete ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="gap-2 text-destructive focus:text-destructive"
                            disabled={saving}
                            onSelect={() => void deleteActive()}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </div>

            <section className="mb-5 space-y-3" aria-labelledby="specialist-identity">
              <div>
                <h3 id="specialist-identity" className="text-sm font-semibold">
                  Identity
                </h3>
                <p className="text-[13px] text-muted-foreground">
                  How this specialist appears in the registry and delegation menus.
                </p>
              </div>
              <label className="block text-sm font-medium">
                Name
                <Input
                  disabled={readOnly}
                  className="mt-1"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label className="block text-sm font-medium">
                Agent ID
                <Input
                  disabled={readOnly}
                  className="mt-1 font-mono"
                  value={draft.agentId}
                  onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Used in logs and delegation. Auto-derived from the name; editable.
                </span>
              </label>
              <label className="block text-sm font-medium">
                Description
                <Input
                  disabled={readOnly}
                  className="mt-1"
                  value={draft.description ?? ''}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium">
                  Color
                  <select
                    aria-label="Color"
                    disabled={readOnly}
                    value={draft.colorKey ?? ''}
                    onChange={(event) => setDraft({ ...draft, colorKey: event.target.value })}
                    className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2"
                  >
                    {COLOR_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium">
                  Icon
                  <select
                    aria-label="Icon"
                    disabled={readOnly}
                    value={draft.iconKey ?? ''}
                    onChange={(event) => setDraft({ ...draft, iconKey: event.target.value })}
                    className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2"
                  >
                    {ICON_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div>
                <span className="block text-sm font-medium">Preview</span>
                <div className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                  <Avatar iconKey={draft.iconKey} colorKey={draft.colorKey} />
                  <span className="text-sm font-medium">{draft.name || 'Specialist'}</span>
                </div>
              </div>
            </section>

            <section className="mb-5 space-y-2" aria-labelledby="specialist-instructions">
              <div>
                <h3 id="specialist-instructions" className="text-sm font-semibold">
                  Instructions
                </h3>
                <p className="text-[13px] text-muted-foreground">
                  Appended to the framework&apos;s base prompt — it does not replace it. Optional.
                </p>
              </div>
              <Textarea
                aria-label="Instructions"
                disabled={readOnly}
                placeholder="Optional — leave empty to use the base prompt as-is."
                className="min-h-32"
                value={draft.instructions ?? ''}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              />
            </section>

            <section className="space-y-3" aria-labelledby="specialist-capabilities">
              <div>
                <h3 id="specialist-capabilities" className="text-sm font-semibold">
                  Capabilities
                </h3>
                <p className="text-[13px] text-muted-foreground">
                  Skills and connectors this specialist can use. Anything not listed stays invisible
                  and unreachable in its sessions, even when enabled globally.
                </p>
              </div>
              <div className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5" role="tablist">
                {(['skills', 'connectors'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={capTab === tab}
                    onClick={() => setCapTab(tab)}
                    className={cn(
                      'h-7 rounded-md px-3 text-xs',
                      capTab === tab
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    )}
                  >
                    {tab === 'skills'
                      ? `Skills ${effectiveSkillCount}`
                      : `Connectors ${effectiveConnectorCount}`}
                  </button>
                ))}
              </div>

              {/* Both panes stay mounted; the inactive one is hidden so stale capability state
                  remains inspectable and the tab switch is a visibility toggle, like the prototype. */}
              <div className={cn(capTab !== 'skills' && 'hidden')}>
                <CapabilityPane
                  singular="skill"
                  capabilities={skillCapabilities}
                  choices={selectableSkills.map((skill) => ({ id: skill.id, label: skill.name }))}
                  readOnly={readOnly}
                  empty="No skills added yet."
                  hint="Skills start empty and must be added. Skills not listed here are hidden from this specialist, and Skill calls to them are rejected."
                  onAdd={(id) => addCapability('skillIds', id)}
                  onRemove={(id) => removeCapability('skillIds', id)}
                />
              </div>
              <div className={cn(capTab !== 'connectors' && 'hidden')}>
                <CapabilityPane
                  singular="connector"
                  capabilities={connectorCapabilities}
                  choices={selectableConnectors.map((item) => ({
                    id: item.id,
                    label: 'displayName' in item ? item.displayName : item.name
                  }))}
                  readOnly={readOnly}
                  empty="No connectors added yet."
                  hint="New specialists start with every enabled connector. Removing one blocks it at runtime for this specialist's sessions."
                  onAdd={(id) => addCapability('connectorIds', id)}
                  onRemove={(id) => removeCapability('connectorIds', id)}
                />
              </div>

              {hasUnavailable ? (
                <p className="text-xs text-muted-foreground">
                  Unavailable references are retained safely and excluded from effective counts.
                  Disabled capabilities recover automatically when re-enabled; missing capabilities
                  can be removed.
                </p>
              ) : null}
            </section>

            {error ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex h-14 items-center gap-2 border-t border-border px-5">
          {conflicted ? (
            <div className="flex gap-2" aria-label="Revision conflict actions">
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => void reloadAfterConflict()}
              >
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
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            {!readOnly ? (
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create specialist'}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-5" data-testid="specialists-list">
      <div className="mb-4 flex items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <SelectTrigger aria-label="Filter specialists" className="w-40">
            <span>
              {FILTER_LABELS[filter]} ({counts[filter]})
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ({counts.all})</SelectItem>
            <SelectItem value="custom">Custom ({counts.custom})</SelectItem>
            <SelectItem value="builtin">Built-in ({counts.builtin})</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Search specialists"
            className="pl-8"
            placeholder="Search name, Agent ID, or description…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add specialist
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2.5" onSelect={beginCreate}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Write from scratch</span>
                <span className="text-xs text-muted-foreground">
                  Configure identity, skills, and connectors
                </span>
              </span>
            </DropdownMenuItem>
            {/* "Chat with agent" is delivered in issue04 (customize-agent-management-flow). */}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-4">
        {GROUPS.filter((group) => filter === 'all' || filter === group.key).map((group) => {
          const rows = visible.filter(group.match)
          const expanded = !collapsed[group.key]
          return (
            <div key={group.key}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
                className="flex w-full flex-col items-start gap-0.5 text-left"
              >
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  {group.label}
                  <ChevronDown
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                      expanded ? '' : '-rotate-90'
                    )}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">{group.subtitle}</span>
              </button>

              {expanded ? (
                rows.length > 0 ? (
                  <ul className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
                    {rows.map((item) => (
                      <li
                        key={item.id}
                        className="flex min-h-14 items-center gap-3 px-3 py-2.5"
                        data-testid={`specialist-row-${item.id}`}
                      >
                        <Avatar iconKey={item.iconKey} colorKey={item.colorKey} />
                        <button
                          type="button"
                          disabled={item.kind === 'builtin-reviewer'}
                          onClick={() => open(item)}
                          className="min-w-0 flex-1 text-left disabled:cursor-default"
                        >
                          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <span className="truncate">{item.name}</span>
                            {item.kind !== 'custom' ? (
                              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                Built-in
                              </span>
                            ) : null}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.kind === 'builtin-reviewer'
                              ? 'Used by Auto-review'
                              : (item.description ?? item.agentId)}
                          </span>
                          {item.kind !== 'builtin-reviewer' ? (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {item.effectiveSkillCount} skills · {item.effectiveConnectorCount}{' '}
                              connectors
                            </span>
                          ) : null}
                        </button>
                        {item.kind !== 'builtin-reviewer' ? (
                          <SettingsToggle
                            enabled={item.enabled}
                            aria-label={`Toggle ${item.name}`}
                            onToggle={() => void toggleEnabled(item)}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 py-2 text-xs text-muted-foreground">{group.empty}</p>
                )
              ) : null}
            </div>
          )
        })}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

type CapabilityPaneProps = {
  singular: string
  capabilities: Capability[]
  choices: Array<{ id: string; label: string }>
  readOnly: boolean
  empty: string
  hint: string
  onAdd: (id: string) => void
  onRemove: (id: string) => void
}

const CapabilityPane = ({
  singular,
  capabilities,
  choices,
  readOnly,
  empty,
  hint,
  onAdd,
  onRemove
}: CapabilityPaneProps): React.JSX.Element => (
  <div className="space-y-2" data-capability-pane={singular}>
    <div className="overflow-hidden rounded-lg border border-border">
      {capabilities.length === 0 ? (
        <div className="px-3 py-3 text-sm text-muted-foreground">{empty}</div>
      ) : (
        capabilities.map((capability) => (
          <div
            key={capability.id}
            data-capability-state={capability.state}
            className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs text-foreground">
                {capabilityLabel(capability)}
              </span>
            </div>
            {!readOnly ? (
              <button
                type="button"
                aria-label={`Remove ${capability.id}`}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                onClick={() => onRemove(capability.id)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))
      )}
    </div>
    {!readOnly && choices.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            ＋ Add a {singular}…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {choices.map((choice) => (
            <DropdownMenuItem key={choice.id} onSelect={() => onAdd(choice.id)}>
              {choice.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null}
    <p className="flex gap-2 rounded-md bg-muted p-2 text-[11.5px] leading-relaxed text-muted-foreground">
      <span aria-hidden="true">ⓘ</span>
      <span>{hint}</span>
    </p>
  </div>
)
