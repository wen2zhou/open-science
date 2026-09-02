import { describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../shared/compute'
import { ComputeJobResultDeliveryAdapter } from './compute-adapter'

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'host-1',
  display_name: 'Cluster One',
  shape: 'cpu',
  session_id: 'session-1',
  project_id: 'project-1',
  status: 'running',
  intent: 'Fit the model',
  created_at: 1,
  started_at: 2,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/remote/job-1',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})

const harness = () => {
  const repository = {
    registerComputeJob: vi.fn(async () => ({ id: 'compute-job:job-1' })),
    hasComputeJobDeliveryPath: vi.fn(async () => true),
    listWaitingComputeJobIds: vi.fn<() => Promise<string[]>>(async () => [])
  }
  const enqueue = vi.fn(async () => undefined)
  return {
    adapter: new ComputeJobResultDeliveryAdapter({ repository, enqueue }),
    repository,
    enqueue
  }
}

describe('ComputeJobResultDeliveryAdapter', () => {
  it('takes over existing nonterminal Jobs without registering old terminal history', async () => {
    const { adapter, repository } = harness()

    await adapter.takeOver([job(), job({ job_id: 'old-job', status: 'success' })])

    expect(repository.registerComputeJob).toHaveBeenCalledOnce()
    expect(repository.registerComputeJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      providerId: 'host-1',
      displayName: 'Cluster One'
    })
  })

  it('maps a harvested terminal outcome with its remote Host and result semantics', async () => {
    const { adapter, enqueue } = harness()
    await adapter.observeJob(job())

    await adapter.observeNotification(
      job({
        status: 'success',
        finished_at: 10,
        exit_code: 0,
        notified_at: 11,
        stdout_tail: 'model fitted',
        featured_files: ['hpc/job-1/featured/model.csv'],
        left_on_remote: [{ uri: 'ssh://host/tmp/raw.bin', size_mb: 20, reason: 'too-large' }]
      })
    )

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'compute-job',
        jobId: 'job-1',
        executionType: 'compute-job',
        terminalStatus: 'success',
        projectId: 'project-1',
        sessionId: 'session-1',
        computeHost: { providerId: 'host-1', displayName: 'Cluster One' },
        remoteWorkdir: '/remote/job-1',
        featuredFiles: ['hpc/job-1/featured/model.csv'],
        leftOnRemote: [{ uri: 'ssh://host/tmp/raw.bin', size_mb: 20, reason: 'too-large' }],
        resultSummary: expect.stringMatching(/model fitted[\s\S]*model\.csv/u)
      })
    )
  })

  it('waits for the owner notification claim and maps confirmed cancellation as terminal', async () => {
    const { adapter, enqueue } = harness()

    await adapter.observeNotification(job({ status: 'success' }))
    await adapter.observeNotification(
      job({ status: 'failed', cancellation_status: 'cancelled', notified_at: 12 })
    )

    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ terminalStatus: 'cancelled' }))
  })

  it('serializes a fast terminal notification behind durable nonterminal registration', async () => {
    let finishRegistration!: () => void
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve
    })
    const repository = {
      registerComputeJob: vi.fn(() => registration),
      hasComputeJobDeliveryPath: vi.fn(async () => true),
      listWaitingComputeJobIds: vi.fn<() => Promise<string[]>>(async () => [])
    }
    const enqueue = vi.fn(async () => undefined)
    const adapter = new ComputeJobResultDeliveryAdapter({ repository, enqueue })

    const waiting = adapter.observeJob(job())
    const terminal = adapter.observeNotification(job({ status: 'error', notified_at: 5 }))
    await Promise.resolve()
    expect(enqueue).not.toHaveBeenCalled()

    finishRegistration()
    await Promise.all([waiting, terminal])
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('recovers only durable waiting-path Jobs after an app restart', async () => {
    const { adapter, repository, enqueue } = harness()
    repository.listWaitingComputeJobIds.mockResolvedValue(['job-1'])

    await adapter.recoverWaiting(async (jobId) =>
      job({ job_id: jobId, status: 'success', notified_at: 20 })
    )

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }))
  })
})
