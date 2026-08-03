import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  Copy,
  Download,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload
} from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { resolveCustomizeProjectId } from '@/lib/last-opened-project'
import { SettingsToggle } from './SettingsLayout'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { CreateSpecialistInput } from '../../../../shared/specialist'
import { SpecialistEditor } from './SpecialistEditor'
import { SpecialistAvatar } from './specialist-avatar'

// Sub-view for the Specialists panel (parallels SkillsView).
export type SpecialistsView =
  | { kind: 'list' }
  | { kind: 'create'; draft?: CreateSpecialistInput }
  | { kind: 'edit'; id: string }
  | { kind: 'import' }
  | { kind: 'builtin'; id: string }

type CategoryFilter = 'all' | 'custom' | 'builtin'

const FILTER_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  custom: 'Custom',
  builtin: 'Built-in'
}

type SpecialistsPanelProps = {
  view: SpecialistsView
  onNavigate: (view: SpecialistsView) => void
}

const SpecialistsPanel = ({ view, onNavigate }: SpecialistsPanelProps): React.JSX.Element => {
  const items = useSpecialistStore((s) => s.items)
  const isLoaded = useSpecialistStore((s) => s.isLoaded)
  const load = useSpecialistStore((s) => s.load)
  const setEnabled = useSpecialistStore((s) => s.setEnabled)
  const createSpecialist = useSpecialistStore((s) => s.create)
  const updateSpecialist = useSpecialistStore((s) => s.update)
  const deleteSpecialist = useSpecialistStore((s) => s.delete)
  const duplicateSpecialist = useSpecialistStore((s) => s.duplicate)
  const packagePreview = useSpecialistStore((s) => s.packagePreview)
  const selectPackage = useSpecialistStore((s) => s.selectPackage)
  const installPackage = useSpecialistStore((s) => s.installPackage)
  const cancelPackage = useSpecialistStore((s) => s.cancelPackage)
  // Live project catalog drives the `Chat with agent` entry's enabled state and routing. The stored
  // last-opened reference is re-validated against this list before navigating.
  const projects = useProjectStore((s) => s.projects)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [deletingItem, setDeletingItem] = useState<{
    id: string
    revision: number
    name: string
  } | null>(null)
  const [deleteError, setDeleteError] = useState<string | undefined>()
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateSaved, setTemplateSaved] = useState(false)
  const [templateSaveError, setTemplateSaveError] = useState<string | undefined>()
  const [packageBusy, setPackageBusy] = useState(false)
  const [packageErrorCode, setPackageErrorCode] = useState<string | undefined>()

  // Memoised so visibleCustomItems' memo can reference a stable value.
  const customItems = useMemo(() => items.filter((i) => i.kind === 'custom'), [items])
  const builtinItems = useMemo(() => items.filter((i) => i.kind === 'builtin'), [items])

  useEffect(() => {
    void load()

    // Subscribe to catalog-changed push events so the list stays in sync.
    const unsub = window.api.specialist.onCatalogChanged(() => void load())
    return unsub
  }, [load])

  // Keep runnable builtins distinct from the Reviewer placeholder even though Settings groups both
  // under Built-in. Only runnable builtins enter the Session picker.
  const reviewerItems = items.filter((i) => i.kind === 'reviewer')
  const visibleBuiltinItems = useMemo(() => {
    if (filter === 'custom') return []
    const term = query.trim().toLowerCase()
    if (!term) return builtinItems
    return builtinItems.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [builtinItems, filter, query])
  const visibleCustomItems = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (filter === 'builtin') return []
    if (!term) return customItems
    return customItems.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [customItems, filter, query])
  const visibleReviewerItems = useMemo(() => {
    if (filter === 'custom') return []
    const term = query.trim().toLowerCase()
    if (!term || 'reviewer used by auto-review'.includes(term)) return reviewerItems
    return []
  }, [filter, query, reviewerItems])

  // Resolves the valid last-opened project (or the newest-existing fallback) against the live catalog.
  // Undefined means zero projects and the entry is disabled with explanatory help text.
  const chatProjectId = useMemo(() => resolveCustomizeProjectId(projects), [projects])

  // Navigation/prefill intent only: closes Settings and opens the resolved project's New Conversation
  // draft carrying a `/customize` prefill. Does not send, create a session, bind a Specialist, or imply
  // mutation approval. Final activation against the real Featured Skill is owned by issue 08.
  const startChatWithAgent = (): void => {
    if (!chatProjectId) return
    useSettingsStore.getState().closeSettings()
    useNavigationStore.getState().startCustomizeConversation(chatProjectId)
  }

  const downloadTemplate = (): void => {
    void (async () => {
      setTemplateSaving(true)
      setTemplateSaveError(undefined)
      try {
        const result = await window.api.specialist.exportContributionTemplate()
        if (result.saved) setTemplateSaved(true)
      } catch {
        setTemplateSaveError('Could not save contribution template. Try again.')
      } finally {
        setTemplateSaving(false)
      }
    })()
  }

  if (view.kind === 'import' && templateSaved) {
    return (
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Import ZIP</p>
            <h2 className="mt-1 text-xl font-semibold">Import a Specialist package</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose one ZIP containing exactly one Specialist.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
            Back
          </Button>
        </div>
        <div className="rounded-xl border border-border px-6 py-10 text-center" role="status">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success-000/10 text-success-000">
            ✓
          </div>
          <h3 className="mt-4 text-lg font-semibold">Template saved</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            openscience-specialist-template.zip is ready for contributor editing.
          </p>
          <Button type="button" className="mt-5" onClick={() => setTemplateSaved(false)}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  if (view.kind === 'create') {
    return (
      <SpecialistEditor
        existingNames={customItems.map((item) => item.name)}
        initialInput={view.draft}
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (input: CreateSpecialistInput) => {
          await createSpecialist(input)
          onNavigate({ kind: 'list' })
        }}
      />
    )
  }

  if (view.kind === 'edit') {
    // Reuse the create editor prefilled from the stored profile. Capabilities
    // stay informational; only identity/instructions are editable here.
    const specialist = customItems.find((item) => item.kind === 'custom' && item.id === view.id)
    if (specialist && specialist.kind === 'custom') {
      return (
        <SpecialistEditor
          key={specialist.id}
          editSpecialist={specialist}
          existingNames={customItems.filter((item) => item.id !== view.id).map((item) => item.name)}
          onCancel={() => onNavigate({ kind: 'list' })}
          onSave={async () => onNavigate({ kind: 'list' })}
          onSaveEdit={async (input) => {
            await updateSpecialist(input)
            onNavigate({ kind: 'list' })
          }}
          onReload={async () => {
            // Load the fresh list and read the result from the store directly —
            // not from the render closure, which captured the pre-load items.
            await load()
            const refreshed = useSpecialistStore
              .getState()
              .items.find((item) => item.kind === 'custom' && item.id === view.id)
            if (refreshed && refreshed.kind === 'custom') return refreshed
            return undefined
          }}
        />
      )
    }
    // Profile no longer exists (deleted/stale) — fall through to the list.
  }

  if (view.kind === 'import') {
    const summary = packagePreview?.summary
    const blocking = packagePreview?.diagnostics.some((item) => item.severity === 'error') ?? false
    return (
      <div className="p-5">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              {packagePreview ? 'Import ZIP · Preview' : 'Import ZIP'}
            </p>
            <h2 className="mt-1 text-xl font-semibold">
              {packagePreview
                ? packagePreview.installable
                  ? 'Ready to install'
                  : 'Cannot install'
                : 'Import a Specialist package'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {packagePreview
                ? 'Review the complete package summary and diagnostics before installing.'
                : 'Choose one ZIP containing exactly one Specialist.'}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
            Back
          </Button>
        </div>

        {!packagePreview ? (
          <div className="rounded-xl border border-border p-6 text-center">
            <Upload className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-3 text-sm font-semibold">Select a Specialist ZIP</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The package will be safely parsed and previewed before anything is installed.
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              Limits: 50 MB compressed · 200 MB uncompressed · 2,000 files · 25 MB per file
            </p>
            <p className="mx-auto mt-2 max-w-xl text-xs text-muted-foreground">
              The fixed ZIP contains manifest.json, specialist.json and a bilingual README.md.
              Placeholder fields are expected until you fill them in.
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={templateSaving}
                onClick={downloadTemplate}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                {templateSaving ? 'Saving template…' : 'Download template'}
              </Button>
              <Button
                type="button"
                disabled={packageBusy}
                onClick={() => {
                  setPackageBusy(true)
                  void selectPackage().finally(() => setPackageBusy(false))
                }}
              >
                Choose ZIP
              </Button>
            </div>
            {templateSaveError ? (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-danger-000/30 bg-danger-000/10 p-3 text-sm text-danger-000"
              >
                {templateSaveError}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Specialist ZIP preview"
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-border p-4 text-sm">
              <div>
                <span className="block text-xs text-muted-foreground">Specialist</span>
                {summary?.name ?? 'Unknown'}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">Immutable ID</span>
                {summary?.id ?? 'Unknown'}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">Package version</span>
                {summary?.version ?? 'Unknown'}
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">App compatibility</span>
                {summary?.requiresApp ?? 'Not declared'}
              </div>
            </div>

            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">Skills</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {summary?.bundledSkillIds.length
                  ? `Bundled: ${summary.bundledSkillIds.join(', ')}`
                  : 'No bundled Skills'}
              </p>
              {summary?.requiredSkillIds.length ? (
                <p className="mt-1 text-xs">Referenced: {summary.requiredSkillIds.join(', ')}</p>
              ) : null}
              {summary?.builtinSkillIds.length ? (
                <p className="mt-1 text-xs">Builtin: {summary.builtinSkillIds.join(', ')}</p>
              ) : null}
            </section>

            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">Connectors</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {summary?.connectorIds.length
                  ? summary.connectorIds.join(', ')
                  : 'No Connector references'}
              </p>
            </section>

            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">Diagnostics</h3>
              {packagePreview.diagnostics.length ? (
                <ul className="mt-2 space-y-2">
                  {packagePreview.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`} className="text-xs">
                      <strong>
                        {diagnostic.severity.toUpperCase()} · {diagnostic.code}
                      </strong>
                      <span className="block text-muted-foreground">
                        {diagnostic.message}
                        {diagnostic.relatedId ? ` · ${diagnostic.relatedId}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">Validation passed.</p>
              )}
            </section>

            {packagePreview.overwrite ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 p-3 text-xs text-destructive"
              >
                Existing custom Specialist {packagePreview.overwrite.id} requires overwrite
                confirmation. Overwrite is not available in this release.
              </p>
            ) : null}
            {packageErrorCode ? (
              <p role="alert" className="text-xs text-destructive">
                Import failed: {packageErrorCode}
              </p>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelPackage().then(() => onNavigate({ kind: 'list' }))}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={packageBusy || blocking || !packagePreview.installable}
                onClick={() => {
                  setPackageBusy(true)
                  void installPackage()
                    .then((result) => {
                      if (result.status === 'installed') {
                        onNavigate({ kind: 'edit', id: result.specialist.id })
                      } else {
                        setPackageErrorCode(result.code)
                      }
                    })
                    .finally(() => setPackageBusy(false))
                }}
              >
                Install Specialist
              </Button>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (view.kind === 'builtin') {
    const specialist = builtinItems.find((item) => item.id === view.id)
    if (specialist) {
      const skillIds =
        specialist.capabilityMode === 'selected'
          ? specialist.selectedCapabilities.skillIds
          : specialist.fullAccess.excludedSkillIds
      return (
        <div className="p-5">
          <Button type="button" variant="ghost" onClick={() => onNavigate({ kind: 'list' })}>
            Back to specialists
          </Button>
          <div className="mt-5 flex items-start gap-3">
            <SpecialistAvatar iconKey={specialist.iconKey} colorKey={specialist.colorKey} />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {specialist.displayName ?? specialist.name}
              </h2>
              <p className="text-xs text-muted-foreground">
                Built-in · Version {specialist.version}
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm text-foreground">{specialist.description}</p>
          <div className="mt-5 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">Read-only</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This Specialist ships with the app and cannot be changed.
            </p>
          </div>
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-foreground">Capabilities</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {specialist.capabilityMode === 'full' ? 'Full access' : 'Selected capabilities'}
            </p>
            {skillIds.length > 0 ? (
              <ul className="mt-2 list-inside list-disc text-xs text-foreground">
                {skillIds.map((skillId) => (
                  <li key={skillId}>{skillId}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )
    }
  }

  return (
    <div className="p-5">
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-2">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Filter specialists by category"
        >
          {(['all', 'custom', 'builtin'] as const).map((key) => {
            const count =
              key === 'all'
                ? items.length
                : key === 'custom'
                  ? customItems.length
                  : builtinItems.length + reviewerItems.length
            const active = filter === key
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(key)}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none ${
                  active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {FILTER_LABELS[key]}
                <span className="tabular-nums text-muted-foreground">({count})</span>
              </button>
            )
          })}
        </div>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search specialists"
            placeholder="Search specialists…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add specialist
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'create' })}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Write from scratch</span>
                <span className="text-xs text-muted-foreground">
                  Configure instructions and capabilities yourself
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2.5"
              disabled={!chatProjectId}
              aria-disabled={!chatProjectId}
              onSelect={(event) => {
                // A disabled item cannot fire onSelect in Radix, but keep the guard explicit so the
                // intent stays a no-op if the catalog empties between render and click.
                if (!chatProjectId) {
                  event.preventDefault()
                  return
                }
                startChatWithAgent()
              }}
            >
              <MessagesSquare className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Chat with agent</span>
                <span className="text-xs text-muted-foreground">
                  Start a normal conversation; the agent guides you step by step
                </span>
              </span>
            </DropdownMenuItem>
            {!chatProjectId ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2.5 pb-1 pt-0.5 text-xs text-muted-foreground">
                  Open a project to chat with the agent
                </p>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <Upload className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Import ZIP</span>
                <span className="text-xs text-muted-foreground">
                  Preview and install a Specialist package
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!isLoaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Custom specialists group */}
          {filter !== 'builtin' ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Custom</span>
                <span className="text-xs text-muted-foreground">Created by you.</span>
              </div>

              {visibleCustomItems.length > 0 ? (
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {visibleCustomItems.map((item) => {
                    if (item.kind !== 'custom') return null
                    return (
                      <li
                        key={item.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 items-center gap-2 py-2.5"
                      >
                        {/* Click the row body to open the editor (prefilled) */}
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                          aria-label={`Edit ${item.displayName ?? item.name}`}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {/* Avatar */}
                          <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} />

                          {/* Body: name + description */}
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">
                              {item.displayName ?? item.name}
                            </span>
                            {item.description ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {item.description}
                              </span>
                            ) : null}
                            <span className="block text-[11px] text-muted-foreground">
                              {item.capabilityMode === 'full'
                                ? 'Full access'
                                : 'Selected capabilities'}
                              {item.origin === 'imported' ? ' · Imported' : ''}
                            </span>
                          </div>
                        </button>

                        {/* Enabled toggle */}
                        <SettingsToggle
                          enabled={item.enabled}
                          aria-label={`Toggle ${item.displayName ?? item.name}`}
                          onToggle={() => void setEnabled(item.id, !item.enabled)}
                        />
                        <DropdownMenu>
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Actions for ${item.displayName ?? item.name}`}
                                  >
                                    <ChevronDown aria-hidden="true" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </TooltipTrigger>
                              <TooltipContent>
                                Actions for {item.displayName ?? item.name}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() =>
                                void duplicateSpecialist(item.id).then((draft) =>
                                  onNavigate({ kind: 'create', draft })
                                )
                              }
                            >
                              <Copy className="size-3.5" aria-hidden="true" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs text-destructive"
                              onSelect={() =>
                                setDeletingItem({
                                  id: item.id,
                                  revision: item.revision,
                                  name: item.displayName ?? item.name
                                })
                              }
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-2 py-2 text-xs text-muted-foreground">
                  No specialists yet. Use &ldquo;Add specialist&rdquo; to create one.
                </p>
              )}
            </div>
          ) : null}

          {/* Built-in group: runnable repository profiles plus the separate Reviewer placeholder. */}
          {visibleBuiltinItems.length > 0 || visibleReviewerItems.length > 0 ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Built-in</span>
                <span className="text-xs text-muted-foreground">
                  Shipped with the app. Not configurable.
                </span>
              </div>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {visibleBuiltinItems.map((item) => (
                  <li
                    key={item.id}
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => onNavigate({ kind: 'builtin', id: item.id })}
                      aria-label={`View ${item.displayName ?? item.name}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {item.displayName ?? item.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.description}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          Built-in · Version {item.version}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
                {visibleReviewerItems.map(() => (
                  <li
                    key="reviewer"
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[13px] text-primary"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">Reviewer</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Used by Auto-review
                      </span>
                    </div>
                    {/* No toggle, no actions for Reviewer */}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog.Root
        open={deletingItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingItem(null)
            setDeleteError(undefined)
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
            <AlertDialog.Title className={dialogTitleClassName}>
              Delete {deletingItem?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              This will permanently remove this specialist and all its configurations. This action
              cannot be undone.
            </AlertDialog.Description>
            {deleteError ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
              >
                {deleteError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (!deletingItem) return
                  const item = deletingItem
                  void (async () => {
                    try {
                      await deleteSpecialist(item.id, item.revision)
                      setDeletingItem(null)
                      setDeleteError(undefined)
                    } catch (err) {
                      // Reload the list so a retry picks up the current revision.
                      void load()
                      setDeleteError(
                        err instanceof Error
                          ? err.message
                          : 'This specialist changed — review and try again.'
                      )
                    }
                  })()
                }}
              >
                Delete
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { SpecialistsPanel }
