import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ComputeHostUnavailableError } from '../../shared/compute'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import type { ComputeConnectionBrokerAcquirer, ComputeConnectionLease } from './connection-broker'
import {
  ComputeJobCancellationOwner,
  ComputeJobCancellationReaper
} from './compute-job-cancellation-owner'
import { ComputeJobCancellationRepository } from './compute-job-cancellation-repository'
import { ComputeJobRepository } from './job-repository'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const scope = {
  projectId: 'project-1',
  sessionId: 'session-1',
  providerId: 'ssh:test'
} as const

const remoteHandle = JSON.stringify({
  pid: 4321,
  workdir: '~/.openscience/jobs/job-1',
  exit_code_path: '~/.openscience/jobs/job-1/exit_code',
  stdout_path: '~/.openscience/jobs/job-1/stdout',
  stderr_path: '~/.openscience/jobs/job-1/stderr'
})

const success = (stdout: string): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  exitCode: 0,
  stdout,
  stderr: '',
  truncated: false,
  timedOut: false
})

describe('Compute Job cancellation owner (SQLite + fake SSH)', () => {
  const setup = async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-cancellation-owner-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const jobs = new ComputeJobRepository(() => Promise.resolve(client))
    const cancellations = new ComputeJobCancellationRepository(() => Promise.resolve(client))
    const createJob = async (
      status: 'queued' | 'submitted' | 'running' | 'success',
      handle = status === 'running' ? remoteHandle : undefined
    ) => {
      await jobs.create({
        id: 'job-1',
        providerId: scope.providerId,
        shape: 'direct_ssh',
        sessionId: scope.sessionId,
        projectId: scope.projectId,
        intent: 'long calculation',
        command: 'sleep 100',
        commandHash: 'hash',
        remoteWorkdir: '~/.openscience/jobs/job-1',
        initialStatus: status
      })
      if (handle) await jobs.update('job-1', { remoteHandle: handle })
    }
    return { client, jobs, cancellations, createJob }
  }

  it('confirms queued cancellation transactionally without opening SSH', async () => {
    const { jobs, cancellations, createJob } = await setup()
    await createJob('queued')
    const acquire = vi.fn()
    const owner = new ComputeJobCancellationOwner(cancellations, jobs)

    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      job_id: 'job-1',
      status: 'failed',
      cancellation_status: 'cancelled'
    })
    const reaper = new ComputeJobCancellationReaper(cancellations, {
      acquire
    } as unknown as ComputeConnectionBrokerAcquirer)
    await reaper.runOnce()

    expect(acquire).not.toHaveBeenCalled()
    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelled'
    })
  })

  it.each(['owned', 'mismatch', 'absent'] as const)(
    'confirms a running cancellation when process evidence is %s',
    async (evidence) => {
      const { jobs, cancellations, createJob } = await setup()
      await createJob('running')
      const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValueOnce(success(evidence))
      if (evidence === 'owned') run.mockResolvedValueOnce(success('terminated'))
      const broker: ComputeConnectionBrokerAcquirer = {
        acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
      }
      const owner = new ComputeJobCancellationOwner(cancellations, jobs)
      const onConfirmed = vi.fn()
      const reaper = new ComputeJobCancellationReaper(cancellations, broker, { onConfirmed })

      await expect(owner.request('job-1', scope)).resolves.toMatchObject({
        status: 'running',
        cancellation_status: 'cancelling'
      })
      expect(onConfirmed).not.toHaveBeenCalled()
      await reaper.runOnce()

      await expect(owner.status('job-1', scope)).resolves.toMatchObject({
        status: 'failed',
        cancellation_status: 'cancelled'
      })
      expect(run).toHaveBeenCalledTimes(evidence === 'owned' ? 2 : 1)
      expect(onConfirmed).toHaveBeenCalledWith('job-1')
    }
  )

  it('retries unknown, timeout, truncated, and nonzero evidence and never confirms it', async () => {
    const { jobs, cancellations, createJob } = await setup()
    await createJob('running')
    const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue({
      exitCode: 1,
      stdout: 'owned',
      stderr: 'transport failed',
      truncated: true,
      timedOut: true
    })
    const owner = new ComputeJobCancellationOwner(cancellations, jobs)
    const reaper = new ComputeJobCancellationReaper(cancellations, {
      acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease)
    })

    await owner.request('job-1', scope)
    await reaper.runOnce()

    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelling'
    })
    await expect(cancellations.get('job-1')).resolves.toMatchObject({
      state: 'retry_wait',
      attempt: 1,
      lastError: expect.any(String)
    })
  })

  it('supersedes cancellation when the job was terminal first', async () => {
    const { jobs, cancellations, createJob } = await setup()
    await createJob('success')
    const owner = new ComputeJobCancellationOwner(cancellations, jobs)

    await expect(owner.request('job-1', scope)).resolves.toMatchObject({
      status: 'success',
      cancellation_status: undefined
    })
    await expect(cancellations.get('job-1')).resolves.toMatchObject({ state: 'superseded' })
  })

  it('recovers an expired claim after restart', async () => {
    const { jobs, cancellations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(cancellations, jobs)
    await owner.request('job-1', scope)
    await cancellations.claimNext(new Date('2026-01-01T00:00:00.000Z'), 1_000, 'dead-owner')
    const run = vi.fn<ComputeConnectionLease['run']>().mockResolvedValue(success('absent'))
    const restarted = new ComputeJobCancellationReaper(
      cancellations,
      { acquire: vi.fn(async () => ({ run }) as unknown as ComputeConnectionLease) },
      { now: () => new Date('2026-01-01T00:00:02.000Z') }
    )

    await restarted.runOnce()

    await expect(owner.status('job-1', scope)).resolves.toMatchObject({
      cancellation_status: 'cancelled'
    })
  })

  it('linearizes request against a terminal poll CAS', async () => {
    const { jobs, cancellations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(cancellations, jobs)

    const [requested, polled] = await Promise.all([
      owner.request('job-1', scope),
      jobs.updateIfStatus('job-1', ['running'], {
        status: 'success',
        finishedAt: new Date()
      })
    ])
    const cancellation = await cancellations.get('job-1')

    expect(
      (requested.cancellation_status === 'cancelling' && polled === null) ||
        (requested.status === 'success' && cancellation?.state === 'superseded')
    ).toBe(true)
  })

  it('uses the same unavailable error for missing and mismatched owner tuples', async () => {
    const { jobs, cancellations, createJob } = await setup()
    await createJob('running')
    const owner = new ComputeJobCancellationOwner(cancellations, jobs)

    await expect(owner.request('missing', scope)).rejects.toBeInstanceOf(
      ComputeHostUnavailableError
    )
    await expect(
      owner.request('job-1', { ...scope, projectId: 'other-project' })
    ).rejects.toBeInstanceOf(ComputeHostUnavailableError)
  })
})
