// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { PlanPreviewSurface, PlanProgressDock, WorkspacePlanCard } from './SessionPlanSurfaces'

const projection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 3,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Analysis result'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0 }
}

describe('Session Plan renderer surfaces', () => {
  it('renders the compact English proposal card and shares approval with Open', () => {
    const onOpen = vi.fn()
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<WorkspacePlanCard projection={projection} onOpen={onOpen} onRespond={onRespond} />)

    expect(screen.getByText('Plan ready for review')).toBeTruthy()
    expect(screen.getByText('Analyze one dataset')).toBeTruthy()
    expect(screen.getByText('1 phase · 1 delegation · 1 step')).toBeTruthy()
    expect(screen.getByText(/high confidence/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('approved')
  })

  it('submits explicit approval text through the shared approval transition', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const onSubmitApprovalText = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <WorkspacePlanCard
        projection={projection}
        onOpen={vi.fn()}
        onRespond={onRespond}
        onSubmitApprovalText={onSubmitApprovalText}
      />
    )

    const input = view.container.querySelector('input')!
    fireEvent.change(input, { target: { value: 'approve' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(onSubmitApprovalText).toHaveBeenCalledWith('approve'))
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('renders the three-level Plan preview and Variant B progress dock', () => {
    const { rerender } = render(<PlanPreviewSurface projection={projection} />)
    expect(screen.getByText('PHASE 1')).toBeTruthy()
    expect(screen.getByText('Primary agent')).toBeTruthy()
    expect(screen.getByText('Analyze the data')).toBeTruthy()
    expect(screen.getByText('SCOPE & FEASIBILITY · HIGH CONFIDENCE')).toBeTruthy()

    rerender(<PlanProgressDock projection={projection} onOpen={vi.fn()} />)
    expect(screen.getByText('Awaiting plan approval')).toBeTruthy()
    expect(screen.getByText('0/1 done')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('prompts for an explicit continuation after passive restart recovery', () => {
    const restored = {
      ...projection,
      approval: 'approved' as const,
      lifecycle: 'interrupted' as const,
      requiresExplicitContinuation: true,
      stepStatuses: {
        'Analyze the data': { status: 'in_progress' as const, updatedAt: 42 }
      }
    }
    const { rerender } = render(
      <WorkspacePlanCard
        projection={restored}
        onOpen={vi.fn()}
        onRespond={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(screen.getByText('Approved · Send a message to continue this plan.')).toBeTruthy()

    rerender(<PlanProgressDock projection={restored} onOpen={vi.fn()} />)
    expect(screen.getByText('Ready to continue · Send a message to resume')).toBeTruthy()

    rerender(<PlanPreviewSurface projection={restored} />)
    expect(
      screen.getByText('Plan approved. Send an explicit continuation message to resume execution.')
    ).toBeTruthy()
  })
})
