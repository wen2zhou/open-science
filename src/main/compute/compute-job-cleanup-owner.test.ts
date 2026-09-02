import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { ComputeJobCleanupOwner } from './compute-job-cleanup-owner'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'

const scope = { projectId: 'project', sessionId: 'session', providerId: 'ssh:cluster' }
const workdir = '/scratch/.openscience/jobs/job-1'
const job = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:cluster',
  shape: 'direct_ssh',
  session_id: 'session',
  project_id: 'project',
  status: 'success',
  intent: 'test',
  command: 'true',
  command_hash: 'hash',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 60,
  remote_workdir: workdir,
  remote_handle: JSON.stringify({
    pid: 42,
    workdir,
    exit_code_path: `${workdir}/exit_code`,
    stdout_path: `${workdir}/stdout`,
    stderr_path: `${workdir}/stderr`
  }),
  owner_marker: '1234567890abcdef',
  remote_object_evidence: [],
  exit_code: 0,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: 1,
  submitted_at: 1,
  started_at: 2,
  finished_at: 3,
  harvested_at: 4,
  ...overrides
})

const harness = (
  currentJob: ComputeJob,
  remoteOutput = 'OSCLEANUP1|VERIFIED|2|0|0|1'
): {
  owner: ComputeJobCleanupOwner
  acquire: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  requestCleanup: ReturnType<typeof vi.fn>
  settleCleanup: ReturnType<typeof vi.fn>
  getOperation: ReturnType<typeof vi.fn>
  findIndeterminateCleanup: ReturnType<typeof vi.fn>
} => {
  const operation = {
    id: 'operation',
    jobId: 'job-1',
    kind: 'cleanup',
    phase: 'active',
    outcome: null,
    revision: 1,
    attemptCount: 0,
    eligibleAt: null,
    claimToken: null,
    claimExpiresAt: null,
    createdAt: new Date(0),
    settledAt: null,
    updatedAt: new Date(0),
    requestId: 'invocation',
    receipt: null
  } as const
  const requestCleanup = vi.fn(async () => ({ found: true as const, record: operation }))
  const settleCleanup = vi.fn(async () => true)
  const getOperation = vi.fn(async () => operation)
  const findIndeterminateCleanup = vi.fn(async () => [])
  const operations = {
    requestCleanup,
    claimCleanup: vi.fn(async (requested) => ({
      operation: { ...requested, revision: requested.revision + 1, claimToken: 'claim' },
      jobId: requested.jobId
    })),
    get: getOperation,
    findActiveReferences: vi.fn(async () => []),
    findIndeterminateCleanup,
    settleCleanup
  } as unknown as ComputeJobOperationRepository
  const jobs = {
    get: vi.fn(async () => currentJob),
    admitCleanup: vi.fn(async (_projectId, _sessionId, action) => ({
      result: await action(),
      release: vi.fn()
    }))
  } as unknown as Pick<ComputeJobRepository, 'get' | 'admitCleanup'>
  const hosts = {
    get: vi.fn(async () => ({
      scratchRoot: currentJob.remote_workdir?.startsWith('~/') ? undefined : '/scratch'
    }))
  } as unknown as Pick<ComputeHostRepository, 'get'>
  const run = vi.fn(async () => ({
    stdout: remoteOutput,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false
  }))
  const acquire = vi.fn(async () => ({ run }))
  const broker = { acquire } as unknown as ComputeConnectionBrokerAcquirer
  return {
    owner: new ComputeJobCleanupOwner(operations, jobs, hosts, broker),
    acquire,
    run,
    requestCleanup,
    settleCleanup,
    getOperation,
    findIndeterminateCleanup
  }
}

describe('ComputeJobCleanupOwner', () => {
  it('returns a settled workspace-removed receipt from the bounded remote seam', async () => {
    const test = harness(job())

    await expect(test.owner.cleanup('job-1', scope, 'invocation')).resolves.toMatchObject({
      job_id: 'job-1',
      outcome: 'workspace_removed',
      workspace_removed: true,
      deleted_object_count: 2,
      retry_recommended: false
    })
    expect(test.settleCleanup).toHaveBeenCalledOnce()
  })

  it('does not admit or contact SSH for a damaged persisted workdir', async () => {
    const test = harness(job({ remote_workdir: '/tmp/not-owned' }))

    await expect(test.owner.cleanup('job-1', scope, 'invocation')).resolves.toMatchObject({
      outcome: 'nothing_deleted',
      deleted_object_count: 0,
      retained_object_counts: { ownership_unproven: 1 },
      retry_conditions: ['manual_review']
    })
    expect(test.requestCleanup).not.toHaveBeenCalled()
    expect(test.acquire).not.toHaveBeenCalled()
  })

  it('maps a still-owned tracked PID to not-ready without deletion', async () => {
    const test = harness(job(), 'OSCLEANUP1|SOURCE_ACTIVE|0|0|0|0')

    await expect(test.owner.cleanup('job-1', scope, 'invocation')).resolves.toMatchObject({
      outcome: 'not_ready',
      retained_object_counts: { source_job_active: 1 },
      retry_conditions: ['job_terminal']
    })
  })

  it('retains a default-scratch left-on-remote URI after tilde round-trip', async () => {
    const tildeWorkdir = '~/.openscience/jobs/job-1'
    const test = harness(
      job({
        remote_workdir: tildeWorkdir,
        remote_handle: JSON.stringify({
          pid: 42,
          workdir: tildeWorkdir,
          exit_code_path: `${tildeWorkdir}/exit_code`,
          stdout_path: `${tildeWorkdir}/stdout`,
          stderr_path: `${tildeWorkdir}/stderr`
        }),
        left_on_remote: JSON.stringify([
          { uri: 'ssh://cluster/~/.openscience/jobs/job-1/result.csv' }
        ])
      }),
      'OSCLEANUP1|VERIFIED|0|0|0|0'
    )

    await expect(test.owner.cleanup('job-1', scope, 'invocation')).resolves.toMatchObject({
      retained_object_counts: { only_remote_copy: 1 }
    })
    expect(test.run).toHaveBeenCalledWith(expect.stringContaining('result.csv'), expect.any(Object))
  })

  it('joins concurrent replays to one remote attempt and one settled receipt', async () => {
    const test = harness(job())
    let release!: () => void
    test.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              stdout: 'OSCLEANUP1|VERIFIED|2|0|0|1',
              stderr: '',
              exitCode: 0,
              timedOut: false,
              truncated: false
            })
        })
    )

    const first = test.owner.cleanup('job-1', scope, 'invocation-1')
    const replay = test.owner.cleanup('job-1', scope, 'invocation-2')
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledOnce())
    expect(test.requestCleanup).toHaveBeenCalledOnce()
    release()

    const [firstReceipt, replayReceipt] = await Promise.all([first, replay])
    expect(replayReceipt).toEqual(firstReceipt)
    expect(test.settleCleanup).toHaveBeenCalledOnce()
  })

  it('validates trusted scope before joining an in-flight cleanup', async () => {
    const test = harness(job())
    let release!: () => void
    test.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              stdout: 'OSCLEANUP1|VERIFIED|2|0|0|1',
              stderr: '',
              exitCode: 0,
              timedOut: false,
              truncated: false
            })
        })
    )

    const owned = test.owner.cleanup('job-1', scope, 'owned-invocation')
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledOnce())
    const wrongScope = test.owner.cleanup(
      'job-1',
      { ...scope, projectId: 'other-project' },
      'cross-scope-invocation'
    )
    release()

    await expect(owned).resolves.toMatchObject({ outcome: 'workspace_removed' })
    await expect(wrongScope).rejects.toThrow()
    expect(test.requestCleanup).toHaveBeenCalledOnce()
    expect(test.run).toHaveBeenCalledOnce()
  })

  it('does not return a determinate local receipt after losing the settlement claim', async () => {
    const test = harness(job())
    test.settleCleanup.mockResolvedValue(false)
    test.getOperation.mockResolvedValue({
      id: 'operation',
      jobId: 'job-1',
      kind: 'cleanup',
      phase: 'active',
      outcome: null,
      revision: 3,
      attemptCount: 2,
      eligibleAt: null,
      claimToken: 'new-owner',
      claimExpiresAt: new Date(60_000),
      createdAt: new Date(0),
      settledAt: null,
      updatedAt: new Date(30_000),
      requestId: 'new-invocation',
      receipt: null
    })

    await expect(test.owner.cleanup('job-1', scope, 'stale-invocation')).resolves.toMatchObject({
      outcome: 'indeterminate',
      workspace_removed: false,
      retained_object_counts: { remote_state_uncertain: 1 },
      retained_object_count_unknown: true,
      retry_recommended: true
    })
  })

  it('returns the authoritative settled receipt after a lease takeover wins settlement', async () => {
    const test = harness(job())
    const authoritativeReceipt = {
      job_id: 'job-1',
      outcome: 'nothing_deleted' as const,
      workspace_removed: false,
      deleted_object_count: 0,
      retained_object_counts: { active_downstream_reference: 1 },
      retained_object_count_unknown: false,
      retry_recommended: true,
      retry_conditions: ['downstream_terminal' as const],
      disposition: 'A newer lease retained an active downstream reference.'
    }
    test.settleCleanup.mockResolvedValue(false)
    test.getOperation.mockResolvedValue({
      id: 'operation',
      jobId: 'job-1',
      kind: 'cleanup',
      phase: 'settled',
      outcome: 'fulfilled',
      revision: 4,
      attemptCount: 2,
      eligibleAt: null,
      claimToken: null,
      claimExpiresAt: null,
      createdAt: new Date(0),
      settledAt: new Date(45_000),
      updatedAt: new Date(45_000),
      requestId: 'new-invocation',
      receipt: authoritativeReceipt
    })

    await expect(test.owner.cleanup('job-1', scope, 'stale-invocation')).resolves.toEqual(
      authoritativeReceipt
    )
  })

  it('settles a queued-stage cancellation without harvest or SSH', async () => {
    const test = harness(
      job({
        status: 'failed',
        cancellation_status: 'cancelled',
        submitted_at: undefined,
        started_at: undefined,
        remote_handle: undefined,
        harvested_at: undefined
      })
    )

    await expect(test.owner.cleanup('job-1', scope, 'queued-cancel')).resolves.toMatchObject({
      outcome: 'nothing_deleted',
      workspace_removed: false,
      deleted_object_count: 0,
      retained_object_counts: {},
      retained_object_count_unknown: false,
      retry_recommended: false,
      retry_conditions: []
    })
    expect(test.requestCleanup).toHaveBeenCalledOnce()
    expect(test.settleCleanup).toHaveBeenCalledOnce()
    expect(test.acquire).not.toHaveBeenCalled()
    expect(test.run).not.toHaveBeenCalled()
  })

  it('startup recovery only checks absence and settles a confirmed missing workspace', async () => {
    const test = harness(job(), 'OSCLEANUP1|WORKSPACE_ABSENT')
    const uncertain = {
      job_id: 'job-1',
      outcome: 'indeterminate' as const,
      workspace_removed: false,
      deleted_object_count: 0,
      retained_object_counts: { remote_state_uncertain: 1 },
      retained_object_count_unknown: true,
      retry_recommended: true,
      retry_conditions: ['host_reachable' as const],
      disposition: 'Retry.'
    }
    test.findIndeterminateCleanup.mockResolvedValue([
      {
        id: 'operation',
        jobId: 'job-1',
        kind: 'cleanup',
        phase: 'active',
        outcome: null,
        revision: 3,
        attemptCount: 1,
        eligibleAt: null,
        claimToken: null,
        claimExpiresAt: null,
        createdAt: new Date(0),
        settledAt: null,
        updatedAt: new Date(0),
        requestId: 'invocation',
        receipt: uncertain
      }
    ])

    await test.owner.recoverIndeterminate()

    expect(test.settleCleanup).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outcome: 'workspace_removed', workspace_removed: true }),
      expect.any(Date)
    )
    const command = test.run.mock.calls[0][0] as string
    expect(command).not.toMatch(/\brm\b|\bfind\b/)
  })
})
