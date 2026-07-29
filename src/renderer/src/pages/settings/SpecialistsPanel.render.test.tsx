// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistsPanel } from './SpecialistsPanel'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'

// Radix pointer-capture APIs are not implemented in jsdom.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root

// Minimal window.api stub used across all tests.
const makeApi = (overrides?: Record<string, unknown>) => ({
  settings: {
    listSpecialists: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    listConnectors: vi.fn().mockResolvedValue({ connectors: [], customServers: [] }),
    createSpecialist: vi.fn().mockResolvedValue({}),
    updateSpecialist: vi.fn().mockResolvedValue({}),
    duplicateSpecialist: vi.fn().mockResolvedValue({ id: 'dup', revision: 1 }),
    deleteSpecialist: vi.fn().mockResolvedValue({}),
    setSpecialistEnabled: vi.fn().mockResolvedValue({}),
    ...overrides
  }
})

// A complete custom specialist view with available capabilities.
const makeSpecialist = (
  overrides?: Partial<{
    id: string
    agentId: string
    name: string
    skillIds: string[]
    connectorIds: string[]
    effectiveSkillCount: number
    effectiveConnectorCount: number
  }>
) => ({
  id: 'sp-1',
  agentId: 'rna-reviewer',
  name: 'RNA Reviewer',
  description: 'Reviews RNA-seq',
  instructions: 'Check batch effects',
  colorKey: 'purple',
  iconKey: 'microscope',
  skillIds: ['deseq2'],
  connectorIds: ['pubmed'],
  enabled: true,
  revision: 1,
  kind: 'custom' as const,
  effectiveSkillCount: 1,
  effectiveConnectorCount: 1,
  ...overrides
})

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = makeApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

// Helper: open the specialist editor by clicking the first item in the list.
const openEditorFor = async (
  specialist: ReturnType<typeof makeSpecialist>,
  skills: Array<{ id: string; name: string; enabled: boolean }> = [
    { id: 'deseq2', name: 'DESeq2', enabled: true },
    { id: 'alphafold', name: 'AlphaFold', enabled: true }
  ],
  connectors: { connectors: Array<{ id: string; displayName: string; enabled: boolean }>; customServers: unknown[] } = {
    connectors: [{ id: 'pubmed', displayName: 'PubMed', enabled: true }],
    customServers: []
  }
): Promise<void> => {
  ;(window as unknown as { api: unknown }).api = makeApi({
    listSpecialists: vi.fn().mockResolvedValue([specialist]),
    listSkills: vi.fn().mockResolvedValue(skills),
    listConnectors: vi.fn().mockResolvedValue(connectors)
  })
  await act(async () => {
    root.render(<SpecialistsPanel />)
    await Promise.resolve()
    await Promise.resolve()
  })
  const row = document.body.querySelector<HTMLButtonElement>(
    `[data-testid="specialist-row-${specialist.id}"] button`
  )
  await act(async () => {
    row?.click()
    await Promise.resolve()
  })
}

describe('SpecialistsPanel (list)', () => {
  it('renders the specialists list with toggles and effective capability counts', async () => {
    ;(window as unknown as { api: unknown }).api = makeApi({
      listSpecialists: vi.fn().mockResolvedValue([
        makeSpecialist({ effectiveSkillCount: 2, effectiveConnectorCount: 3 })
      ])
    })
    await act(async () => {
      root.render(<SpecialistsPanel />)
      await Promise.resolve()
      await Promise.resolve()
    })
    // The panel loads its data on a setTimeout(0) macrotask; flush it before asserting.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('RNA Reviewer')
    expect(document.body.textContent).toContain('2 skills')
    expect(document.body.textContent).toContain('3 connectors')
  })
})

describe('SpecialistsPanel (capability tabs)', () => {
  it('shows the skills tab by default when opening an editor', async () => {
    await openEditorFor(makeSpecialist())
    const editor = document.body.querySelector('[data-testid="specialist-editor"]')
    expect(editor).not.toBeNull()
    // Skills tab should be active
    const skillsTab = document.body.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    expect(skillsTab?.textContent).toContain('Skills')
  })

  it('adds a skill from the dropdown and updates the stored list', async () => {
    await openEditorFor(
      makeSpecialist({ skillIds: [], effectiveSkillCount: 0 }),
      [{ id: 'alphafold', name: 'AlphaFold', enabled: true }]
    )

    const addBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-capability-pane="skill"] button'
    )
    openRadixMenu(addBtn)

    const menuItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('AlphaFold')
    ) as HTMLElement | undefined
    clickRadixMenuItem(menuItem)

    const pane = document.body.querySelector('[data-capability-pane="skill"]')
    // After adding, the capability is shown in the list (by name, since label is used)
    expect(pane?.textContent).toContain('AlphaFold')
  })

  it('removes a skill and updates the list', async () => {
    await openEditorFor(makeSpecialist({ skillIds: ['deseq2'] }))

    const removeBtn = document.body.querySelector<HTMLButtonElement>('[aria-label="Remove deseq2"]')
    act(() => removeBtn?.click())

    const pane = document.body.querySelector('[data-capability-pane="skill"]')
    expect(pane?.textContent).not.toContain('deseq2')
    expect(pane?.textContent).toContain('No skills added yet')
  })

  it('tab badge shows effective/stored when some references are unavailable', async () => {
    // stored 2 skills: deseq2 (available), orphan (missing)
    await openEditorFor(
      makeSpecialist({ skillIds: ['deseq2', 'orphan-deleted'], effectiveSkillCount: 1 }),
      [{ id: 'deseq2', name: 'DESeq2', enabled: true }]
    )
    // stored=2 effective=1 → tab should show "1 / 2" or similar
    const skillsTab = document.body.querySelector<HTMLButtonElement>(
      '[role="tab"][data-tab="skills"]'
    )
    expect(skillsTab?.textContent).toMatch(/1\s*\/\s*2/)
  })

  it('tab badge shows only effective count when all references are available', async () => {
    await openEditorFor(
      makeSpecialist({ skillIds: ['deseq2'], effectiveSkillCount: 1 }),
      [{ id: 'deseq2', name: 'DESeq2', enabled: true }]
    )
    const skillsTab = document.body.querySelector<HTMLButtonElement>(
      '[role="tab"][data-tab="skills"]'
    )
    // No slash when all available
    expect(skillsTab?.textContent).not.toContain('/')
    expect(skillsTab?.textContent).toMatch(/1/)
  })

  it('renders a missing reference with a distinguishable state from a disabled reference', async () => {
    // deseq2 exists but is globally disabled; orphan-deleted does not exist at all
    await openEditorFor(
      makeSpecialist({ skillIds: ['deseq2', 'orphan-deleted'] }),
      [{ id: 'deseq2', name: 'DESeq2', enabled: false }]
    )
    const missingRow = document.body.querySelector('[data-capability-state="missing"]')
    const disabledRow = document.body.querySelector('[data-capability-state="disabled"]')
    expect(missingRow).not.toBeNull()
    expect(disabledRow).not.toBeNull()
    // They must look different — we check that their rendered text labels differ
    expect(missingRow?.textContent).not.toBe(disabledRow?.textContent)
  })

  it('does not offer missing or globally-disabled skills in the add dropdown', async () => {
    // Catalog has one disabled skill; the add dropdown should not show it
    await openEditorFor(
      makeSpecialist({ skillIds: [] }),
      [
        { id: 'deseq2', name: 'DESeq2', enabled: true },
        { id: 'disabled-skill', name: 'Disabled Skill', enabled: false }
      ]
    )
    const addBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-capability-pane="skill"] button'
    )
    openRadixMenu(addBtn)
    expect(document.body.textContent).toContain('DESeq2')
    expect(document.body.textContent).not.toContain('Disabled Skill')
  })

  it('a stored missing reference survives an add/save round-trip without being auto-pruned', async () => {
    // specialist has a missing (orphan) reference stored alongside a valid one
    const updateSpy = vi.fn().mockResolvedValue(
      makeSpecialist({ skillIds: ['deseq2', 'orphan-deleted'], effectiveSkillCount: 1 })
    )
    await openEditorFor(
      makeSpecialist({
        skillIds: ['deseq2', 'orphan-deleted'],
        connectorIds: ['pubmed'],
        effectiveSkillCount: 1
      }),
      [{ id: 'deseq2', name: 'DESeq2', enabled: true }],
      {
        connectors: [{ id: 'pubmed', displayName: 'PubMed', enabled: true }],
        customServers: []
      }
    )
    // Patch updateSpecialist spy after openEditorFor sets up window.api
    ;(window as unknown as { api: { settings: { updateSpecialist: unknown } } }).api.settings.updateSpecialist = updateSpy

    const saveBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.includes('Save')
    )
    await act(async () => {
      saveBtn?.click()
      await Promise.resolve()
    })

    expect(updateSpy).toHaveBeenCalled()
    const call = updateSpy.mock.calls[0]?.[0] as { skillIds?: string[] } | undefined
    // orphan-deleted must still be present in the save payload
    expect(call?.skillIds).toContain('orphan-deleted')
  })

  it('switches between skills and connectors tabs', async () => {
    await openEditorFor(makeSpecialist())

    const connTab = document.body.querySelector<HTMLButtonElement>('[role="tab"][data-tab="connectors"]')
    act(() => connTab?.click())

    const connPane = document.body.querySelector('[data-capability-pane="connector"]')
    expect(connPane).not.toBeNull()
  })
})
