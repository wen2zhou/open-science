// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistsPanel } from './SpecialistsPanel'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem } from '../../../../shared/specialist'

const navigationMock = vi.hoisted(() => ({
  startCustomizeConversation: vi.fn()
}))

vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: {
    getState: () => ({ startCustomizeConversation: navigationMock.startCustomizeConversation })
  }
}))
vi.mock('@/lib/last-opened-project', () => ({
  resolveCustomizeProjectId: vi.fn((projects: { id: string }[]) => projects[0]?.id),
  recordLastOpenedProject: vi.fn(),
  getLastOpenedProjectId: vi.fn(() => undefined)
}))

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
    name: 'RNA Reviewer',
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
    name: 'Literature Reviewer',
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
    },
    settings: {
      listConnectors: vi.fn().mockResolvedValue({ connectors: [], customServers: [], ncbi: null }),
      listSkills: vi.fn().mockResolvedValue([])
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
  it('matches the Import ZIP entry hierarchy and template action summary', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Import a Specialist package')
    expect(document.body.textContent).toContain('Choose one ZIP containing exactly one Specialist.')
    expect(document.body.textContent).toContain('Select a Specialist ZIP')
    expect(document.body.textContent).toContain(
      'The package will be safely parsed and previewed before anything is installed.'
    )
    expect(document.body.textContent).toContain('50 MB compressed')
    expect(document.body.textContent).toContain('200 MB uncompressed')
    expect(document.body.textContent).toContain('2,000 files')
    expect(document.body.textContent).toContain('25 MB per file')
    expect(document.body.textContent).toContain('Download template')
    expect(document.body.textContent).toContain(
      'The fixed ZIP contains manifest.json, specialist.json and a bilingual README.md.'
    )
    expect(document.body.textContent).toContain('Choose ZIP')
    expect(document.body.textContent).toContain('Back')
  })

  it('starts the template download directly without an intermediate page', async () => {
    const exportContributionTemplate = vi.fn().mockResolvedValue({ saved: false })
    window.api.specialist.exportContributionTemplate = exportContributionTemplate
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const download = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Download template')
    )
    await act(async () => download?.click())

    expect(exportContributionTemplate).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Download the fixed starter ZIP')
  })

  it('quietly restores the Import ZIP entry when the native save dialog is cancelled', async () => {
    const exportContributionTemplate = vi.fn().mockResolvedValue({ saved: false })
    window.api.specialist.exportContributionTemplate = exportContributionTemplate
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const clickButton = async (label: string): Promise<void> => {
      const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      await act(async () => button?.click())
    }

    await clickButton('Download template')

    expect(exportContributionTemplate).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Select a Specialist ZIP')
    expect(document.body.textContent).not.toContain('Template saved')
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows loading and the success state around a completed template save', async () => {
    let finishSave: ((value: { saved: boolean }) => void) | undefined
    window.api.specialist.exportContributionTemplate = vi.fn(
      (): Promise<{ saved: boolean }> => new Promise((resolve) => (finishSave = resolve))
    )
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const click = async (label: string): Promise<void> => {
      const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      await act(async () => button?.click())
    }

    await click('Download template')
    expect(document.body.textContent).toContain('Saving template…')

    await act(async () => finishSave?.({ saved: true }))
    expect(document.body.textContent).toContain('Template saved')
    expect(document.body.textContent).toContain(
      'openscience-specialist-template.zip is ready for contributor editing.'
    )
  })

  it('shows a path-free error and permits retry when saving fails', async () => {
    window.api.specialist.exportContributionTemplate = vi
      .fn()
      .mockRejectedValue(new Error('EACCES /secret/location/template.zip'))
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const click = async (label: string): Promise<void> => {
      const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      )
      await act(async () => button?.click())
    }

    await click('Download template')

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save contribution template. Try again.'
    )
    expect(document.body.textContent).not.toContain('/secret/location')
    expect(document.body.textContent).toContain('Download template')
  })

  it('shows the approved full ZIP preview and opens the installed custom Specialist for editing', async () => {
    const preview = {
      candidateToken: 'candidate-1',
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        name: 'Research Synthesizer',
        description: 'Synthesizes research.',
        source: 'zip' as const,
        requiresApp: '>=0.9.2 <1.0.0',
        bundledSkillIds: [],
        requiredSkillIds: [],
        builtinSkillIds: [],
        connectorIds: ['lab-notebook']
      },
      diagnostics: [
        {
          severity: 'warning' as const,
          code: 'connector.unavailable',
          message: 'The lab-notebook Connector is unavailable.',
          relatedId: 'lab-notebook'
        },
        {
          severity: 'info' as const,
          code: 'package.metadata-noise-ignored',
          message: 'Archive metadata was ignored.'
        }
      ],
      installable: true
    }
    const selectPackage = vi.fn().mockImplementation(async () => {
      useSpecialistStore.setState({ packagePreview: preview })
      return preview
    })
    const installPackage = vi.fn().mockResolvedValue({
      status: 'installed',
      specialist: { id: 'research-synth' }
    })
    const cancelPackage = vi.fn()
    useSpecialistStore.setState({ selectPackage, installPackage, cancelPackage })
    const onNavigate = vi.fn()

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'import' }} onNavigate={onNavigate} />)
    })
    expect(document.body.textContent).toContain('Import a Specialist package')
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Choose ZIP')
        ?.click()
    })

    expect(document.body.textContent).toContain('Research Synthesizer')
    expect(document.body.textContent).toContain('research-synth')
    expect(document.body.textContent).toContain('1.3.0')
    expect(document.body.textContent).toContain('>=0.9.2 <1.0.0')
    expect(document.body.textContent).toContain('No bundled Skills')
    expect(document.body.textContent).toContain('lab-notebook')
    expect(document.body.textContent).toContain('connector.unavailable')
    expect(document.body.textContent).toContain('package.metadata-noise-ignored')

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Install Specialist')
        ?.click()
    })
    expect(installPackage).toHaveBeenCalledOnce()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'research-synth' })
  })

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

  it('shows item counts in each filter tab', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const tabs = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"] [role="tab"]'
    )
    const labels = Array.from(tabs).map((tab) => tab.textContent ?? '')
    // 2 custom + 1 built-in reviewer = 3 total
    expect(labels).toEqual(['All(3)', 'Custom(2)', 'Built-in(1)'])
  })

  it('filters the list to custom specialists when the Custom tab is clicked', async () => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const tabs = document.body.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter specialists by category"] [role="tab"]'
    )
    const custom = Array.from(tabs).find((tab) => tab.textContent?.includes('Custom'))
    expect(custom).toBeDefined()
    await act(async () => {
      custom!.click()
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

  it('navigates to the edit view when a custom specialist row body is clicked', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    const editButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Edit RNA Reviewer"]'
    )
    expect(editButton).not.toBeNull()
    await act(async () => {
      editButton!.click()
    })

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'rna-reviewer' })
  })

  it('renders the editor prefilled with the specialist data in the edit view', async () => {
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    const name = document.body.querySelector<HTMLInputElement>('#sp-name')
    expect(name?.value).toBe('RNA Reviewer')
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).some(
        (button) => button.textContent === 'Save changes'
      )
    ).toBe(true)
  })

  it('falls back to the list when the edited specialist no longer exists', async () => {
    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'missing-id' }} onNavigate={vi.fn()} />
      )
    })

    // No editor fields — the list view is rendered instead.
    expect(document.body.querySelector('#sp-name')).toBeNull()
    expect(
      document.body.querySelector('[aria-label="Filter specialists by category"]')
    ).not.toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Concurrency and reload (Findings 1, 2, 3)
  // ---------------------------------------------------------------------------

  it('F1: save payload carries the original revision even after a catalog-changed refreshes props', async () => {
    // rev 1 at mount
    const updateMock = vi.fn().mockResolvedValue(specialistItems[0])
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      update: updateMock,
      load: async () => {
        // Simulate remote write: rev bumped to 2 in the store
        useSpecialistStore.setState({
          items: specialistItems.map((item) =>
            item.kind === 'custom' && item.id === 'rna-reviewer' ? { ...item, revision: 2 } : item
          )
        })
      }
    })

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    // Dirty the form so the save button becomes active.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer Edited' }
      })
    })

    // Simulate catalog-changed: trigger load which bumps store to rev 2.
    const onCatalogChangedCb = (window.api.specialist.onCatalogChanged as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as (() => void) | undefined
    if (onCatalogChangedCb) {
      await act(async () => {
        onCatalogChangedCb()
      })
    }

    // Click Save — payload must still carry revision 1 (the pinned base revision).
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }))
  })

  it('F2: Reload actually replaces form content with the latest profile data', async () => {
    // updateMock rejects with a conflict so the banner appears.
    const updateMock = vi
      .fn()
      .mockRejectedValue(new Error('Revision conflict: expected 1, found 2.'))
    // After reload, list returns rev 2 with updated name.
    const updatedItems = specialistItems.map((item) =>
      item.kind === 'custom' && item.id === 'rna-reviewer'
        ? { ...item, revision: 2, name: 'RNA Reviewer Updated', description: 'Updated desc' }
        : item
    ) as SpecialistListItem[]

    let listCallCount = 0
    ;(window.api.specialist as unknown as { list: ReturnType<typeof vi.fn> }).list = vi.fn(
      async () => {
        listCallCount++
        if (listCallCount > 1) return updatedItems
        return specialistItems
      }
    )
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      update: updateMock,
      load: async () => {
        const items = await window.api.specialist.list()
        useSpecialistStore.setState({ items })
      }
    })

    await act(async () => {
      root.render(
        <SpecialistsPanel view={{ kind: 'edit', id: 'rna-reviewer' }} onNavigate={vi.fn()} />
      )
    })

    // Click Save to trigger conflict.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Save changes')
        ?.click()
    })

    expect(document.body.querySelector('[aria-label="Revision conflict"]')).not.toBeNull()

    // Click Reload.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((btn) => btn.textContent === 'Reload')
        ?.click()
    })

    // Form should now show the updated name from the reloaded profile.
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe(
      'RNA Reviewer Updated'
    )
    // Conflict banner is gone.
    expect(document.body.querySelector('[aria-label="Revision conflict"]')).toBeNull()
  })

  it('F3: a rejected delete keeps the dialog open and shows an error', async () => {
    const deleteMock = vi.fn().mockRejectedValue(new Error('Revision conflict — try again.'))
    useSpecialistStore.setState({
      ...useSpecialistStore.getState(),
      delete: deleteMock,
      load: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    // Open the actions dropdown for RNA Reviewer.
    const actionsBtn = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Actions for RNA Reviewer"]'
    )
    expect(actionsBtn).not.toBeNull()
    openRadixMenu(actionsBtn)
    await act(async () => {
      // small tick to let Radix open the menu
    })

    // Click Delete in the dropdown.
    const deleteItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Delete'))
    expect(deleteItem).not.toBeNull()
    await act(async () => {
      clickRadixMenuItem(deleteItem)
    })

    // Confirm deletion in the dialog.
    const confirmBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === 'Delete' && btn.closest('[role="alertdialog"]') !== null
    )
    expect(confirmBtn).not.toBeNull()
    await act(async () => {
      confirmBtn!.click()
    })

    // Dialog stays open and shows the error.
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.body.textContent).toMatch(/revision conflict|try again/i)
  })
})

// ---------------------------------------------------------------------------
// Add specialist › Chat with agent (issue 07 — Settings-to-composer journey)
// ---------------------------------------------------------------------------
describe('SpecialistsPanel Chat with agent', () => {
  const initialProjectStore = useProjectStore.getState()
  let closeSettingsSpy: ReturnType<typeof vi.spyOn>

  const project = (
    id: string,
    updatedAt: number
  ): {
    id: string
    name: string
    description: string
    isExample: boolean
    createdAt: number
    updatedAt: number
  } => ({
    id,
    name: id,
    description: '',
    isExample: false,
    createdAt: 1,
    updatedAt
  })

  beforeEach(() => {
    useSpecialistStore.setState({ ...initialStore, isLoaded: true, items: specialistItems })
    useProjectStore.setState({ ...initialProjectStore, projects: [], isLoaded: true })
    navigationMock.startCustomizeConversation.mockReset()
    closeSettingsSpy = vi
      .spyOn(useSettingsStore.getState(), 'closeSettings')
      .mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    useProjectStore.setState(initialProjectStore, true)
    closeSettingsSpy.mockRestore()
  })

  const openAddSpecialistMenu = (): HTMLElement | undefined =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Add specialist')
    )

  const renderList = async (): Promise<void> => {
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })
  }

  it('keeps Write from scratch and adds a Chat with agent entry', async () => {
    useProjectStore.setState({ projects: [project('climate-models', 1)] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const labels = items.map((item) => item.textContent ?? '')

    expect(labels.some((label) => label.includes('Write from scratch'))).toBe(true)
    expect(labels.some((label) => label.includes('Chat with agent'))).toBe(true)
  })

  it('opens the approved Import ZIP entry from the existing Add specialist menu', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    openRadixMenu(openAddSpecialistMenu())
    const importItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Import ZIP'))
    await act(async () => clickRadixMenuItem(importItem))

    expect(importItem?.textContent).toContain('Preview and install a Specialist package')
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'import' })
  })

  it('uses the approved Chat with agent subtitle copy', async () => {
    useProjectStore.setState({ projects: [project('climate-models', 1)] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    expect(document.body.textContent).toContain(
      'Start a normal conversation; the agent guides you step by step'
    )
  })

  it('disables Chat with agent and shows the zero-project help text with no projects', async () => {
    useProjectStore.setState({ projects: [] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))

    expect(chatItem).toBeDefined()
    expect(chatItem?.getAttribute('aria-disabled')).toBe('true')
    expect(chatItem?.hasAttribute('data-disabled')).toBe(true)
    expect(document.body.textContent).toContain('Open a project to chat with the agent')
  })

  it('does not start a conversation when Chat with agent is clicked with zero projects', async () => {
    useProjectStore.setState({ projects: [] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    // Radix disabled items drop click handling; simulate a click anyway to prove it is inert.
    await act(async () => {
      chatItem?.click()
    })

    expect(navigationMock.startCustomizeConversation).not.toHaveBeenCalled()
    expect(closeSettingsSpy).not.toHaveBeenCalled()
  })

  it('closes Settings and starts a customize conversation for the resolved project', async () => {
    useProjectStore.setState({ projects: [project('climate-models', 5)] })
    await renderList()

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    await act(async () => {
      clickRadixMenuItem(chatItem)
    })

    expect(navigationMock.startCustomizeConversation).toHaveBeenCalledWith('climate-models')
    expect(closeSettingsSpy).toHaveBeenCalled()
  })

  it('stays within navigation/prefill intent: no Specialist binding or create-form navigation', async () => {
    const onNavigate = vi.fn()
    useProjectStore.setState({ projects: [project('climate-models', 5)] })
    await act(async () => {
      root.render(<SpecialistsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    openRadixMenu(openAddSpecialistMenu())
    const chatItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Chat with agent'))
    await act(async () => {
      clickRadixMenuItem(chatItem)
    })

    // No create-form navigation, no specialist create — pure navigation/prefill intent.
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
