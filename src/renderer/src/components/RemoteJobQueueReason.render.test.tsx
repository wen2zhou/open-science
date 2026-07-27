// @vitest-environment jsdom
//
// Covers the queued-reason surface (design.md §4.4). A scheduler job that is waiting for capacity used
// to be indistinguishable from a wedged one: the row showed a motionless "queued" and the detail modal
// showed nothing at all, because the diagnostic banner only rendered for terminal states. On a real
// cluster three jobs meant to run concurrently sat at PENDING/Resources for minutes with no way to
// learn why from the UI.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { RemoteJobRow } from './RemoteJobRow'
import { jobDiagnostic } from './remote-job-badge-utils'

let container: HTMLDivElement
let root: Root

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:hpc-dev',
  display_name: 'hpc-dev',
  shape: 'slurm',
  session_id: 'sess-test',
  status: 'submitted',
  intent: 'CPU task 2: integer LCG loop',
  created_at: Date.now() - 60_000,
  started_at: undefined,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (job: JobSummary): void => {
  act(() => {
    root.render(<RemoteJobRow job={job} onOpen={() => {}} />)
  })
}

describe('RemoteJobRow — queue reason tag', () => {
  it('shows the scheduler reason inline for a pending job', () => {
    render(makeJob({ queue_reason: 'Resources' }))
    const tag = container.querySelector('[data-testid="remote-job-queue-reason"]')
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toBe('Resources')
  })

  it('omits the tag when the scheduler gave no reason', () => {
    render(makeJob())
    expect(container.querySelector('[data-testid="remote-job-queue-reason"]')).toBeNull()
  })

  it('omits the tag once the job is running', () => {
    render(makeJob({ status: 'running', queue_reason: 'Resources' }))
    expect(container.querySelector('[data-testid="remote-job-queue-reason"]')).toBeNull()
  })

  // Direct SSH has no scheduler queue, so nothing about those rows may change.
  it('leaves a direct-ssh row untouched', () => {
    render(makeJob({ shape: 'direct_ssh', status: 'running' }))
    expect(container.querySelector('[data-testid="remote-job-queue-reason"]')).toBeNull()
  })
})

describe('jobDiagnostic — non-terminal queued job', () => {
  it('returns an info diagnostic (not a failure) with a sizing hint for a capacity wait', () => {
    const d = jobDiagnostic(makeJob({ remote_state: 'PENDING', queue_reason: 'Resources' }))
    expect(d.tone).toBe('info')
    expect(d.title).toContain('Queued')
    expect(d.detail).toMatch(/memory/i)
  })

  it('treats Priority as a capacity wait too', () => {
    expect(jobDiagnostic(makeJob({ queue_reason: 'Priority' })).detail).toMatch(/memory/i)
  })

  it('gives a limit-oriented hint for a non-capacity hold', () => {
    const d = jobDiagnostic(makeJob({ queue_reason: 'QOSMaxJobsPerUserLimit' }))
    expect(d.tone).toBe('info')
    expect(d.detail).toMatch(/QOS|account|partition/i)
    expect(d.detail).not.toMatch(/memory/i)
  })

  it('stays neutral with no reason, and once running', () => {
    expect(jobDiagnostic(makeJob()).tone).toBe('neutral')
    expect(jobDiagnostic(makeJob({ status: 'running', queue_reason: 'Resources' })).tone).toBe(
      'neutral'
    )
  })

  // The queued banner must never mask a terminal outcome.
  it('still reports a terminal failure when a stale reason lingers on the row', () => {
    const d = jobDiagnostic(
      makeJob({ status: 'failed', remote_state: 'OUT_OF_MEMORY', queue_reason: 'Resources' })
    )
    expect(d.tone).toBe('failed')
    expect(d.title).toBe('Out of memory')
  })
})

describe('jobDiagnostic — invalid_directives', () => {
  it('explains a pre-flight rejection distinctly from a dispatch failure', () => {
    const d = jobDiagnostic(makeJob({ status: 'error', error_code: 'invalid_directives' }))
    expect(d.tone).toBe('error')
    expect(d.title).toBe('Script rejected')
    expect(d.detail).toMatch(/submits its own job/i)
  })
})
