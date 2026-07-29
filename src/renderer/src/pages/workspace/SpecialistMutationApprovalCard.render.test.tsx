// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistMutationApprovalCard } from './SpecialistMutationApprovalCard'
import type { SpecialistMutationPreview } from '../../../../shared/specialist-preview'

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

const renderCard = async (
  preview: SpecialistMutationPreview,
  handlers: { onApprove?: () => void; onDecline?: () => void; pending?: boolean } = {}
): Promise<void> => {
  await act(async () => {
    root.render(
      <SpecialistMutationApprovalCard
        preview={preview}
        pending={handlers.pending}
        onApprove={handlers.onApprove ?? vi.fn()}
        onDecline={handlers.onDecline ?? vi.fn()}
      />
    )
    await Promise.resolve()
  })
}

const createPreview: SpecialistMutationPreview = {
  action: 'create',
  identity: { agentId: 'rna-reviewer', name: 'RNA Reviewer' },
  instructionsSummary: { changed: true, length: 42 },
  skills: ['deseq2', 'ggplot'],
  connectors: ['pubmed'],
  affectedSessions: { available: true }
}

describe('SpecialistMutationApprovalCard (preview rendering)', () => {
  it('renders identity, instructions summary, full Skill/Connector sets, and affected-session state', async () => {
    await renderCard(createPreview)
    const text = document.body.textContent ?? ''
    expect(text).toContain('RNA Reviewer')
    expect(text).toContain('rna-reviewer')
    // Instructions change summary, never the raw text.
    expect(document.body.querySelector('[data-testid="approval-instructions"]')?.textContent).toContain(
      'Appended guidance (42 chars)'
    )
    // Complete Skill and Connector sets (not just diffs).
    const skills = document.body.querySelector('[data-testid="approval-skills"]')
    expect(skills?.textContent).toContain('deseq2')
    expect(skills?.textContent).toContain('ggplot')
    expect(document.body.querySelector('[data-testid="approval-connectors"]')?.textContent).toContain(
      'pubmed'
    )
    // No expected revision for a brand-new create.
    expect(document.body.querySelector('[data-testid="approval-revision"]')).toBeNull()
    // Affected sessions stay available for a create.
    expect(
      document.body.querySelector('[data-testid="approval-sessions"]')?.textContent
    ).toContain('Stay available')
  })

  it('shows the expected revision for an update and unavailable sessions for a disable', async () => {
    const updatePreview: SpecialistMutationPreview = {
      action: 'update',
      identity: { id: 'sp-1', agentId: 'rna-reviewer', name: 'RNA Reviewer' },
      instructionsSummary: { changed: false, length: 42 },
      skills: ['deseq2'],
      connectors: [],
      expectedRevision: 3,
      affectedSessions: { available: false }
    }
    await renderCard(updatePreview)
    expect(document.body.querySelector('[data-testid="approval-revision"]')?.textContent).toContain('3')
    expect(
      document.body.querySelector('[data-testid="approval-instructions"]')?.textContent
    ).toContain('Unchanged (42 chars)')
    expect(
      document.body.querySelector('[data-testid="approval-sessions"]')?.textContent
    ).toContain('Become unavailable')
    // Empty connector set renders the empty label.
    expect(document.body.querySelector('[data-testid="approval-connectors"]')?.textContent).toContain(
      'No connectors'
    )
  })
})

describe('SpecialistMutationApprovalCard (decline without side effects)', () => {
  it('declining calls only onDecline and never onApprove', async () => {
    const onApprove = vi.fn()
    const onDecline = vi.fn()
    await renderCard(createPreview, { onApprove, onDecline })

    const declineBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="approval-decline"]')
    act(() => declineBtn?.click())

    expect(onDecline).toHaveBeenCalledTimes(1)
    expect(onApprove).not.toHaveBeenCalled()
  })
})

describe('SpecialistMutationApprovalCard (approve)', () => {
  it('approving calls onApprove and never onDecline', async () => {
    const onApprove = vi.fn()
    const onDecline = vi.fn()
    await renderCard(createPreview, { onApprove, onDecline })

    const approveBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')
    act(() => approveBtn?.click())

    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onDecline).not.toHaveBeenCalled()
  })

  it('disables both buttons while a confirmation is pending', async () => {
    await renderCard(createPreview, { pending: true })
    const approveBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')
    const declineBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="approval-decline"]')
    expect(approveBtn?.disabled).toBe(true)
    expect(declineBtn?.disabled).toBe(true)
    expect(approveBtn?.textContent).toContain('Approving')
  })
})
