// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../../shared/compute'
import { createInitialSessionJobState, useSessionJobStore } from '../../stores/session-job-store'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
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

  type AnalysisSendMessage = Parameters<typeof useJobAnalysisEffect>[0]['admitMessage']

  const Probe = ({
    enabled,
    onSendMessage = sendMessage
  }: {
    enabled: boolean
    onSendMessage?: AnalysisSendMessage
  }): null => {
    useJobAnalysisEffect({ enabled, admitMessage: onSendMessage })
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
    window.api = {
      compute: {
        jobsPendingNotification,
        jobsMarkConsumed,
        jobsList
      }
    } as unknown as Window['api']
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
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
    expect(jobsPendingNotification).toHaveBeenCalledWith({ allSessions: true })

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

  it('removes a delivery turn-end listener when persistence becomes unavailable', async () => {
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

    expect(sendMessage).toHaveBeenCalledOnce()
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
    const firstSend = vi.fn<AnalysisSendMessage>(async (input) => {
      useSessionStore.getState().appendRoutedUserMessage({
        sessionId: 'session-1',
        messageId: 'message-1',
        eventId: 'compute-delivery-event-1',
        content: input.text,
        attribution: input.attribution,
        createdAt: 2
      })
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
          session.id === 'session-1'
            ? {
                ...session,
                status: 'idle',
                messages: [
                  ...session.messages,
                  {
                    id: 'agent-message-1',
                    role: 'agent',
                    content: 'Analysis complete',
                    status: 'complete',
                    responseToMessageId: 'message-1',
                    eventIds: [],
                    createdAt: 3,
                    updatedAt: 3,
                    completedAt: 3
                  }
                ]
              }
            : session
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

    expect(jobsPendingNotification).toHaveBeenCalledWith({ allSessions: true })
    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('recovers a background Session without changing the active Session', async () => {
    const backgroundJob = makeCompletedJob({
      job_id: 'job-background',
      session_id: 'session-2'
    })
    jobsPendingNotification.mockResolvedValueOnce([backgroundJob])
    useSessionStore.setState({
      ...createInitialSessionState(),
      selectedSessionId: 'session-1',
      sessions: [
        ...useSessionStore.getState().sessions,
        {
          id: 'session-2',
          projectId: 'project-b',
          title: 'Background',
          cwd: '/workspace/project-b',
          status: 'idle',
          messages: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: 'session-2' }) })
    )
    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

  it('hydrates an unloaded Session and ACKs its durable attributed delivery without resending', async () => {
    const deliveryKey = 'compute_done:session-1:job-1'
    const loadedSession = {
      ...useSessionStore.getState().sessions[0]!,
      status: 'idle' as const,
      messages: [
        {
          id: 'persisted-compute-message',
          role: 'user' as const,
          content: 'Analyze job-1.',
          status: 'complete' as const,
          attribution: {
            kind: 'application' as const,
            feature: 'compute' as const,
            purpose: 'job-completion-analysis' as const,
            deliveryKey,
            jobIds: ['job-1']
          },
          eventIds: [],
          createdAt: 2,
          updatedAt: 2,
          completedAt: 2
        },
        {
          id: 'persisted-analysis-response',
          role: 'agent' as const,
          content: 'Analysis complete.',
          status: 'complete' as const,
          responseToMessageId: 'persisted-compute-message',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3,
          completedAt: 3
        }
      ]
    }
    const persisted = toPersistedSession(loadedSession)
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1'
          ? { ...session, contentLoaded: false, messages: [] }
          : session
      )
    }))
    window.api = {
      ...window.api,
      sessions: {
        loadOne: vi.fn(async () => persisted)
      },
      compute: { jobsPendingNotification, jobsMarkConsumed, jobsList }
    } as unknown as Window['api']

    await act(async () => {
      root.render(<Probe enabled />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(jobsMarkConsumed).toHaveBeenCalledWith('session-1', ['job-1']))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(window.api.sessions.loadOne).toHaveBeenCalledWith({
      projectId: 'project-a',
      sessionId: 'session-1'
    })
    expect(
      useSessionStore
        .getState()
        .sessions.find((session) => session.id === 'session-1')
        ?.messages.map((message) => message.id)
    ).toContain('persisted-compute-message')
  })

  it('surfaces a failed scan and retries immediately when the window regains focus', async () => {
    jobsPendingNotification
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce([makeCompletedJob()])
    let recovery: ReturnType<typeof useJobAnalysisEffect> | undefined
    const RecoveryProbe = (): null => {
      recovery = useJobAnalysisEffect({ enabled: true, admitMessage: sendMessage })
      return null
    }

    await act(async () => {
      root.render(<RecoveryProbe />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(recovery?.error).toBe('pending-scan-failed')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(jobsPendingNotification).toHaveBeenCalledTimes(2)
    expect(recovery?.error).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
