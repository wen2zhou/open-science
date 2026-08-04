// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import { PlanPreviewSurface, PlanProgressDock, WorkspacePlanCard } from './SessionPlanSurfaces'

afterEach(cleanup)

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

const multiLevelProjection: ActivePlanProjection = {
  ...projection,
  document: {
    schema_version: 1,
    task_summary: 'Compare cohorts and draft a report',
    phases: [
      {
        name: 'Preparation',
        delegations: [
          {
            name: 'Data intake',
            steps: [
              { title: 'Read the dictionary', description: 'Confirm field meanings.' },
              { title: 'Validate inputs', description: 'Check both cohorts.' }
            ]
          }
        ]
      },
      {
        name: 'Parallel analysis',
        delegations: [
          {
            name: 'Cohort comparison',
            steps: [{ title: 'Compare cohorts', description: 'Calculate differences.' }]
          },
          {
            name: 'Evidence review',
            steps: [{ title: 'Review evidence', description: 'Check supporting evidence.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Cohort comparison', 'Review-ready report'],
    feasibility: { confidence: 'medium', rationale: 'Cohort definitions may need confirmation.' }
  },
  stepStatuses: {
    'Compare cohorts': { status: 'blocked', updatedAt: 42, notes: 'Cohort B is undefined.' }
  },
  counts: { phases: 2, delegations: 3, steps: 4, completed: 0 }
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
    const onDownload = vi.fn().mockResolvedValue(undefined)
    const onToggleFullScreen = vi.fn()
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <PlanPreviewSurface
        projection={multiLevelProjection}
        onDownload={onDownload}
        onToggleFullScreen={onToggleFullScreen}
        onRespond={onRespond}
        isFullScreen={false}
      />
    )
    expect(screen.getByText('PHASE 1')).toBeTruthy()
    expect(screen.getByText('PHASE 2')).toBeTruthy()
    expect(screen.getByText('Data intake')).toBeTruthy()
    expect(screen.getAllByText('Cohort comparison')).toHaveLength(2)
    expect(screen.getByText('Evidence review')).toBeTruthy()
    expect(screen.getByText('Compare cohorts')).toBeTruthy()
    expect(screen.getByText('Desired outputs')).toBeTruthy()
    expect(screen.getByText('Review-ready report')).toBeTruthy()
    expect(screen.getByText('Cohort B is undefined.')).toBeTruthy()
    expect(screen.getByText('SCOPE & FEASIBILITY · MEDIUM CONFIDENCE')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download Plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    expect(onDownload).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenNthCalledWith(1, 'rejected')
    expect(onRespond).toHaveBeenNthCalledWith(2, 'approved')
    expect(onToggleFullScreen).toHaveBeenCalledOnce()

    rerender(<PlanProgressDock projection={projection} onOpen={vi.fn()} />)
    expect(screen.getByText('Awaiting plan approval')).toBeTruthy()
    expect(screen.getByText('0/1 done')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('shows a stable invalid-schema state instead of rendering malformed Plan content', () => {
    render(
      <PlanPreviewSurface
        projection={
          {
            ...projection,
            document: { ...projection.document, schema_version: 2 }
          } as unknown as ActivePlanProjection
        }
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('Invalid Plan document')
    expect(screen.queryByRole('button', { name: 'Download Plan' })).toBeNull()
  })
})
