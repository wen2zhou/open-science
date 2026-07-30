import { useEffect } from 'react'
import { ChevronDown, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SettingsToggle } from './SettingsLayout'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { CreateSpecialistInput } from '../../../../shared/specialist'
import { SpecialistEditor } from './SpecialistEditor'

// Sub-view for the Specialists panel (parallels SkillsView).
export type SpecialistsView = { kind: 'list' } | { kind: 'create' }

type SpecialistsPanelProps = {
  view: SpecialistsView
  onNavigate: (view: SpecialistsView) => void
}

// The color palette used for specialist avatar backgrounds.
const AVATAR_COLORS: Record<string, string> = {
  teal: '#e0f2f1',
  purple: '#ede9fe',
  amber: '#fef3c7',
  green: '#dcfce7',
  blue: '#dbeafe',
  slate: '#f1f5f9'
}
const DEFAULT_AVATAR_COLOR = '#ececea'

const getAvatarStyle = (colorKey?: string): React.CSSProperties => ({
  background: colorKey ? (AVATAR_COLORS[colorKey] ?? DEFAULT_AVATAR_COLOR) : DEFAULT_AVATAR_COLOR
})

const SpecialistsPanel = ({ view, onNavigate }: SpecialistsPanelProps): React.JSX.Element => {
  const items = useSpecialistStore((s) => s.items)
  const isLoaded = useSpecialistStore((s) => s.isLoaded)
  const load = useSpecialistStore((s) => s.load)
  const setEnabled = useSpecialistStore((s) => s.setEnabled)
  const createSpecialist = useSpecialistStore((s) => s.create)

  useEffect(() => {
    void load()

    // Subscribe to catalog-changed push events so the list stays in sync.
    const unsub = window.api.specialist.onCatalogChanged(() => void load())
    return unsub
  }, [load])

  if (view.kind === 'create') {
    return (
      <SpecialistEditor
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (input: CreateSpecialistInput) => {
          await createSpecialist(input)
          onNavigate({ kind: 'list' })
        }}
      />
    )
  }

  // Separate Custom vs Built-in (Reviewer) items.
  const customItems = items.filter((i) => i.kind === 'custom')
  const reviewerItems = items.filter((i) => i.kind === 'reviewer')

  return (
    <div className="p-5">
      {/* Toolbar */}
      <div className="mb-4 flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add specialist
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="gap-2.5"
              onSelect={() => onNavigate({ kind: 'create' })}
            >
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Write from scratch</span>
                <span className="text-xs text-muted-foreground">
                  Configure instructions and capabilities yourself
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
          <div>
            <div className="mb-1 flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-foreground">Custom</span>
              <span className="text-xs text-muted-foreground">Created by you.</span>
            </div>

            {customItems.length > 0 ? (
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {customItems.map((item) => {
                  if (item.kind !== 'custom') return null
                  return (
                    <li
                      key={item.id}
                      data-slot="settings-list-row"
                      className="flex min-h-14 items-center gap-2 py-2.5"
                    >
                      {/* Avatar */}
                      <span
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[13px]"
                        style={getAvatarStyle(item.colorKey)}
                        aria-hidden="true"
                      >
                        {item.iconKey ? '◈' : '◈'}
                      </span>

                      {/* Body: displayName + subtle UPPER_SNAKE name + description */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm text-foreground">
                            {item.displayName}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {item.name}
                          </span>
                        </div>
                        {item.description ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                      </div>

                      {/* Enabled toggle */}
                      <SettingsToggle
                        enabled={item.enabled}
                        aria-label={`Toggle ${item.displayName}`}
                        onToggle={() => void setEnabled(item.id, !item.enabled)}
                      />
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

          {/* Built-in group (Reviewer only) */}
          {reviewerItems.length > 0 ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Built-in</span>
                <span className="text-xs text-muted-foreground">
                  Shipped with the app. Not configurable.
                </span>
              </div>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {reviewerItems.map(() => (
                  <li
                    key="reviewer"
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#dcfce7] text-[13px]"
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
    </div>
  )
}

export { SpecialistsPanel }
