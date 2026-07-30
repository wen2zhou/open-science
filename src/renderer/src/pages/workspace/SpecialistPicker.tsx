// SpecialistPicker — composer control for selecting a Personal Specialist.
// Renders as a button in the composer toolbar; opens a dropdown with None, enabled
// Personal Specialists, and a "Create new…" link. Never shows Reviewer, disabled
// specialists, or Main Agent.

import { Check, ChevronDown, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistProfileView } from '../../../../shared/specialist'

type SpecialistPickerProps = {
  // Undefined means None (no specialist selected).
  selectedId: string | undefined
  onChange: (specialistId: string | undefined) => void
  // Shows an "unavailable" pill when the selected specialist is disabled/deleted.
  unavailable?: boolean
  // A bound session from the first-turn flow shows its identity in the composer without exposing the
  // live-session switching behavior owned by issue 07.
  readOnly?: boolean
}

// Trigger label: truncated name when selected, "Specialist" placeholder when None.
const triggerLabel = (
  selected: SpecialistProfileView | undefined,
  unavailable: boolean
): string => {
  if (unavailable) return 'Unavailable'
  if (selected) return selected.name
  return 'Specialist'
}

const triggerClassName =
  'flex h-8 max-w-[180px] items-center gap-1 rounded-md px-2 text-sm text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors'

const SpecialistPicker = ({
  selectedId,
  onChange,
  unavailable = false,
  readOnly = false
}: SpecialistPickerProps): React.JSX.Element | null => {
  const [open, setOpen] = useState(false)
  const items = useSpecialistStore((state) => state.items)
  const isLoaded = useSpecialistStore((state) => state.isLoaded)
  const load = useSpecialistStore((state) => state.load)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)

  // Load specialists on first open.
  useEffect(() => {
    if (open && !isLoaded) {
      void load()
    }
  }, [open, isLoaded, load])

  // Subscribe to catalog changes so the list stays fresh.
  useEffect(() => {
    const remove = window.api.specialist.onCatalogChanged(() => {
      void load()
    })
    return remove
  }, [load])

  const enabledSpecialists = items.filter(
    (item): item is { kind: 'custom' } & SpecialistProfileView =>
      item.kind === 'custom' && item.enabled
  )

  const selected = enabledSpecialists.find((s) => s.id === selectedId)
  const isNone = selectedId === undefined

  const label = triggerLabel(selected, unavailable)
  const showBadge = Boolean(selectedId) || unavailable

  return (
    <DropdownMenu open={readOnly ? false : open} onOpenChange={readOnly ? undefined : setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            triggerClassName,
            showBadge && 'text-text-100',
            unavailable && 'text-amber-600 dark:text-amber-400'
          )}
          aria-label={`Specialist: ${label}`}
          data-testid="specialist-picker-trigger"
          disabled={readOnly}
        >
          <UserRound
            className={cn('size-4 shrink-0', unavailable && 'text-amber-600 dark:text-amber-400')}
            strokeWidth={2}
            aria-hidden="true"
          />
          {showBadge ? (
            <span className="min-w-0 max-w-[120px] truncate text-[12.5px] font-medium">
              {label}
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      {!readOnly ? (
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56 p-1">
          {/* None option */}
          <DropdownMenuItem
            onSelect={() => {
              onChange(undefined)
              setOpen(false)
            }}
            className="items-center gap-2 px-2 py-1.5"
            data-testid="specialist-option-none"
          >
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded bg-bg-300 text-[11px] text-text-300"
              aria-hidden="true"
            >
              —
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]">None</span>
            {isNone && !unavailable ? (
              <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>

          {/* Enabled Personal Specialists */}
          {isLoaded && enabledSpecialists.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              {enabledSpecialists.map((specialist) => {
                const isSelected = specialist.id === selectedId
                return (
                  <DropdownMenuItem
                    key={specialist.id}
                    onSelect={() => {
                      onChange(specialist.id)
                      setOpen(false)
                    }}
                    className="items-center gap-2 px-2 py-1.5"
                    data-testid={`specialist-option-${specialist.id}`}
                  >
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded bg-bg-300 text-[11px] font-medium"
                      aria-hidden="true"
                    >
                      {specialist.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {specialist.name}
                    </span>
                    {isSelected ? (
                      <Check
                        className="size-4 shrink-0 text-primary"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
            </>
          ) : null}

          <DropdownMenuSeparator />

          {/* Create new entry point */}
          <DropdownMenuItem
            onSelect={() => {
              openSettingsToPanel('specialists')
              setOpen(false)
            }}
            className="items-center gap-2 px-2 py-1.5 text-[13px] text-text-200"
            data-testid="specialist-option-create"
          >
            Create new…
          </DropdownMenuItem>
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}

export { SpecialistPicker }
