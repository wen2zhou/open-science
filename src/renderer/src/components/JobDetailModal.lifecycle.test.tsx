// @vitest-environment jsdom
// Tests for the issue-04 terminal lifecycle UI: Cancel / Cleanup affordances and the distinct
// terminal diagnostics (cancel / timeout / OOM / preemption / node-fail / dispatch error).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'

// Mock radix Dialog (same shape as JobDetailModal.render.test.tsx).
vi.mock('radix-ui', () => {
  const Root = ({
    open,
    children
  }: {
    open: boolean
    children: React.ReactNode
    onOpenChange?: (o: boolean) => void
  }): React.JSX.Element | null => (open ? <div data-testid="dialog-root">{children}</div> : null)
  const Portal = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  )
  const Overlay = (): React.JSX.Element => <div />
  const Content = ({
    children,
    ...rest
  }: {
    children: React.ReactNode
    [k: string]: unknown
  }): React.JSX.Element => <div {...rest}>{children}</div>
  const Close = ({ children }: { children: React.ReactElement }): React.JSX.Element => children
  return { Dialog: { Root, Portal, Overlay, Content, Close } }
})

vi.mock('../pages/settings/FileBrowserModal', () => ({
  FileBrowserModal: (): null => null
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    [k: string]: unknown
  }): React.JSX.Element => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  )
}))

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-abc',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'running',
  intent: 'Run EDA analysis',
  created_at: Date.now(),
  started_at: Date.now(),
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/home/u/.openscience/jobs/job-abc',
  stdout_tail: '',
  stderr_tail: '',
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

const cancelJob = vi.fn(async () => {})
const cleanupJob = vi.fn(async () => {})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSessionJobStore.setState(createInitialSessionJobState())
  cancelJob.mockClear()
  cleanupJob.mockClear()
  window.api = { compute: { cancelJob, cleanupJob } } as unknown as typeof window.api
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

// Flush pending microtasks (the async onClick handlers await window.api then setState).
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const renderDetail = async (job: JobSummary): Promise<void> => {
  const { JobDetailModal } = await import('./JobDetailModal')
  useSessionJobStore.getState().applyUpdate(job)
  act(() => {
    root.render(
      <JobDetailModal open={true} sessionId="sess-1" initialJob={job} onClose={vi.fn()} />
    )
  })
}

describe('JobDetailModal — cancel affordance', () => {
  it('shows Cancel for a running job and calls cancelJob on click', async () => {
    await renderDetail(makeJob({ status: 'running' }))

    const btn = container.querySelector('[data-testid="job-cancel-button"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(container.querySelector('[data-testid="job-cleanup-button"]')).toBeNull()

    act(() => btn.click())
    await flush()
    expect(cancelJob).toHaveBeenCalledWith('job-abc')
  })

  it('does NOT show Cancel for a terminal job', async () => {
    await renderDetail(
      makeJob({ status: 'success', finished_at: Date.now(), harvested_at: Date.now() })
    )
    expect(container.querySelector('[data-testid="job-cancel-button"]')).toBeNull()
  })

  it('surfaces a cancel error without collapsing it into the diagnostic', async () => {
    cancelJob.mockRejectedValueOnce(new Error('ssh unreachable'))
    await renderDetail(makeJob({ status: 'running' }))
    const btn = container.querySelector('[data-testid="job-cancel-button"]') as HTMLButtonElement
    act(() => btn.click())
    await flush()
    const err = container.querySelector('[data-testid="job-action-error"]')
    expect(err?.textContent).toContain('ssh unreachable')
  })
})

describe('JobDetailModal — cleanup affordance', () => {
  it('shows Cleanup only for a terminal + harvested job and calls cleanupJob', async () => {
    await renderDetail(
      makeJob({ status: 'success', finished_at: Date.now(), harvested_at: Date.now() })
    )
    const btn = container.querySelector('[data-testid="job-cleanup-button"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(container.querySelector('[data-testid="job-cancel-button"]')).toBeNull()

    act(() => btn.click())
    await flush()
    expect(cleanupJob).toHaveBeenCalledWith('job-abc')
  })

  it('withholds Cleanup for a terminal but un-harvested job and explains why', async () => {
    await renderDetail(
      makeJob({ status: 'failed', finished_at: Date.now(), harvested_at: undefined })
    )
    expect(container.querySelector('[data-testid="job-cleanup-button"]')).toBeNull()
    const hint = container.querySelector('[data-testid="job-cleanup-hint"]')
    expect(hint?.textContent).toMatch(/harvest completes/i)
  })
})

describe('JobDetailModal — distinct terminal diagnostics', () => {
  const diagnosticFor = async (job: JobSummary): Promise<{ tone: string; text: string }> => {
    await renderDetail(job)
    const el = container.querySelector('[data-testid="job-diagnostic"]') as HTMLElement
    return { tone: el?.getAttribute('data-tone') ?? '', text: el?.textContent ?? '' }
  }

  it('renders Cancelled distinctly', async () => {
    const d = await diagnosticFor(
      makeJob({ status: 'cancelled', error_code: 'user_cancelled', harvested_at: Date.now() })
    )
    expect(d.tone).toBe('cancelled')
    expect(d.text).toMatch(/cancelled/i)
  })

  it('renders scheduler Timeout distinctly from a generic failure', async () => {
    const d = await diagnosticFor(makeJob({ status: 'timeout', remote_state: 'TIMEOUT' }))
    expect(d.tone).toBe('timeout')
    expect(d.text).toMatch(/walltime|time limit/i)
  })

  it('renders Out of memory distinctly (failed + OUT_OF_MEMORY)', async () => {
    const d = await diagnosticFor(makeJob({ status: 'failed', remote_state: 'OUT_OF_MEMORY' }))
    expect(d.tone).toBe('failed')
    expect(d.text).toMatch(/out of memory/i)
    expect(d.text).toContain('OUT_OF_MEMORY')
  })

  it('renders Preempted distinctly (failed + PREEMPTED)', async () => {
    const d = await diagnosticFor(makeJob({ status: 'failed', remote_state: 'PREEMPTED' }))
    expect(d.text).toMatch(/preempt/i)
  })

  it('renders Node failure distinctly (failed + NODE_FAIL)', async () => {
    const d = await diagnosticFor(makeJob({ status: 'failed', remote_state: 'NODE_FAIL' }))
    expect(d.text).toMatch(/node fail/i)
  })

  it('renders a dispatch error distinctly from a workload failure', async () => {
    const d = await diagnosticFor(makeJob({ status: 'error', error_code: 'dispatch_failed' }))
    expect(d.tone).toBe('error')
    expect(d.text).toMatch(/dispatch/i)
  })
})
