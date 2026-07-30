import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  SPECIALIST_DESCRIPTION_MAX_LENGTH,
  SPECIALIST_NAME_MAX_LENGTH,
  validateCreateSpecialistInput,
  type CreateSpecialistInput,
  type UpdateSpecialistInput,
  type SpecialistFieldError,
  type SpecialistProfileView
} from '../../../../shared/specialist'
import { SpecialistAvatar } from './specialist-avatar'
import { AVATAR_COLORS, AVATAR_ICONS } from './specialist-icons'
import { useSettingsStore } from '@/stores/settings-store'

type SpecialistEditorProps = {
  onCancel: () => void
  onSave: (input: CreateSpecialistInput) => Promise<void>
  existingNames?: string[]
  // Edit mode: when provided, the form is prefilled from this profile and Save
  // calls onSaveEdit (with id + revision for optimistic concurrency) instead of
  // onSave. The capabilities section stays informational either way.
  editSpecialist?: SpecialistProfileView
  onSaveEdit?: (input: UpdateSpecialistInput) => Promise<void>
}

type FormState = {
  name: string
  description: string
  systemPrompt: string
  iconKey: string
  colorKey: string
  capabilityMode: 'full' | 'selected'
  excludedSkillIds: string[]
  selectedSkillIds: string[]
  excludedConnectorIds: string[]
  connectorIds: string[]
}

type ConnectorRow = {
  id: string
  name: string
  mainEnabled: boolean
  available: boolean
  availability?: 'unavailable' | 'unauthenticated'
}

type SkillRow = {
  id: string
  name: string
  mainEnabled: boolean
  missing: boolean
}

const ICON_OPTIONS = [
  { key: 'brain', label: 'Brain' },
  { key: 'beaker', label: 'Beaker' },
  { key: 'book-open', label: 'Book' },
  { key: 'flask-conical', label: 'Flask' },
  { key: 'microscope', label: 'Microscope' },
  { key: 'search', label: 'Search' }
] as const

const COLOR_OPTIONS = [
  { key: 'blue', label: 'Blue' },
  { key: 'green', label: 'Green' },
  { key: 'teal', label: 'Teal' },
  { key: 'amber', label: 'Amber' },
  { key: 'purple', label: 'Purple' },
  { key: 'slate', label: 'Slate' }
] as const

const SpecialistEditor = ({
  onCancel,
  onSave,
  onSaveEdit,
  existingNames = [],
  editSpecialist
}: SpecialistEditorProps): React.JSX.Element => {
  const isEdit = editSpecialist !== undefined
  const connectors = useSettingsStore((state) => state.connectors)
  const skills = useSettingsStore((state) => state.skills)
  const customServers = useSettingsStore((state) => state.customServers)
  const loadConnectors = useSettingsStore((state) => state.loadConnectors)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const [form, setForm] = useState<FormState>(() =>
    editSpecialist
      ? {
          name: editSpecialist.name,
          description: editSpecialist.description,
          systemPrompt: editSpecialist.systemPrompt,
          iconKey: editSpecialist.iconKey ?? 'brain',
          colorKey: editSpecialist.colorKey ?? 'purple',
          capabilityMode: editSpecialist.capabilityMode,
          excludedSkillIds: editSpecialist.fullAccess.excludedSkillIds,
          selectedSkillIds: editSpecialist.selectedCapabilities.skillIds,
          excludedConnectorIds: editSpecialist.fullAccess.excludedConnectorIds,
          connectorIds: editSpecialist.selectedCapabilities.connectorIds
        }
      : {
          name: '',
          description: '',
          systemPrompt: '',
          iconKey: 'brain',
          colorKey: 'purple',
          capabilityMode: 'full',
          excludedSkillIds: [],
          selectedSkillIds: [],
          excludedConnectorIds: [],
          connectorIds: []
        }
  )
  const [fieldErrors, setFieldErrors] = useState<SpecialistFieldError[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()

  useEffect(() => {
    void loadConnectors()
  }, [loadConnectors])

  useEffect(() => {
    if (skills.length === 0) void loadSkills()
  }, [skills.length, loadSkills])

  // Persist references to unavailable entries so a temporarily missing connector is visible and
  // cannot silently broaden the profile when it returns. Main-disabled installed connectors remain
  // selectable: Main's toggle is not a Specialist capability limit.
  const connectorRows = useMemo(() => {
    const known: ConnectorRow[] = [
      ...connectors.map((connector) => ({
        id: connector.id,
        name: connector.displayName,
        mainEnabled: connector.enabled,
        available: true
      })),
      ...customServers.map((server) => ({
        id: server.name,
        name: server.name,
        mainEnabled: server.enabled,
        available: server.availability === undefined,
        availability: server.availability
      }))
    ]
    const ids = new Set(known.map((row) => row.id))
    for (const id of [...form.excludedConnectorIds, ...form.connectorIds]) {
      if (!ids.has(id)) known.push({ id, name: id, mainEnabled: false, available: false })
    }
    return known.sort((a, b) => a.name.localeCompare(b.name))
  }, [connectors, customServers, form.connectorIds, form.excludedConnectorIds])

  // Main-disabled installed Skills remain selectable for a Specialist. Persisted IDs absent from
  // the live catalog are rendered locally so the user can remove them without blocking the session.
  const skillRows = useMemo(() => {
    const known: SkillRow[] = skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      mainEnabled: skill.enabled,
      missing: false
    }))
    const ids = new Set(known.map((skill) => skill.id))
    for (const id of [...form.excludedSkillIds, ...form.selectedSkillIds]) {
      if (!ids.has(id)) known.push({ id, name: id, mainEnabled: false, missing: true })
    }
    return known.sort((a, b) => a.name.localeCompare(b.name))
  }, [skills, form.excludedSkillIds, form.selectedSkillIds])

  const getFieldError = (field: SpecialistFieldError['field']): string | undefined =>
    fieldErrors.find((e) => e.field === field)?.message

  const validate = (): boolean => {
    // Client-side validation using the shared validator.
    const input: CreateSpecialistInput = {
      name: form.name,
      description: form.description || undefined,
      systemPrompt: form.systemPrompt || undefined
    }
    const errors = validateCreateSpecialistInput(input, existingNames)
    setFieldErrors(errors)
    return errors.length === 0
  }

  const handleSave = async (): Promise<void> => {
    if (!validate()) return

    setIsSaving(true)
    setSaveError(undefined)
    try {
      const trimmed = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        iconKey: form.iconKey,
        colorKey: form.colorKey,
        capabilityMode: form.capabilityMode,
        fullAccess: {
          ...(editSpecialist?.fullAccess ?? { excludedSkillIds: [], connectorTools: [] }),
          excludedSkillIds: form.excludedSkillIds,
          excludedConnectorIds: form.excludedConnectorIds
        },
        selectedCapabilities: {
          ...(editSpecialist?.selectedCapabilities ?? { skillIds: [], connectorTools: [] }),
          skillIds: form.selectedSkillIds,
          connectorIds: form.connectorIds
        }
      }
      if (editSpecialist) {
        await onSaveEdit?.({
          id: editSpecialist.id,
          revision: editSpecialist.revision,
          ...trimmed
        })
      } else {
        await onSave(trimmed)
      }
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : isEdit
            ? 'Could not save changes.'
            : 'Could not create specialist.'
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="p-5">
      <div className="max-w-2xl">
        {/* Saved identity bar — stable reference of what's currently persisted (edit only).
            In create mode there is nothing saved yet, so the bar is omitted. */}
        {isEdit && editSpecialist ? (
          <div className="mb-5 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <SpecialistAvatar iconKey={editSpecialist.iconKey} colorKey={editSpecialist.colorKey} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-foreground">
                  {editSpecialist.name}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Saved
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 max-w-xl text-xs text-muted-foreground">
                {editSpecialist.description || 'No description'}
              </p>
            </div>
          </div>
        ) : null}

        {/* Identity section */}
        <section className="mb-6">
          <h3 className="mb-1 text-base font-semibold text-foreground">Identity</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            How this specialist appears in the registry and session picker.
          </p>

          {/* Live preview — reflects the current icon + color + name, matching the list */}
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3">
            <SpecialistAvatar iconKey={form.iconKey} colorKey={form.colorKey} size="lg" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {form.name.trim() || 'Untitled specialist'}
              </span>
              <span className="text-xs text-muted-foreground">
                Preview — matches the list and picker.
              </span>
            </div>
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Live
            </span>
          </div>

          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold">Icon</label>
              <Select
                value={form.iconKey}
                onValueChange={(iconKey) => setForm((prev) => ({ ...prev, iconKey }))}
              >
                <SelectTrigger aria-label="Specialist icon">
                  <span className="flex items-center gap-2">
                    {(() => {
                      const Icon = AVATAR_ICONS[form.iconKey] ?? AVATAR_ICONS.brain
                      return <Icon className="size-4 shrink-0" aria-hidden="true" />
                    })()}
                    <span>{ICON_OPTIONS.find((option) => option.key === form.iconKey)?.label}</span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {ICON_OPTIONS.map((option) => {
                    const Icon = AVATAR_ICONS[option.key] ?? AVATAR_ICONS.brain
                    return (
                      <SelectItem key={option.key} value={option.key}>
                        <span className="flex items-center gap-2">
                          <Icon className="size-4 shrink-0" aria-hidden="true" />
                          {option.label}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold">Color</label>
              <Select
                value={form.colorKey}
                onValueChange={(colorKey) => setForm((prev) => ({ ...prev, colorKey }))}
              >
                <SelectTrigger aria-label="Specialist color">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-3.5 shrink-0 rounded border border-black/10"
                      style={{ background: AVATAR_COLORS[form.colorKey] }}
                      aria-hidden="true"
                    />
                    <span>
                      {COLOR_OPTIONS.find((option) => option.key === form.colorKey)?.label}
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {COLOR_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      <span className="flex items-center gap-2">
                        <span
                          className="size-3.5 shrink-0 rounded border border-black/10"
                          style={{ background: AVATAR_COLORS[option.key] }}
                          aria-hidden="true"
                        />
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Name */}
          <div className="mb-4">
            <label
              htmlFor="sp-name"
              className="mb-1.5 flex items-baseline justify-between text-xs font-semibold"
            >
              <span>Name</span>
              <span className="font-normal tabular-nums text-muted-foreground">
                {form.name.length} / {SPECIALIST_NAME_MAX_LENGTH}
              </span>
            </label>
            <Input
              id="sp-name"
              value={form.name}
              maxLength={SPECIALIST_NAME_MAX_LENGTH}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, name: e.target.value }))
                setFieldErrors((prev) => prev.filter((er) => er.field !== 'name'))
              }}
              placeholder="e.g. RNA-seq Reviewer"
              aria-describedby={getFieldError('name') ? 'sp-name-err' : undefined}
              aria-invalid={!!getFieldError('name')}
              className={cn(getFieldError('name') && 'border-destructive')}
            />
            {getFieldError('name') ? (
              <p id="sp-name-err" className="mt-1 text-xs text-destructive" role="alert">
                {getFieldError('name')}
              </p>
            ) : null}
          </div>

          {/* Description */}
          <div className="mb-0">
            <label
              htmlFor="sp-description"
              className="mb-1.5 flex items-baseline justify-between text-xs font-semibold"
            >
              <span>
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <span className="font-normal tabular-nums text-muted-foreground">
                {form.description.length} / {SPECIALIST_DESCRIPTION_MAX_LENGTH}
              </span>
            </label>
            <Input
              id="sp-description"
              value={form.description}
              maxLength={SPECIALIST_DESCRIPTION_MAX_LENGTH}
              onChange={(e) => {
                setForm((prev) => ({ ...prev, description: e.target.value }))
                setFieldErrors((prev) => prev.filter((er) => er.field !== 'description'))
              }}
              aria-describedby={getFieldError('description') ? 'sp-description-err' : undefined}
              aria-invalid={!!getFieldError('description')}
              className={cn(getFieldError('description') && 'border-destructive')}
              placeholder="Short description shown in the list and picker"
            />
            {getFieldError('description') ? (
              <p id="sp-description-err" className="mt-1 text-xs text-destructive" role="alert">
                {getFieldError('description')}
              </p>
            ) : null}
          </div>
        </section>

        {/* Instructions section */}
        <section className="mb-6 border-t border-border pt-5">
          <h3 className="mb-1 text-base font-semibold text-foreground">Instructions</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            Appended to the app&rsquo;s base prompt — does not replace safety rules or tool
            instructions. Optional.
          </p>
          <div>
            <label htmlFor="sp-system-prompt" className="sr-only">
              Instructions
            </label>
            <Textarea
              id="sp-system-prompt"
              value={form.systemPrompt}
              onChange={(e) => setForm((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              placeholder="Optional — leave empty to use the base prompt as-is."
              className="min-h-[120px] resize-y text-[13px]"
            />
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-t border-border pt-5">
          <h3 className="mb-1 text-base font-semibold text-foreground">Capabilities</h3>
          <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
            Connector access is enforced before dispatch. Main Agent connector settings do not limit
            this specialist.
          </p>
          <div
            className="mb-4 flex rounded-lg border border-border p-1"
            role="radiogroup"
            aria-label="Capability mode"
          >
            {(
              [
                ['full', 'Full access'],
                ['selected', 'Selected capabilities']
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={form.capabilityMode === mode}
                onClick={() => setForm((current) => ({ ...current, capabilityMode: mode }))}
                className={cn(
                  'flex-1 rounded-md px-3 py-1.5 text-xs font-medium',
                  form.capabilityMode === mode
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            {form.capabilityMode === 'full'
              ? 'All installed connectors are allowed unless excluded below.'
              : 'Only selected installed connectors are allowed.'}
          </p>
          <div className="divide-y rounded-lg border border-border">
            {connectorRows.map((connector) => {
              const checked =
                form.capabilityMode === 'full'
                  ? !form.excludedConnectorIds.includes(connector.id)
                  : form.connectorIds.includes(connector.id)
              const toggle = (): void => {
                if (!connector.available) return
                setForm((current) => {
                  if (current.capabilityMode === 'full') {
                    const excludedConnectorIds = checked
                      ? [...current.excludedConnectorIds, connector.id]
                      : current.excludedConnectorIds.filter((id) => id !== connector.id)
                    return { ...current, excludedConnectorIds }
                  }
                  const connectorIds = checked
                    ? current.connectorIds.filter((id) => id !== connector.id)
                    : [...current.connectorIds, connector.id]
                  return { ...current, connectorIds }
                })
              }
              return (
                <label
                  key={connector.id}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 text-sm',
                    connector.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={`${form.capabilityMode === 'full' ? 'Allow' : 'Include'} ${connector.name}`}
                    checked={checked}
                    disabled={!connector.available}
                    onChange={toggle}
                  />
                  <span className="min-w-0 flex-1 truncate">{connector.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {!connector.available
                      ? `Unavailable — ${connector.availability ?? 'not installed'}`
                      : connector.mainEnabled
                        ? 'Available'
                        : 'Main disabled · available here'}
                  </span>
                </label>
              )
            })}
            {connectorRows.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Loading connectors…</p>
            ) : null}
          </div>
          <div className="mt-5">
            <p className="mb-2 text-xs text-muted-foreground">
              {form.capabilityMode === 'full'
                ? 'All installed Skills are allowed unless excluded below; future Skills are included automatically.'
                : 'Only selected installed Skills are allowed.'}
            </p>
            <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {skillRows.map((skill) => {
                const checked =
                  form.capabilityMode === 'full'
                    ? !form.excludedSkillIds.includes(skill.id)
                    : form.selectedSkillIds.includes(skill.id)
                return (
                  <label
                    key={skill.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      aria-label={`${form.capabilityMode === 'full' ? 'Allow' : 'Include'} ${skill.name}`}
                      checked={checked}
                      onChange={() =>
                        setForm((current) => {
                          const ids =
                            current.capabilityMode === 'full'
                              ? current.excludedSkillIds
                              : current.selectedSkillIds
                          const next = checked
                            ? ids.filter((id) => id !== skill.id)
                            : [...ids, skill.id]
                          return current.capabilityMode === 'full'
                            ? { ...current, excludedSkillIds: next }
                            : { ...current, selectedSkillIds: next }
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {skill.missing
                        ? 'Missing · unavailable'
                        : skill.mainEnabled
                          ? 'Available'
                          : 'Main disabled · available here'}
                    </span>
                  </label>
                )
              })}
              {skillRows.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">Loading Skills…</p>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
              {form.capabilityMode === 'full'
                ? `${Math.max(0, skillRows.filter((skill) => !skill.missing).length - form.excludedSkillIds.filter((id) => skills.some((skill) => skill.id === id)).length)} Skills included.`
                : `${form.selectedSkillIds.filter((id) => skills.some((skill) => skill.id === id)).length} Skills selected.`}
            </p>
            {form.capabilityMode === 'selected' &&
            form.selectedSkillIds.some((id) => !skills.some((skill) => skill.id === id)) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Some selected Skill IDs are missing and unavailable.
              </p>
            ) : null}
          </div>
        </section>

        {/* Save error */}
        {saveError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}

        {/* Footer actions */}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || !form.name.trim()}
          >
            {isSaving
              ? isEdit
                ? 'Saving…'
                : 'Creating…'
              : isEdit
                ? 'Save changes'
                : 'Create specialist'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export { SpecialistEditor }
