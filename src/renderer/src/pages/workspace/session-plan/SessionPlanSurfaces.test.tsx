// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { PlanPreviewSurface, PlanProgressDock, WorkspacePlanCard } from './SessionPlanSurfaces'

const projection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 3,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
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

afterEach(cleanup)

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

  it('submits inline revision feedback through the Plan response transport', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const onSubmitResponse = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <WorkspacePlanCard
        projection={projection}
        onOpen={vi.fn()}
        onRespond={onRespond}
        onSubmitResponse={onSubmitResponse}
      />
    )

    const input = view.container.querySelector('textarea')!
    fireEvent.change(input, { target: { value: 'Split the analysis by cohort.' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() =>
      expect(onSubmitResponse).toHaveBeenCalledWith('Split the analysis by cohort.')
    )
    expect(screen.getByText('Revising plan…')).toBeTruthy()
    expect(input.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /request changes/i })).toBeNull()

    view.rerender(
      <WorkspacePlanCard
        projection={{ ...projection }}
        onOpen={vi.fn()}
        onRespond={onRespond}
        onSubmitResponse={onSubmitResponse}
      />
    )
    await waitFor(() => expect(screen.getByText('Plan ready for review')).toBeTruthy())
    expect(input.disabled).toBe(false)
  })

  it('keeps a replaced card readable with the exact stale warning and no approval entry points', () => {
    render(
      <WorkspacePlanCard
        projection={projection}
        stale
        onOpen={vi.fn()}
        onRespond={vi.fn()}
        onSubmitResponse={vi.fn()}
      />
    )

    expect(
      screen.getByText(/A newer plan is active\. This plan can no longer be approved\./u)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.queryByLabelText('Respond to Plan')).toBeNull()
  })

  it('offers Download, Dismiss, and Approve in active Preview and makes replaced Preview read-only', () => {
    const onDownload = vi.fn()
    const onRespond = vi.fn()
    const { rerender } = render(
      <PlanPreviewSurface projection={projection} onDownload={onDownload} onRespond={onRespond} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDownload).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenNthCalledWith(1, 'rejected')
    expect(onRespond).toHaveBeenNthCalledWith(2, 'approved')

    rerender(
      <PlanPreviewSurface
        projection={projection}
        stale
        onDownload={onDownload}
        onRespond={onRespond}
      />
    )
    expect(
      screen.getByText(/This plan has been replaced by another plan and is no longer current\./u)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
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
})
