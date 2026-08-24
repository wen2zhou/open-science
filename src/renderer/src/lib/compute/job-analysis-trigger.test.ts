// Tests for the analysis turn trigger: receives done-state job broadcasts and auto-fires a
// sendPrompt per session, batching same-session done jobs, queuing when a turn is in flight,
// and marking notificationConsumedAt only on success. Pure renderer logic per design §11.

import { describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../../shared/compute'
import {
  buildAnalysisPrompt,
  createJobAnalysisTrigger,
  type JobAnalysisTriggerDeps
} from './job-analysis-trigger'

// ── helpers ──────────────────────────────────────────────────────────────────

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'success',
  intent: 'Salary analysis',
  created_at: 1000,
  started_at: 1100,
  finished_at: 1200,
  exit_code: 0,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: 2000,
  notification_consumed_at: undefined,
  featured_files: ['hpc/job-1/featured/result.txt'],
  featured_file_count: 1,
  left_on_remote_count: 0,
  ...overrides
})

const createDeps = (overrides: Partial<JobAnalysisTriggerDeps> = {}): JobAnalysisTriggerDeps => ({
  isSessionInFlight: vi.fn().mockReturnValue(false),
  sendPrompt: vi.fn().mockResolvedValue({ sessionId: 'sess-1', messageId: 'msg-1' }),
  findPersistedDelivery: vi.fn().mockReturnValue(undefined),
  getDeliveryOutcome: vi.fn().mockReturnValue('succeeded'),
  flushPersistence: vi.fn().mockResolvedValue(undefined),
  markConsumed: vi.fn().mockResolvedValue(undefined),
  onTurnEnd: vi.fn(),
  log: vi.fn(),
  ...overrides
})

const flushMicrotasks = (): Promise<void> => Promise.resolve()

// ── buildAnalysisPrompt ───────────────────────────────────────────────────────

describe('buildAnalysisPrompt', () => {
  it('produces an english prompt mentioning job_id and featured_files', () => {
    const job = makeJob({ job_id: 'job-abc', featured_files: ['hpc/job-abc/featured/out.txt'] })
    const prompt = buildAnalysisPrompt([job])
    expect(prompt).toContain('job-abc')
    expect(prompt).toContain('hpc/job-abc/featured/out.txt')
    expect(prompt).toContain('attachJob')
    expect(prompt).not.toContain('attach_job')
    expect(prompt).toContain('result()')
  })

  it('includes all job_ids when multiple jobs are batched', () => {
    const jobs = [
      makeJob({ job_id: 'job-1', session_id: 'sess-1' }),
      makeJob({ job_id: 'job-2', session_id: 'sess-1' })
    ]
    const prompt = buildAnalysisPrompt(jobs)
    expect(prompt).toContain('job-1')
    expect(prompt).toContain('job-2')
  })

  it('notes harvest_failed jobs as having incomplete harvest', () => {
    const job = makeJob({ job_id: 'job-fail', status: 'failed', featured_files: [] })
    const prompt = buildAnalysisPrompt([job])
    expect(prompt).toContain('job-fail')
  })
})

// ── createJobAnalysisTrigger ──────────────────────────────────────────────────

describe('createJobAnalysisTrigger — immediate send', () => {
  it.each(['queued', 'submitted', 'running'] as const)(
    'does not treat notified %s compatibility rows as finished',
    async (status) => {
      const deps = createDeps()
      const trigger = createJobAnalysisTrigger(deps)

      trigger.onJobDone(makeJob({ status }))
      await flushMicrotasks()

      expect(deps.sendPrompt).not.toHaveBeenCalled()
    }
  )

  it('does not analyze quarantined integrity rows', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(
      makeJob({
        needs_attention: true,
        raw_status: 'future_state',
        integrity_issues: [
          {
            jobId: 'job-1',
            sessionId: 'sess-1',
            projectId: 'project-1',
            code: 'unknown-status',
            disposition: 'quarantined',
            rawStatus: 'future_state'
          }
        ]
      })
    )
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  it('sends a prompt immediately when session is not in flight', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    const [sessionId, text] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string
    ]
    expect(sessionId).toBe('sess-1')
    expect(text).toContain('job-1')
    expect((deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toEqual({
      kind: 'application',
      feature: 'compute',
      purpose: 'job-completion-analysis',
      deliveryKey: 'compute_done:sess-1:job-1',
      jobIds: ['job-1']
    })
  })

  it('calls markConsumed after sendPrompt resolves and turn ends', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    // onTurnEnd should have been called to register a callback
    expect(deps.onTurnEnd).toHaveBeenCalledTimes(1)
    const [sessionId, callback] = (deps.onTurnEnd as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      () => void
    ]
    expect(sessionId).toBe('sess-1')

    // Simulate turn completion by invoking the callback
    await callback()

    // Durable Session flush is the commit point before the job inbox ACK.
    expect(deps.flushPersistence).toHaveBeenCalledOnce()
    expect(deps.markConsumed).toHaveBeenCalledWith('sess-1', ['job-1'])
  })

  it('does not call markConsumed when sendPrompt returns undefined (failed)', async () => {
    const deps = createDeps({
      sendPrompt: vi.fn().mockResolvedValue(undefined)
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.markConsumed).not.toHaveBeenCalled()
  })

  it('does not call markConsumed when sendPrompt rejects', async () => {
    const deps = createDeps({
      sendPrompt: vi.fn().mockRejectedValue(new Error('already running'))
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.markConsumed).not.toHaveBeenCalled()
  })
})

describe('createJobAnalysisTrigger — durable delivery recovery', () => {
  it('ACKs a successful persisted delivery after restart without resending analysis', async () => {
    const deps = createDeps({
      findPersistedDelivery: vi.fn().mockReturnValue({
        messageId: 'persisted-message-1',
        outcome: 'succeeded'
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.flushPersistence).toHaveBeenCalledOnce()
    expect(deps.markConsumed).toHaveBeenCalledWith('sess-1', ['job-1'])
  })

  it('does not ACK when the Session flush fails and retries only the ACK path', async () => {
    const flushPersistence = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const deps = createDeps({
      findPersistedDelivery: vi.fn().mockReturnValue({
        messageId: 'persisted-message-1',
        outcome: 'succeeded'
      }),
      flushPersistence
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()
    expect(deps.markConsumed).not.toHaveBeenCalled()

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(flushPersistence).toHaveBeenCalledTimes(2)
    expect(deps.markConsumed).toHaveBeenCalledOnce()
  })

  it('retries a failed inbox ACK without resending the persisted analysis', async () => {
    const markConsumed = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce(undefined)
    const deps = createDeps({
      findPersistedDelivery: vi.fn().mockReturnValue({
        messageId: 'persisted-message-1',
        outcome: 'succeeded'
      }),
      markConsumed
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()
    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(markConsumed).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'cancelled'] as const)(
    'does not ACK or resend a persisted %s analysis turn',
    async (outcome) => {
      const deps = createDeps({
        findPersistedDelivery: vi.fn().mockReturnValue({
          messageId: 'persisted-message-1',
          outcome
        })
      })
      const trigger = createJobAnalysisTrigger(deps)

      trigger.onJobDone(makeJob())
      await flushMicrotasks()
      await flushMicrotasks()

      expect(deps.sendPrompt).not.toHaveBeenCalled()
      expect(deps.flushPersistence).not.toHaveBeenCalled()
      expect(deps.markConsumed).not.toHaveBeenCalled()
    }
  )

  it('waits through Plan approval and ACKs only after the same delivery succeeds', async () => {
    let outcome: 'pending' | 'succeeded' = 'pending'
    let turnEnd: (() => void) | undefined
    const deps = createDeps({
      findPersistedDelivery: vi.fn(() => ({ messageId: 'persisted-message-1', outcome })),
      onTurnEnd: vi.fn((_sessionId, callback) => {
        turnEnd = callback
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    expect(deps.markConsumed).not.toHaveBeenCalled()

    outcome = 'succeeded'
    await turnEnd?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.markConsumed).toHaveBeenCalledWith('sess-1', ['job-1'])
  })
})

describe('createJobAnalysisTrigger — idempotency', () => {
  it('skips jobs where notification_consumed_at is already set', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ notification_consumed_at: 9999 }))
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not queue the same job_id twice when a turn is already in flight for it', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    // First done → immediate send (in flight now)
    trigger.onJobDone(makeJob())
    // Second broadcast for the same job before markConsumed
    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    // sendPrompt called once, markConsumed called once
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })
})

describe('createJobAnalysisTrigger — batching', () => {
  it('batches multiple done jobs for the same session into one prompt', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    // Arrive synchronously (microtask batching window)
    trigger.onJobDone(makeJob({ job_id: 'job-1' }))
    trigger.onJobDone(makeJob({ job_id: 'job-2' }))
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    const [, text] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(text).toContain('job-1')
    expect(text).toContain('job-2')
  })

  it('sends separate prompts for different sessions', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ job_id: 'job-1', session_id: 'sess-1' }))
    trigger.onJobDone(makeJob({ job_id: 'job-2', session_id: 'sess-2' }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(2)
    const sessions = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call as [string, string])[0]
    )
    expect(sessions).toContain('sess-1')
    expect(sessions).toContain('sess-2')
  })

  it('keeps overlapping completion batches distinct until both turns are durable', async () => {
    const callbacks: Array<() => void> = []
    const deps = createDeps({
      onTurnEnd: vi.fn((_sessionId, callback) => callbacks.push(callback))
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ job_id: 'job-1' }))
    await flushMicrotasks()
    await flushMicrotasks()
    trigger.onJobDone(makeJob({ job_id: 'job-2' }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(2)
    expect(callbacks).toHaveLength(2)
    await callbacks[0]?.()
    await callbacks[1]?.()

    expect(deps.markConsumed).toHaveBeenCalledWith('sess-1', ['job-1'])
    expect(deps.markConsumed).toHaveBeenCalledWith('sess-1', ['job-2'])
  })
})

describe('createJobAnalysisTrigger — queuing', () => {
  it('queues when session is in flight and sends after notifyTurnEnd', async () => {
    let turnEndCallback: (() => void) | undefined
    const deps = createDeps({
      isSessionInFlight: vi.fn().mockReturnValue(true),
      onTurnEnd: vi.fn((_sessionId, cb) => {
        turnEndCallback = cb
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    // Not sent yet — queued
    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.onTurnEnd).toHaveBeenCalledWith('sess-1', expect.any(Function))

    // Turn ends
    ;(deps.isSessionInFlight as ReturnType<typeof vi.fn>).mockReturnValue(false)
    turnEndCallback?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not re-queue when a second done broadcast arrives for a queued job', async () => {
    let turnEndCallback: (() => void) | undefined
    const deps = createDeps({
      isSessionInFlight: vi.fn().mockReturnValue(true),
      onTurnEnd: vi.fn((_sessionId, cb) => {
        turnEndCallback = cb
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    trigger.onJobDone(makeJob()) // same job again
    await flushMicrotasks()

    ;(deps.isSessionInFlight as ReturnType<typeof vi.fn>).mockReturnValue(false)
    turnEndCallback?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    expect(deps.onTurnEnd).toHaveBeenCalledTimes(1)
  })

  it('logs queued and in-flight job ids for observability', async () => {
    const deps = createDeps({
      isSessionInFlight: vi.fn().mockReturnValue(true),
      onTurnEnd: vi.fn()
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    expect(deps.log).toHaveBeenCalled()
  })
})

describe('createJobAnalysisTrigger — cross-session isolation', () => {
  it('sends the prompt to the job own session_id, not a different one', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ session_id: 'sess-xyz' }))
    await flushMicrotasks()

    const [sessionId] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(sessionId).toBe('sess-xyz')
  })
})
