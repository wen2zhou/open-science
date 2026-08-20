// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../../shared/compute'
import { i18next } from '@/i18n'
import { createInitialSessionJobState, useSessionJobStore } from '../../stores/session-job-store'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { useJobAnalysisEffect } from './useJobAnalysisEffect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeCompletedJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'session-1',
  status: 'success',
  intent: 'Analyze results',
  created_at: 1000,
  started_at: 1100,
  finished_at: 1200,
  exit_code: 0,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  failure_phase: null,
  notified_at: 1300,
  notification_consumed_at: undefined,
  featured_files: [],
  featured_file_count: 0,
  left_on_remote_count: 0,
  ...overrides
})

describe('useJobAnalysisEffect persistence readiness', () => {
  let container: HTMLDivElement
  let root: Root
  const sendMessage = vi.fn().mockResolvedValue({ sessionId: 'session-1', messageId: 'message-1' })
  const jobsPendingNotification = vi.fn().mockResolvedValue([makeCompletedJob()])
  const jobsMarkConsumed = vi.fn().mockResolvedValue(undefined)
  const jobsList = vi.fn().mockResolvedValue([])

  type AnalysisSendMessage = Parameters<typeof useJobAnalysisEffect>[0]['sendMessage']

  const Probe = ({
    enabled,
    onSendMessage = sendMessage
  }: {
    enabled: boolean
    onSendMessage?: AnalysisSendMessage
  }): null => {
    useJobAnalysisEffect({ enabled, sendMessage: onSendMessage })
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    sendMessage.mockClear()
    jobsPendingNotification.mockClear()
    jobsMarkConsumed.mockClear()
    jobsList.mockClear()
    useSessionJobStore.setState({
      ...createInitialSessionJobState(),
      hydratedSessionId: 'session-1',
      isLoaded: true
    })
    useSessionStore.setState(createInitialSessionState())
    window.api = {
      compute: {
        jobsPendingNotification,
        jobsMarkConsumed,
        jobsList
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
      await i18next.changeLanguage('en')
    })
    container.remove()
  })

  it('uses the current locale without resetting repeated-failure suppression', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
      root.render(<Probe enabled />)
    })

    const failure = {
      status: 'error' as const,
      started_at: undefined,
      error_code: 'dispatch_failed',
      stderr_tail: 'stage=input_upload\nsubsystem request failed on channel 0',
      featured_files: []
    }
    act(() =>
      useSessionJobStore
        .getState()
        .applyUpdate(makeCompletedJob({ ...failure, job_id: 'job-first' }))
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('自动恢复策略')

    await act(async () => i18next.changeLanguage('ja'))
    act(() =>
      useSessionJobStore
        .getState()
        .applyUpdate(makeCompletedJob({ ...failure, job_id: 'job-same-fault' }))
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledOnce()

    act(() =>
      useSessionJobStore.getState().applyUpdate(
        makeCompletedJob({
          ...failure,
          job_id: 'job-distinct-fault',
          provider_id: 'ssh:other-host'
        })
      )
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[1]?.[0].text).toContain('自動復旧ポリシー')
  })

  it('does not start job analysis while Session persistence is not ready', async () => {
    await act(async () => {
      root.render(<Probe enabled={false} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsMarkConsumed).not.toHaveBeenCalled()
  })

  it('rechecks readiness before dispatching a delayed pending-job scan', async () => {
    let resolvePendingJobs: ((jobs: JobSummary[]) => void) | undefined
    jobsPendingNotification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingJobs = resolve
        })
    )

    await act(async () => {
      root.render(<Probe enabled />)
      await Promise.resolve()
    })
    expect(jobsPendingNotification).toHaveBeenCalledWith('session-1')

    await act(async () => root.render(<Probe enabled={false} />))
    await act(async () => {
      resolvePendingJobs?.([makeCompletedJob()])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsMarkConsumed).not.toHaveBeenCalled()
  })

  it('rechecks readiness before a queued broadcast dispatch reaches the runtime', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    await act(async () => root.render(<Probe enabled />))

    act(() => {
      useSessionJobStore.getState().applyUpdate(makeCompletedJob())
      root.render(<Probe enabled={false} />)
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsMarkConsumed).not.toHaveBeenCalled()
  })

  it('removes a queued turn-end listener when persistence becomes unavailable', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Running',
          cwd: '/workspace/project-a',
          status: 'running',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    await act(async () => root.render(<Probe enabled />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => Promise.resolve())

    await act(async () => root.render(<Probe enabled={false} />))
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'idle' } : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(jobsMarkConsumed).not.toHaveBeenCalled()
  })

  it('keeps one trigger when the runtime send callback changes during an analysis turn', async () => {
    jobsPendingNotification.mockResolvedValueOnce([])
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-a',
          title: 'Ready',
          cwd: '/workspace/project-a',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const firstSend = vi.fn<AnalysisSendMessage>(async () => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'running' } : session
        )
      }))
      return { sessionId: 'session-1', messageId: 'message-1' }
    })
    const replacementSend = vi
      .fn<AnalysisSendMessage>()
      .mockResolvedValue({ sessionId: 'session-1', messageId: 'message-2' })

    await act(async () => root.render(<Probe enabled onSendMessage={firstSend} />))
    act(() => useSessionJobStore.getState().applyUpdate(makeCompletedJob()))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(firstSend).toHaveBeenCalledOnce()

    await act(async () => root.render(<Probe enabled onSendMessage={replacementSend} />))
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'session-1' ? { ...session, status: 'idle' } : session
        )
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    expect(firstSend).toHaveBeenCalledOnce()
    expect(replacementSend).not.toHaveBeenCalled()
    expect(jobsMarkConsumed).toHaveBeenCalledOnce()
  })

  it('scans and dispatches pending analysis after persistence becomes ready', async () => {
    await act(async () => root.render(<Probe enabled={false} />))
    expect(jobsPendingNotification).not.toHaveBeenCalled()

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(jobsPendingNotification).toHaveBeenCalledWith('session-1')
    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
