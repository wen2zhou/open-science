import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import type { ComputeConnectionLease } from './connection-broker'
import {
  runRemoteComputeJobCleanup,
  verifyRemoteComputeJobWorkspaceAbsent,
  type RemoteComputeJobCleanupCandidate,
  type RemoteComputeJobCleanupRequest
} from './compute-job-cleanup-remote'

const execFileAsync = promisify(execFile)
const pit = it.skipIf(process.platform === 'win32')
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const localLease = (home: string, path = process.env.PATH): ComputeConnectionLease =>
  ({
    run: async (command: string, options: Parameters<ComputeConnectionLease['run']>[1]) => {
      try {
        const result = await execFileAsync('sh', ['-c', command], {
          cwd: home,
          env: { ...process.env, HOME: home, PATH: path },
          timeout: options.timeoutMs,
          maxBuffer: options.maxOutputBytes
        })
        return {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: false,
          timedOut: false
        }
      } catch (error) {
        const failure = error as {
          code?: number | string
          stdout?: string
          stderr?: string
          killed?: boolean
        }
        return {
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
          truncated: false,
          timedOut: failure.killed === true
        }
      }
    }
  }) as unknown as ComputeConnectionLease

const candidate = async (
  workdir: string,
  path: string
): Promise<RemoteComputeJobCleanupCandidate> => {
  const stat = await lstat(join(workdir, path), { bigint: true })
  if (stat.isSymbolicLink()) {
    return {
      path,
      identity: {
        kind: 'symlink',
        link_target: await readFile(join(workdir, path), 'utf8').catch(() => '')
      }
    }
  }
  return {
    path,
    identity: {
      kind: 'file',
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size_bytes: Number(stat.size),
      modified_at_ns: stat.mtimeNs.toString()
    }
  }
}

const fixture = async (): Promise<{
  root: string
  workdir: string
  marker: string
  request: Omit<RemoteComputeJobCleanupRequest, 'candidates' | 'knownRetainedPaths'>
}> => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'open-science-cleanup-'))
  fixtures.push(createdRoot)
  const root = await realpath(createdRoot)
  const scratchRoot = join(root, 'scratch')
  const workdir = join(scratchRoot, '.openscience', 'jobs', 'job-1')
  const marker = 'owner-token-1234567890'
  await mkdir(workdir, { recursive: true })
  await writeFile(join(workdir, '.openscience-owner'), marker)
  return { root, workdir, marker, request: { scratchRoot, workdir, ownerMarker: marker } }
}

describe('remote Compute Job cleanup shell contract', () => {
  pit('does not confirm an absent workspace through a replaced jobs ancestor', async () => {
    const test = await fixture()
    const realJobs = join(test.root, 'replacement-jobs')
    await mkdir(realJobs)
    await rm(join(test.request.scratchRoot, '.openscience', 'jobs'), { recursive: true })
    await symlink(realJobs, join(test.request.scratchRoot, '.openscience', 'jobs'))

    await expect(
      verifyRemoteComputeJobWorkspaceAbsent(localLease(test.root), {
        scratchRoot: test.request.scratchRoot,
        workdir: test.request.workdir
      })
    ).rejects.toThrow('could not be confirmed')
  })

  pit(
    'removes all identity-matching objects, symlink itself, empty directories, marker, and root',
    async () => {
      const test = await fixture()
      await mkdir(join(test.workdir, 'nested'))
      await writeFile(join(test.workdir, 'nested', 'output.txt'), 'published')
      await writeFile(join(test.root, 'outside.txt'), 'outside')
      await symlink(join(test.root, 'outside.txt'), join(test.workdir, 'input-link'))
      const output = await candidate(test.workdir, 'nested/output.txt')
      const linkStat = await lstat(join(test.workdir, 'input-link'), { bigint: true })
      const link: RemoteComputeJobCleanupCandidate = {
        path: 'input-link',
        identity: {
          kind: 'symlink',
          device: linkStat.dev.toString(),
          inode: linkStat.ino.toString(),
          link_target: join(test.root, 'outside.txt')
        }
      }

      const result = await runRemoteComputeJobCleanup(localLease(test.root), {
        ...test.request,
        candidates: [output, link],
        knownRetainedPaths: []
      })

      expect(result).toMatchObject({ verification: 'verified', workspaceRemoved: true })
      expect(result.deletedObjectCount).toBe(3)
      await expect(readFile(join(test.root, 'outside.txt'), 'utf8')).resolves.toBe('outside')
      await expect(lstat(test.workdir)).rejects.toThrow()
    }
  )

  pit.each(['missing', 'mismatch'] as const)(
    'performs zero deletion for a %s owner marker',
    async (kind) => {
      const test = await fixture()
      await writeFile(join(test.workdir, 'safe.txt'), 'safe')
      const safe = await candidate(test.workdir, 'safe.txt')
      if (kind === 'missing') await rm(join(test.workdir, '.openscience-owner'))
      else await writeFile(join(test.workdir, '.openscience-owner'), 'different-owner-token')

      const result = await runRemoteComputeJobCleanup(localLease(test.root), {
        ...test.request,
        candidates: [safe],
        knownRetainedPaths: []
      })

      expect(result.verification).toBe('ownership_unproven')
      await expect(readFile(join(test.workdir, 'safe.txt'), 'utf8')).resolves.toBe('safe')
    }
  )

  pit('performs zero deletion when a workspace ancestor is a symlink', async () => {
    const test = await fixture()
    await writeFile(join(test.workdir, 'safe.txt'), 'safe')
    const safe = await candidate(test.workdir, 'safe.txt')
    const realJobs = join(test.root, 'real-jobs')
    await mkdir(realJobs)
    await rm(join(test.request.scratchRoot, '.openscience', 'jobs'), { recursive: true })
    await symlink(realJobs, join(test.request.scratchRoot, '.openscience', 'jobs'))
    await mkdir(join(realJobs, 'job-1'))
    await writeFile(join(realJobs, 'job-1', '.openscience-owner'), test.marker)
    await writeFile(join(realJobs, 'job-1', 'safe.txt'), 'replacement')

    const result = await runRemoteComputeJobCleanup(localLease(test.root), {
      ...test.request,
      candidates: [safe],
      knownRetainedPaths: []
    })

    expect(result.verification).toBe('ownership_unproven')
    await expect(readFile(join(realJobs, 'job-1', 'safe.txt'), 'utf8')).resolves.toBe('replacement')
  })

  pit(
    'retains identity and type changes plus unknown files while deleting an independent safe candidate',
    async () => {
      const test = await fixture()
      await mkdir(join(test.workdir, 'nested'))
      await writeFile(join(test.workdir, 'safe.txt'), 'safe')
      await writeFile(join(test.workdir, 'nested', 'changed.txt'), 'before')
      await writeFile(join(test.workdir, 'changed-type.txt'), 'regular')
      const safe = await candidate(test.workdir, 'safe.txt')
      const changed = await candidate(test.workdir, 'nested/changed.txt')
      const changedType = await candidate(test.workdir, 'changed-type.txt')
      await writeFile(join(test.workdir, 'nested', 'changed.txt'), 'different-size')
      await rm(join(test.workdir, 'changed-type.txt'))
      await symlink(join(test.root, 'outside-target'), join(test.workdir, 'changed-type.txt'))
      await writeFile(join(test.workdir, 'unknown.txt'), 'unknown')

      const result = await runRemoteComputeJobCleanup(localLease(test.root), {
        ...test.request,
        candidates: [safe, changed, changedType],
        knownRetainedPaths: []
      })

      expect(result).toEqual({
        verification: 'verified',
        workspaceRemoved: false,
        deletedObjectCount: 1,
        mismatchedCandidateCount: 2,
        unknownObjectCount: 1
      })
      await expect(readFile(join(test.workdir, 'nested', 'changed.txt'), 'utf8')).resolves.toBe(
        'different-size'
      )
      await expect(readFile(join(test.workdir, 'unknown.txt'), 'utf8')).resolves.toBe('unknown')
    }
  )

  pit('does not count backend-known retained paths as unknown', async () => {
    const test = await fixture()
    await mkdir(dirname(join(test.workdir, 'retained', 'output.txt')), { recursive: true })
    await writeFile(join(test.workdir, 'retained', 'output.txt'), 'remote-only')

    const result = await runRemoteComputeJobCleanup(localLease(test.root), {
      ...test.request,
      candidates: [],
      knownRetainedPaths: ['retained/output.txt']
    })

    expect(result).toMatchObject({ mismatchedCandidateCount: 0, unknownObjectCount: 0 })
  })

  pit(
    'expands a backend-owned tilde workdir before validating and deleting candidates',
    async () => {
      const test = await fixture()
      const tildeScratch = join(test.root, '.scratch')
      const tildeWorkdir = join(tildeScratch, '.openscience', 'jobs', 'job-tilde')
      await mkdir(tildeWorkdir, { recursive: true })
      await writeFile(join(tildeWorkdir, '.openscience-owner'), test.marker)
      await writeFile(join(tildeWorkdir, 'safe.txt'), 'safe')
      const safe = await candidate(tildeWorkdir, 'safe.txt')

      const result = await runRemoteComputeJobCleanup(localLease(test.root), {
        scratchRoot: '~/.scratch',
        workdir: '~/.scratch/.openscience/jobs/job-tilde',
        ownerMarker: test.marker,
        candidates: [safe],
        knownRetainedPaths: []
      })

      expect(result).toMatchObject({ verification: 'verified', workspaceRemoved: true })
    }
  )

  pit('restores the exact owner marker if a new object makes final rmdir fail', async () => {
    const test = await fixture()
    const bin = join(test.root, 'bin')
    await mkdir(bin)
    await writeFile(
      join(bin, 'rmdir'),
      '#!/bin/sh\n: > "$1/raced-object"\nexec /bin/rmdir "$@"\n',
      { mode: 0o755 }
    )

    await expect(
      runRemoteComputeJobCleanup(localLease(test.root, `${bin}:${process.env.PATH ?? ''}`), {
        ...test.request,
        candidates: [],
        knownRetainedPaths: []
      })
    ).rejects.toThrow('could not be confirmed')
    await expect(readFile(join(test.workdir, '.openscience-owner'), 'utf8')).resolves.toBe(
      test.marker
    )
    await expect(readFile(join(test.workdir, 'raced-object'), 'utf8')).resolves.toBe('')
  })

  pit('performs zero deletion while the tracked process still owns the workdir', async () => {
    const test = await fixture()
    await writeFile(join(test.workdir, 'safe.txt'), 'safe')
    const safe = await candidate(test.workdir, 'safe.txt')
    const process = spawn('sleep', ['30'], { cwd: test.workdir, stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        process.once('spawn', resolve)
        process.once('error', reject)
      })
      const result = await runRemoteComputeJobCleanup(localLease(test.root), {
        ...test.request,
        trackedPid: process.pid,
        candidates: [safe],
        knownRetainedPaths: []
      })

      expect(result.verification).toBe('source_active')
      expect(result.deletedObjectCount).toBe(0)
      await expect(readFile(join(test.workdir, 'safe.txt'), 'utf8')).resolves.toBe('safe')
    } finally {
      process.kill('SIGKILL')
    }
  })
})
