import { describe, expect, it, vi } from 'vitest'

import type { ComputeConnectionLease } from './connection-broker'
import {
  RemoteComputeJobCleanupIndeterminateError,
  runRemoteComputeJobCleanup,
  verifyRemoteComputeJobWorkspaceAbsent
} from './compute-job-cleanup-remote'

const request = {
  scratchRoot: '/scratch',
  workdir: '/scratch/.openscience/jobs/job-1',
  ownerMarker: 'owner-token-1234567890',
  candidates: [],
  knownRetainedPaths: []
}

const lease = (
  result: Partial<Awaited<ReturnType<ComputeConnectionLease['run']>>> = {}
): ComputeConnectionLease =>
  ({
    run: vi.fn(async () => ({
      exitCode: 0,
      stdout: 'OSCLEANUP1|VERIFIED|2|1|3|0\n',
      stderr: '',
      truncated: false,
      timedOut: false,
      ...result
    }))
  }) as unknown as ComputeConnectionLease

describe('runRemoteComputeJobCleanup', () => {
  it('returns the verified remote summary and uses one bounded connection run', async () => {
    const connection = lease()

    await expect(runRemoteComputeJobCleanup(connection, request)).resolves.toEqual({
      verification: 'verified',
      workspaceRemoved: false,
      deletedObjectCount: 2,
      mismatchedCandidateCount: 1,
      unknownObjectCount: 3
    })
    expect(connection.run).toHaveBeenCalledOnce()
    expect(connection.run).toHaveBeenCalledWith(expect.any(String), {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 1024
    })
  })

  it('accepts the default tilde scratch boundary without treating it as an empty path segment', async () => {
    await expect(
      runRemoteComputeJobCleanup(lease(), {
        ...request,
        scratchRoot: '~',
        workdir: '~/.openscience/jobs/job-1',
        knownRetainedPaths: ['result.csv']
      })
    ).resolves.toMatchObject({ verification: 'verified' })
  })

  it('returns ownership-unproven without claiming deletion', async () => {
    await expect(
      runRemoteComputeJobCleanup(
        lease({ stdout: 'OSCLEANUP1|OWNERSHIP_UNPROVEN|0|0|0|0\n' }),
        request
      )
    ).resolves.toEqual({
      verification: 'ownership_unproven',
      workspaceRemoved: false,
      deletedObjectCount: 0,
      mismatchedCandidateCount: 0,
      unknownObjectCount: 0
    })
  })

  it('returns a distinct source-active verification without claiming deletion', async () => {
    await expect(
      runRemoteComputeJobCleanup(lease({ stdout: 'OSCLEANUP1|SOURCE_ACTIVE|0|0|0|0\n' }), {
        ...request,
        trackedPid: 123
      })
    ).resolves.toEqual({
      verification: 'source_active',
      workspaceRemoved: false,
      deletedObjectCount: 0,
      mismatchedCandidateCount: 0,
      unknownObjectCount: 0
    })
  })

  it.each([
    ['disconnect', { exitCode: 255, stderr: 'offline' }],
    ['timeout', { exitCode: null, timedOut: true }],
    ['truncation', { truncated: true }],
    ['confirmation loss', { stdout: '', exitCode: 0 }]
  ])('classifies %s as indeterminate for the caller', async (_name, result) => {
    await expect(runRemoteComputeJobCleanup(lease(result), request)).rejects.toBeInstanceOf(
      RemoteComputeJobCleanupIndeterminateError
    )
  })

  it('rejects paths that cannot be backend-owned relative candidates before connecting', async () => {
    const connection = lease()
    await expect(
      runRemoteComputeJobCleanup(connection, {
        ...request,
        candidates: [
          {
            path: '../other-job/output',
            identity: {
              kind: 'file',
              device: '1',
              inode: '2',
              size_bytes: 3,
              modified_at_ns: '4000000000'
            }
          }
        ]
      })
    ).rejects.toThrow('Unsafe remote cleanup candidate path')
    expect(connection.run).not.toHaveBeenCalled()
  })
})

describe('verifyRemoteComputeJobWorkspaceAbsent', () => {
  it('performs one bounded existence-only recovery check without inventory or deletion', async () => {
    const connection = lease({ stdout: 'OSCLEANUP1|WORKSPACE_ABSENT\n' })

    await expect(
      verifyRemoteComputeJobWorkspaceAbsent(connection, {
        scratchRoot: '~',
        workdir: '~/.openscience/jobs/job-1'
      })
    ).resolves.toBe(true)
    const command = (connection.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(command).not.toMatch(/\brm\b|\bfind\b/)
    expect(command).toContain('${workdir_input#??}')
    expect(command).toContain('path_no_symlinks "$jobs_parent"')
  })

  it('leaves a present workspace for a later explicit cleanup', async () => {
    await expect(
      verifyRemoteComputeJobWorkspaceAbsent(lease({ stdout: 'OSCLEANUP1|WORKSPACE_PRESENT\n' }), {
        scratchRoot: '/scratch',
        workdir: '/scratch/.openscience/jobs/job-1'
      })
    ).resolves.toBe(false)
  })
})
