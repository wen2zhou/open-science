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
  stepStates: { 'Analyze the data': { status: 'not_started' } },
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

  it('overlays every public step status while hiding ordinary status notes', () => {
    const steps = [
      'Not started step',
      'Running step',
      'Completed step',
      'Blocked step',
      'Skipped step',
      'Not run step'
    ]
    const statusProjection: ActivePlanProjection = {
      ...projection,
      approval: 'approved',
      lifecycle: 'blocked',
      document: {
        ...projection.document,
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: steps.map((title) => ({ title, description: `${title} description.` }))
              }
            ]
          }
        ]
      },
      stepStatuses: {
        'Running step': { status: 'in_progress', updatedAt: 1, notes: 'Hidden running note.' },
        'Completed step': { status: 'completed', updatedAt: 2, notes: 'Hidden completed note.' },
        'Blocked step': { status: 'blocked', updatedAt: 3, notes: 'Visible blocked note.' },
        'Skipped step': { status: 'skipped', updatedAt: 4, notes: 'Visible skipped note.' }
      },
      stepStates: {
        'Not started step': { status: 'not_started' },
        'Running step': { status: 'in_progress', notes: 'Hidden running note.' },
        'Completed step': { status: 'completed', notes: 'Hidden completed note.' },
        'Blocked step': { status: 'blocked', notes: 'Visible blocked note.' },
        'Skipped step': { status: 'skipped', notes: 'Visible skipped note.' },
        'Not run step': { status: 'not_run' }
      },
      counts: { phases: 1, delegations: 1, steps: 6, completed: 1 }
    }

    render(<PlanPreviewSurface projection={statusProjection} />)

    for (const [title, label] of [
      ['Not started step', 'not started'],
      ['Running step', 'in progress'],
      ['Completed step', 'completed'],
      ['Blocked step', 'blocked'],
      ['Skipped step', 'skipped'],
      ['Not run step', 'not run']
    ]) {
      expect(screen.getByLabelText(`${title} status: ${label}`)).toBeTruthy()
    }
    expect(screen.getByText('Visible blocked note.')).toBeTruthy()
    expect(screen.getByText('Visible skipped note.')).toBeTruthy()
    expect(screen.queryByText('Hidden running note.')).toBeNull()
    expect(screen.queryByText('Hidden completed note.')).toBeNull()
  })

  it('shows parallel-running count and copy in the Variant B progress dock', () => {
    render(
      <PlanProgressDock
        projection={{
          ...projection,
          approval: 'approved',
          lifecycle: 'in_progress',
          stepStatuses: {
            'Analyze the data': { status: 'in_progress', updatedAt: 1 },
            'Review evidence': { status: 'in_progress', updatedAt: 1 }
          },
          stepStates: {
            'Analyze the data': { status: 'in_progress' },
            'Review evidence': { status: 'in_progress' }
          },
          counts: { phases: 1, delegations: 2, steps: 2, completed: 0 }
        }}
        onOpen={vi.fn()}
      />
    )

    expect(screen.getByText('2 steps running in parallel')).toBeTruthy()
    expect(screen.getByText('2 running · 0/2 done')).toBeTruthy()
  })

  it('does not describe retained interrupted work as currently running', () => {
    const { container } = render(
      <PlanProgressDock
        projection={{
          ...projection,
          approval: 'approved',
          lifecycle: 'interrupted',
          stepStatuses: {
            'Analyze the data': { status: 'in_progress', updatedAt: 1 }
          },
          stepStates: {
            'Analyze the data': { status: 'in_progress' }
          }
        }}
        onOpen={vi.fn()}
      />
    )

    expect(container.textContent).toContain('Plan interrupted')
    expect(container.textContent).toContain('0/1 done')
    expect(container.textContent).not.toMatch(/running/u)
  })
})
