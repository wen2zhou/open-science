// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistsPanel } from './SpecialistsPanel'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root
const initialStore = useSpecialistStore.getState()
const specialistItems: SpecialistListItem[] = [
  {
    kind: 'custom',
    id: 'rna-reviewer',
    name: 'RNA_REVIEWER',
    displayName: 'RNA Reviewer',
    description: 'Reviews RNA-seq analyses.',
    systemPrompt: '',
    iconKey: 'microscope',
    colorKey: 'teal',
    enabled: true,
    capabilityMode: 'full',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  {
    kind: 'custom',
    id: 'literature-reviewer',
    name: 'LITERATURE_REVIEWER',
    displayName: 'Literature Reviewer',
    description: 'Finds relevant papers.',
    systemPrompt: '',
    enabled: true,
    capabilityMode: 'selected',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1
  },
  { kind: 'reviewer', id: 'reviewer' }
]

beforeEach(() => {
  window.api = {
    specialist: {
      list: vi.fn().mockResolvedValue(specialistItems),
      create: vi.fn(),
      setEnabled: vi.fn(),
      onCatalogChanged: vi.fn(() => vi.fn())
    }
  } as unknown as Window['api']
  useSpecialistStore.setState({
    ...initialStore,
    isLoaded: true,
    items: specialistItems
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  useSpecialistStore.setState(initialStore, true)
  delete (window as unknown as { api?: unknown }).api
})

describe('SpecialistsPanel', () => {
  it('filters specialists by a user-entered search term', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const search = document.body.querySelector<HTMLInputElement>('input[type="search"]')
    expect(search).not.toBeNull()
    await act(async () => {
      fireEvent.change(search!, { target: { value: 'literature' } })
    })

    expect(document.body.textContent).toContain('Literature Reviewer')
    expect(document.body.textContent).not.toContain('RNA Reviewer')
  })

  it('filters the list to custom specialists when the Custom category is selected', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const filter = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"]'
    )
    expect(filter).not.toBeNull()
    openRadixMenu(filter)
    const custom = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'Custom'
    )
    await act(async () => {
      clickRadixMenuItem(custom)
    })

    expect(document.body.textContent).toContain('RNA Reviewer')
    expect(document.body.textContent).not.toContain('Used by Auto-review')
  })

  it('shows each custom specialist capability mode in the list summary', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Full access')
    expect(document.body.textContent).toContain('Selected capabilities')
  })

  it('renders the saved icon for a custom specialist', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.querySelector('[data-specialist-icon="microscope"]')).not.toBeNull()
  })
})
