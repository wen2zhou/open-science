// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectBackgroundActivityStore } from '@/stores/project-background-activity-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { ProjectComputeInbox } from './ProjectComputeInbox'

vi.mock('react-i18next', () => createI18nTestStub())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = (id: string, title: string): ChatSession => ({
  id,
  projectId: 'project-1',
  title,
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

describe('Project Compute inbox', () => {
  let root: Root | undefined

  beforeEach(() => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
    useSessionStore.setState({
      sessions: [
        session('session-current', 'Current analysis'),
        session('session-attention', 'Needs review')
      ],
      selectedSessionId: 'session-current'
    })
    useProjectBackgroundActivityStore.getState().clear()
  })

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('groups current Session first and exposes navigation without lifecycle or detail actions', async () => {
    const getProjectActivity = vi.fn().mockResolvedValue({
      revision: 20,
      truncated: false,
      items: [
        {
          id: 'local-run:run-1',
          sourceKind: 'local-run',
          sourceId: 'run-1',
          executionType: 'python',
          projectId: 'project-1',
          sessionId: 'session-current',
          title: 'Donor-level QC',
          lane: 'Kernel · Python 3.12',
          status: 'running',
          active: true,
          needsAttention: false,
          updatedAt: 10
        },
        {
          id: 'compute-job:job-1',
          sourceKind: 'compute-job',
          sourceId: 'job-1',
          executionType: 'compute-job',
          projectId: 'project-1',
          sessionId: 'session-attention',
          title: 'Fit remote model',
          lane: 'Compute Host · Cluster One',
          status: 'needs-attention',
          active: false,
          needsAttention: true,
          updatedAt: 20
        }
      ]
    })
    vi.stubGlobal('window', {
      ...window,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      api: {
        agentResultDelivery: { getProjectActivity },
        notebook: { onChanged: vi.fn(() => () => undefined) },
        compute: { onJobUpdated: vi.fn(() => () => undefined) }
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<ProjectComputeInbox />))
    await vi.waitFor(() => expect(container.textContent).toContain('Donor-level QC'))

    expect(container.textContent?.indexOf('Current analysis')).toBeLessThan(
      container.textContent?.indexOf('Needs review') ?? 0
    )
    expect(container.textContent).toContain('Local Run')
    expect(container.textContent).toContain('Remote Compute Job')
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Needs attention',
      'Go to Session',
      'Go to Session'
    ])
    expect(container.textContent).not.toMatch(/Cancel|Dismiss|Retry|Rerun|Open/u)
  })
})
