// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistSubmenu } from './SpecialistSubmenu'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { SpecialistListItem } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mock dropdown-menu to avoid Portal/open-state issues in jsdom.
// Submenus render inline so tests can assert on data-testid attributes without
// needing to drive Radix pointer hover to open the submenu.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dd-content">{children}</div>
  ),
  DropdownMenuSub: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    ...rest
  }: PropsWithChildren<Record<string, unknown>>): React.JSX.Element => (
    <div {...rest}>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dd-subcontent">{children}</div>
  ),
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
  name: string,
  enabled = true
): SpecialistListItem & { kind: 'custom' } => ({
  kind: 'custom',
  id,
  name,
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

const renderSubmenu = (props: React.ComponentProps<typeof SpecialistSubmenu>): void => {
  act(() => {
    root.render(<SpecialistSubmenu {...props} />)
  })
}

describe('SpecialistSubmenu — trigger', () => {
  it('renders a submenu trigger', () => {
    mockStore([])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-submenu-trigger"]')).toBeTruthy()
  })

  it('shows "None" in the capsule when nothing is selected', () => {
    mockStore([])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('None')
  })

  it('shows the specialist name in the capsule when one is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderSubmenu({ selectedId: 'uuid-1', onChange: vi.fn() })
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('RNA-seq Reviewer')
  })

  it('shows "Unavailable" in the capsule when unavailable prop is true', () => {
    mockStore([])
    renderSubmenu({ selectedId: 'stale-id', onChange: vi.fn(), unavailable: true })
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('Unavailable')
  })

  it('keeps a bound session specialist visible but disables the trigger and hides options', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderSubmenu({ selectedId: 'uuid-1', onChange: vi.fn(), readOnly: true })
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="specialist-submenu-trigger"]'
    )!
    expect(trigger.textContent).toContain('RNA-seq Reviewer')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    // No mutable submenu content is offered for a bound session.
    expect(container.querySelector('[data-testid="dd-subcontent"]')).toBeNull()
    expect(container.querySelector('[data-testid="specialist-option-none"]')).toBeNull()
  })
})

describe('SpecialistSubmenu — submenu contents', () => {
  it('includes None option', () => {
    mockStore([makeSpecialist('uuid-1', 'RNA-seq Reviewer')])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(
      container.querySelector('[data-testid="specialist-option-none"]') ??
        document.body.querySelector('[data-testid="specialist-option-none"]')
    ).toBeTruthy()
  })

  it('lists enabled specialists', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-uuid-1"]')).toBeTruthy()
  })

  it('does NOT list disabled specialists', () => {
    const disabled = makeSpecialist('uuid-disabled', 'Disabled Bot', false)
    mockStore([disabled])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-uuid-disabled"]')).toBeNull()
  })

  it('does NOT list Reviewer entry', () => {
    const items: SpecialistListItem[] = [{ kind: 'reviewer', id: 'reviewer' }]
    mockStore(items)
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-reviewer"]')).toBeNull()
  })

  it('includes Create new… option', () => {
    mockStore([])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-create"]')).toBeTruthy()
  })
})

describe('SpecialistSubmenu — selection', () => {
  it('calls onChange with undefined when None is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    const onChange = vi.fn()
    mockStore([sp])
    renderSubmenu({ selectedId: 'uuid-1', onChange })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="specialist-option-none"]')?.click()
    })
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('calls onChange with specialist id when specialist is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    const onChange = vi.fn()
    mockStore([sp])
    renderSubmenu({ selectedId: undefined, onChange })
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
      ) => selector({ items: [], isLoaded: true, load: vi.fn().mockResolvedValue(undefined) })
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(useSettingsStore as any).mockImplementation(
      (selector: (s: { openSettingsToPanel: (panel: string) => void }) => unknown) =>
        selector({ openSettingsToPanel })
    )
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="specialist-option-create"]')
        ?.click()
    })
    expect(openSettingsToPanel).toHaveBeenCalledWith('specialists')
  })
})
