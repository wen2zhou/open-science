import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { DirectDriver, DirectDispatchError } from './direct-driver'
import { parseRemoteHandle } from '../../shared/remote-handle'
import type { DriverJob, PollManyResult } from './compute-driver'

// Mock resolveSshTarget at module level so tests bypass the real ssh -G call.
vi.mock('./ssh-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() =>
      Promise.resolve({
        sshBinary: '/usr/bin/ssh',
        host: 'biowulf.nih.gov',
        extraArgs: ['-o', 'BatchMode=yes']
      } as ResolvedSshTarget)
    )
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed nonce injected into the driver under test so fixtures can mirror the marker format it emits.
// Production uses a random per-call nonce (see DirectDriver default).
const NONCE = 'NONCE123_'

// Prefixes structural marker lines with the fixed nonce, mirroring what the driver emits/parses.
const withNonce = (lines: string[]): string =>
  lines
    .map((l) => (/^(JOB_START:|alive:|STDOUT_END:|STDERR_END:)/.test(l) ? NONCE + l : l))
    .join('\n')

const makeSshRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

// A direct-v1 handle string (what the dispatcher persists for new jobs).
const directV1Handle = (jobId: string, pid = 1234): string =>
  JSON.stringify({
    version: 1,
    driver: 'direct',
    pid,
    pgid: pid,
    paths: {
      workdir: `~/.openscience/jobs/${jobId}`,
      stdout: `~/.openscience/jobs/${jobId}/stdout`,
      stderr: `~/.openscience/jobs/${jobId}/stderr`,
      exitCode: `~/.openscience/jobs/${jobId}/exit_code`
    }
  })

// A legacy unversioned PID handle (what pre-refactor rows store). Must poll identically to v1.
const legacyHandle = (jobId: string, pid = 1234): string =>
  JSON.stringify({
    pid,
    exit_code_path: `~/.openscience/jobs/${jobId}/exit_code`,
    stdout_path: `~/.openscience/jobs/${jobId}/stdout`,
    stderr_path: `~/.openscience/jobs/${jobId}/stderr`,
    workdir: `~/.openscience/jobs/${jobId}`
  })

const target: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes']
}

const driverJob = (jobId: string, handleRaw: string): DriverJob => {
  const handle = parseRemoteHandle(handleRaw)!
  return { jobId, handle }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('DirectDriver.dispatch', () => {
  it('launches detached and returns a versioned direct handle with pid', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '12345\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner })

    const handle = await driver.dispatch({
      target,
      workdir: '~/.openscience/jobs/job-1',
      command: 'echo hello',
      timeoutSeconds: 3600,
      jobId: 'job-1',
      resources: {}
    })

    expect(handle).toMatchObject({ version: 1, driver: 'direct', pid: 12345 })
    expect(handle.paths).toEqual({
      workdir: '~/.openscience/jobs/job-1',
      stdout: '~/.openscience/jobs/job-1/stdout',
      stderr: '~/.openscience/jobs/job-1/stderr',
      exitCode: '~/.openscience/jobs/job-1/exit_code'
    })

    // The dispatch SSH command must nohup + setsid the detached launcher and echo the pid.
    const cmd = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    expect(cmd).toContain('nohup setsid bash launcher.sh')
    expect(cmd).toContain('echo $LAUNCHED_PID')
  })

  it('does not double-quote a leading ~ in the dispatch command (tilde must expand)', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '1\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner })

    await driver.dispatch({
      target,
      workdir: '~/.openscience/jobs/job-1',
      command: 'echo hi',
      timeoutSeconds: 3600,
      jobId: 'job-1',
      resources: {}
    })

    const cmd = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    // The tilde must remain unquoted so bash expands it to $HOME.
    expect(cmd).toMatch(/mkdir -p ~\/'\.openscience\/jobs\/job-1'/)
  })

  it('throws host_unreachable on SSH exit 255', async () => {
    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'connection refused',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner })

    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/job-1',
        command: 'echo hi',
        timeoutSeconds: 3600,
        jobId: 'job-1',
        resources: {}
      })
    ).rejects.toMatchObject({ code: 'host_unreachable', detail: 'connection refused' })
  })

  it('throws host_unreachable on SSH timeout', async () => {
    const runner = makeSshRunner({
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true
    })
    const driver = new DirectDriver({ runner })

    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/job-1',
        command: 'echo hi',
        timeoutSeconds: 3600,
        jobId: 'job-1',
        resources: {}
      })
    ).rejects.toMatchObject({ code: 'host_unreachable' })
  })

  it('throws dispatch_failed on a non-connection launch error', async () => {
    const runner = makeSshRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'mkdir failed',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner })

    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/job-1',
        command: 'echo hi',
        timeoutSeconds: 3600,
        jobId: 'job-1',
        resources: {}
      })
    ).rejects.toMatchObject({ code: 'dispatch_failed', detail: 'mkdir failed' })
  })

  it('throws dispatch_failed when pid cannot be parsed', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: 'garbage\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner })

    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/job-1',
        command: 'echo hi',
        timeoutSeconds: 3600,
        jobId: 'job-1',
        resources: {}
      })
    ).rejects.toBeInstanceOf(DirectDispatchError)
  })
})

// ---------------------------------------------------------------------------
// pollMany
// ---------------------------------------------------------------------------

describe('DirectDriver.pollMany', () => {
  it('parses exit_code=0 into a success observation', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:job-1',
        'alive:1',
        '0',
        'hello',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1'
      ]),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1'))
    ])

    expect(result.kind).toBe('ok')
    const obs = (result as Extract<PollManyResult, { kind: 'ok' }>).observations.get('job-1')!
    expect(obs).toMatchObject({ alive: true, exitCode: 0, hasExitCode: true })
  })

  it('parses a non-zero exit code', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:job-1',
        'alive:0',
        '3',
        '',
        'STDOUT_END:job-1',
        'error msg',
        'STDERR_END:job-1'
      ]),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1'))
    ])
    const obs = (result as Extract<PollManyResult, { kind: 'ok' }>).observations.get('job-1')!
    expect(obs).toMatchObject({ alive: false, exitCode: 3, hasExitCode: true })
  })

  it('is not corrupted by job stdout that contains bare marker lines', async () => {
    // A job whose stdout tail prints lines that look like structural markers (but WITHOUT the nonce
    // prefix) must not be able to hijack the parser. True result: exit_code=0.
    const runner = makeSshRunner({
      exitCode: 0,
      // Built manually so the adversarial lines stay BARE (no nonce) while real markers carry it.
      stdout: [
        `${NONCE}JOB_START:job-1`,
        `${NONCE}alive:1`,
        '0',
        'JOB_START:job-1', // adversarial line inside the stdout tail
        'alive:0', // adversarial line inside the stdout tail
        `${NONCE}STDOUT_END:job-1`,
        `${NONCE}STDERR_END:job-1`
      ].join('\n'),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1'))
    ])
    const obs = (result as Extract<PollManyResult, { kind: 'ok' }>).observations.get('job-1')!
    expect(obs.exitCode).toBe(0)
    expect(obs.alive).toBe(true)
  })

  it('returns unreachable when the SSH call throws', async () => {
    const runner: SshRunner = { run: vi.fn(() => Promise.reject(new Error('ssh broke'))) }
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1'))
    ])
    expect(result).toMatchObject({ kind: 'unreachable', message: 'ssh broke' })
  })

  it('returns unreachable on SSH timeout', async () => {
    const runner = makeSshRunner({
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1'))
    ])
    expect(result.kind).toBe('unreachable')
  })

  it('returns unreachable on SSH exit 255', async () => {
    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'down',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1'))
    ])
    expect(result.kind).toBe('unreachable')
  })

  it('polls a legacy unversioned handle identically to a v1 handle (no batch rewrite)', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:legacy',
        'alive:0',
        '0',
        'legacy out',
        'STDOUT_END:legacy',
        '',
        'STDERR_END:legacy'
      ]),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('legacy', legacyHandle('legacy', 9999))
    ])
    const obs = (result as Extract<PollManyResult, { kind: 'ok' }>).observations.get('legacy')!
    expect(obs).toMatchObject({ alive: false, exitCode: 0, hasExitCode: true })
  })

  it('observes multiple jobs in one SSH round-trip (batched per provider)', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce([
        'JOB_START:job-1',
        'alive:1',
        '0',
        'out1',
        'STDOUT_END:job-1',
        '',
        'STDERR_END:job-1',
        'JOB_START:job-2',
        'alive:0',
        '7',
        '',
        'STDOUT_END:job-2',
        'boom',
        'STDERR_END:job-2'
      ]),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, [
      driverJob('job-1', directV1Handle('job-1', 1)),
      driverJob('job-2', directV1Handle('job-2', 2))
    ])
    const obs = (result as Extract<PollManyResult, { kind: 'ok' }>).observations
    // Exactly one SSH call for the whole batch (sub-batching only kicks in past POLL_BATCH_MAX_JOBS).
    expect(runner.run).toHaveBeenCalledTimes(1)
    expect(obs.get('job-1')?.exitCode).toBe(0)
    expect(obs.get('job-2')?.exitCode).toBe(7)
  })

  it('polls >8 jobs in size-bounded sub-batches, observing every job', async () => {
    // Build one section per job; the driver must split into multiple SSH calls so the output cap fits.
    const sections: string[] = []
    const jobs: DriverJob[] = []
    for (let i = 0; i < 10; i++) {
      const id = `job-${i}`
      jobs.push(driverJob(id, directV1Handle(id, 100 + i)))
      sections.push(
        ...['JOB_START:' + id, 'alive:0', '0', '', 'STDOUT_END:' + id, '', 'STDERR_END:' + id]
      )
    }
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: withNonce(sections),
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner, makeNonce: () => NONCE })

    const result = await driver.pollMany({ target, workdir: 'w' }, jobs)
    const obs = (result as Extract<PollManyResult, { kind: 'ok' }>).observations
    // 10 jobs / max 8 per batch = 2 SSH round-trips.
    expect(runner.run).toHaveBeenCalledTimes(2)
    expect(obs.size).toBe(10)
    for (let i = 0; i < 10; i++) {
      expect(obs.get(`job-${i}`)?.exitCode).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('DirectDriver.cancel', () => {
  it('issues a process-group kill command targeting the pgid', async () => {
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const driver = new DirectDriver({ runner })

    await driver.cancel(
      { target, workdir: 'w' },
      {
        version: 1,
        driver: 'direct',
        pid: 4242,
        pgid: 4242,
        paths: { workdir: 'w', stdout: 's', stderr: 'e', exitCode: 'x' }
      }
    )

    const cmd = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    // Process-group kill: `kill -- -<pgid>` targets the whole group (setsid pgid == pid).
    expect(cmd).toContain('kill -- -4242')
    expect(cmd).toContain('kill -9 -4242')
  })

  it('swallows connectivity errors so a failing cancel cannot wedge a terminal transition', async () => {
    const runner: SshRunner = { run: vi.fn(() => Promise.reject(new Error('host down'))) }
    const driver = new DirectDriver({ runner })

    await expect(
      driver.cancel(
        { target, workdir: 'w' },
        {
          version: 1,
          driver: 'direct',
          pid: 1,
          pgid: 1,
          paths: { workdir: 'w', stdout: 's', stderr: 'e', exitCode: 'x' }
        }
      )
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// driver registry
// ---------------------------------------------------------------------------

describe('ComputeDriverRegistry / resolveJobDriver', () => {
  it('resolves a direct job to the registered direct driver', async () => {
    const { ComputeDriverRegistry, resolveJobDriver } = await import('./compute-driver')
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const direct = new DirectDriver({ runner })
    const registry = new ComputeDriverRegistry()
    registry.register(direct)

    const job = { driver: 'direct' as const } as ComputeJob
    expect(resolveJobDriver(job, registry)).toBe(direct)
  })

  it('returns undefined for an unregistered slurm driver kind (Issue 03 not landed)', async () => {
    const { ComputeDriverRegistry, resolveJobDriver } = await import('./compute-driver')
    const registry = new ComputeDriverRegistry()
    expect(resolveJobDriver({ driver: 'slurm' } as ComputeJob, registry)).toBeUndefined()
  })

  it('falls back to direct for legacy rows with no driver column', async () => {
    const { ComputeDriverRegistry, resolveJobDriver } = await import('./compute-driver')
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const direct = new DirectDriver({ runner })
    const registry = new ComputeDriverRegistry()
    registry.register(direct)

    expect(resolveJobDriver({ driver: undefined } as ComputeJob, registry)).toBe(direct)
  })
})
