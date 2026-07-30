// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistPicker } from './SpecialistPicker'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { SpecialistListItem } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mock dropdown-menu to avoid Portal/open-state issues in jsdom.
// The mock renders all children inline (no portal) and ignores open/close state,
// so tests can assert on data-testid attributes without needing to open the dropdown first.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dd-content">{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    asChild: _asChild
  }: PropsWithChildren<{ asChild?: boolean }>): React.JSX.Element => <div>{children}</div>,
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
    [key: string]: unknown
  }>): React.JSX.Element => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onSelect?.({ preventDefault: () => undefined })
      }}
      {...rest}
    >
      {children}
    </button>
  )
}))

vi.mock('@/stores/specialist-store', () => ({
  useSpecialistStore: vi.fn()
}))

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: vi.fn()
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' ')
}))

// window.api stub for the catalog-change subscription.
Object.defineProperty(globalThis, 'window', {
  writable: true,
  value: {
    ...globalThis.window,
    api: {
      specialist: {
        onCatalogChanged: vi.fn(() => vi.fn())
      }
    }
  }
})

const makeSpecialist = (
  id: string,
  displayName: string,
  enabled = true
): SpecialistListItem & { kind: 'custom' } => ({
  kind: 'custom',
  id,
  name: displayName.toUpperCase().replace(/\s+/g, '_'),
  displayName,
  description: '',
  systemPrompt: 'You are...',
  enabled,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
})

const mockStore = (
  items: SpecialistListItem[],
  overrides: { isLoaded?: boolean; load?: () => Promise<void> } = {}
): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(useSpecialistStore as any).mockImplementation(
    (
      selector: (s: {
        items: SpecialistListItem[]
        isLoaded: boolean
        load: () => Promise<void>
      }) => unknown
    ) =>
      selector({
        items,
        isLoaded: overrides.isLoaded ?? true,
        load: overrides.load ?? vi.fn().mockResolvedValue(undefined)
      })
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(useSettingsStore as any).mockImplementation(
    (selector: (s: { openSettingsToPanel: (panel: string) => void }) => unknown) =>
      selector({ openSettingsToPanel: vi.fn() })
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

const renderPicker = (props: React.ComponentProps<typeof SpecialistPicker>): void => {
  act(() => {
    root.render(<SpecialistPicker {...props} />)
  })
}

describe('SpecialistPicker — trigger', () => {
  it('renders a trigger button', () => {
    mockStore([])
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-picker-trigger"]')).toBeTruthy()
  })

  it('shows no badge text when None is selected', () => {
    mockStore([])
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    // With no selection and no unavailable, showBadge is false so the span is not rendered
    const span = container.querySelector(
      '[data-testid="specialist-picker-trigger"] span.truncate'
    )
    expect(span).toBeNull()
  })

  it('shows displayName badge when a specialist is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderPicker({ selectedId: 'uuid-1', onChange: vi.fn() })
    const trigger = container.querySelector('[data-testid="specialist-picker-trigger"]')!
    expect(trigger.textContent).toContain('RNA-seq Reviewer')
  })

  it('shows "Unavailable" when unavailable prop is true', () => {
    mockStore([])
    renderPicker({ selectedId: 'stale-id', onChange: vi.fn(), unavailable: true })
    const trigger = container.querySelector('[data-testid="specialist-picker-trigger"]')!
    expect(trigger.textContent).toContain('Unavailable')
  })
})

describe('SpecialistPicker — dropdown contents', () => {
  it('includes None option', () => {
    mockStore([makeSpecialist('uuid-1', 'RNA-seq Reviewer')])
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    expect(
      container.querySelector('[data-testid="specialist-option-none"]') ??
        document.body.querySelector('[data-testid="specialist-option-none"]')
    ).toBeTruthy()
  })

  it('lists enabled specialists', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-uuid-1"]')).toBeTruthy()
  })

  it('does NOT list disabled specialists', () => {
    const disabled = makeSpecialist('uuid-disabled', 'Disabled Bot', false)
    mockStore([disabled])
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-uuid-disabled"]')).toBeNull()
  })

  it('does NOT list Reviewer entry', () => {
    const items: SpecialistListItem[] = [{ kind: 'reviewer', id: 'reviewer' }]
    mockStore(items)
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-reviewer"]')).toBeNull()
  })

  it('includes Create new… option', () => {
    mockStore([])
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-create"]')).toBeTruthy()
  })
})

describe('SpecialistPicker — selection', () => {
  it('calls onChange with undefined when None is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    const onChange = vi.fn()
    mockStore([sp])
    renderPicker({ selectedId: 'uuid-1', onChange })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="specialist-option-none"]')
        ?.click()
    })
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('calls onChange with specialist id when specialist is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    const onChange = vi.fn()
    mockStore([sp])
    renderPicker({ selectedId: undefined, onChange })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="specialist-option-uuid-1"]')
        ?.click()
    })
    expect(onChange).toHaveBeenCalledWith('uuid-1')
  })

  it('opens settings to specialists panel when Create new… is clicked', () => {
    const openSettingsToPanel = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(useSpecialistStore as any).mockImplementation(
      (
        selector: (s: {
          items: SpecialistListItem[]
          isLoaded: boolean
          load: () => Promise<void>
        }) => unknown
      ) =>
        selector({ items: [], isLoaded: true, load: vi.fn().mockResolvedValue(undefined) })
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(useSettingsStore as any).mockImplementation(
      (selector: (s: { openSettingsToPanel: (panel: string) => void }) => unknown) =>
        selector({ openSettingsToPanel })
    )
    renderPicker({ selectedId: undefined, onChange: vi.fn() })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="specialist-option-create"]')
        ?.click()
    })
    expect(openSettingsToPanel).toHaveBeenCalledWith('specialists')
  })
})
