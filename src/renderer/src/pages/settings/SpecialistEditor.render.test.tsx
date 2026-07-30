// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistEditor } from './SpecialistEditor'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
import { useSettingsStore } from '@/stores/settings-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
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
  document.body.innerHTML = ''
})

describe('SpecialistEditor', () => {
  it('persists Full exclusions and Selected inclusions without losing either mode', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      connectors: [
        {
          id: 'chemistry',
          displayName: 'Chemistry',
          description: '',
          sources: [],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        },
        {
          id: 'pubmed',
          displayName: 'PubMed',
          description: '',
          sources: [],
          requiresNcbi: true,
          enabled: false,
          autoAllow: false,
          group: 'directory'
        }
      ],
      customServers: [
        {
          id: 'broken-server',
          name: 'Broken Server',
          transport: 'stdio',
          enabled: true,
          availability: 'unavailable'
        }
      ],
      loadConnectors: vi.fn().mockResolvedValue(undefined)
    })
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'connector-bot',
            name: 'Connector Bot',
            description: '',
            systemPrompt: '',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })
    expect(document.body.textContent).toContain('Broken Server')
    expect(document.body.textContent).toContain('Unavailable — unavailable')
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Allow Broken Server"]')?.disabled
    ).toBe(true)
    await act(async () => {
      fireEvent.click(document.body.querySelector<HTMLInputElement>('[aria-label="Allow PubMed"]')!)
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
          (button) => button.textContent === 'Selected capabilities'
        )!
      )
    })
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLInputElement>('[aria-label="Include Chemistry"]')!
      )
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })
    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityMode: 'selected',
        fullAccess: expect.objectContaining({ excludedConnectorIds: ['pubmed'] }),
        selectedCapabilities: expect.objectContaining({ connectorIds: ['chemistry'] })
      })
    )
  })

  it('saves the icon and color selected for a new specialist', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(<SpecialistEditor onCancel={vi.fn()} onSave={onSave} />)
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer' }
      })
    })

    const icon = document.body.querySelector<HTMLButtonElement>('[aria-label="Specialist icon"]')
    expect(icon).not.toBeNull()
    openRadixMenu(icon)
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (option) => option.textContent === 'Microscope'
        )
      )
    })

    const color = document.body.querySelector<HTMLButtonElement>('[aria-label="Specialist color"]')
    expect(color).not.toBeNull()
    openRadixMenu(color)
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (option) => option.textContent === 'Teal'
        )
      )
    })

    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RNA Reviewer',
        iconKey: 'microscope',
        colorKey: 'teal'
      })
    )
  })

  it('shows a field-level error instead of submitting a duplicate name', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SpecialistEditor existingNames={['RNA Reviewer']} onCancel={vi.fn()} onSave={onSave} />
      )
    })

    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-name')!, {
        target: { value: 'RNA Reviewer' }
      })
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create specialist')
        ?.click()
    })

    expect(document.body.querySelector('#sp-name-err')?.textContent).toContain('already in use')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('prefills the form and calls onSaveEdit with id and revision in edit mode', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'rna-reviewer',
            name: 'RNA Reviewer',
            description: 'Reviews RNA-seq.',
            systemPrompt: 'Be rigorous.',
            iconKey: 'microscope',
            colorKey: 'teal',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 3
          }}
          existingNames={['Other Name']}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={onSaveEdit}
        />
      )
    })

    // Prefilled identity.
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe('RNA Reviewer')

    // Edit mode uses the "Save changes" button and routes through onSaveEdit.
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save changes')
        ?.click()
    })

    expect(onSaveEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rna-reviewer',
        revision: 3,
        name: 'RNA Reviewer'
      })
    )
    // Create path is not used in edit mode.
    expect(document.body.querySelector('#sp-name-err')).toBeNull()
  })

  it('renders a live preview avatar reflecting the selected icon', async () => {
    await act(async () => {
      root.render(
        <SpecialistEditor
          editSpecialist={{
            id: 'rna-reviewer',
            name: 'RNA Reviewer',
            description: '',
            systemPrompt: '',
            iconKey: 'microscope',
            colorKey: 'teal',
            enabled: true,
            capabilityMode: 'full',
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
            revision: 1
          }}
          existingNames={[]}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={vi.fn()}
        />
      )
    })

    // The live preview renders the selected icon glyph.
    expect(document.body.querySelector('[data-specialist-icon="microscope"]')).not.toBeNull()
  })
})
