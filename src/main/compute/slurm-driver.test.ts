import { describe, expect, it, vi } from 'vitest'

import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { SlurmDriver, SlurmDispatchError, parseSbatchJobId } from './slurm-driver'
import { parseRemoteHandle } from '../../shared/remote-handle'
import type { DriverJob } from './compute-driver'
import type { ResourceRequest } from '../../shared/compute-resources'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const target: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes']
}

// A capturing SSH runner: records every command it was asked to run and lets the test map a command
// prefix to a canned result. Unmatched commands return success with empty output.
type CannedEntry = { match: RegExp; result: () => Awaited<ReturnType<SshRunner['run']>> }
const makeScriptedRunner = (entries: CannedEntry[]): SshRunner & { commands: string[] } => {
  const commands: string[] = []
  const runner: SshRunner = {
    run: vi.fn(async (_t: ResolvedSshTarget, cmd: string) => {
      commands.push(cmd)
      for (const e of entries) {
        if (e.match.test(cmd)) return e.result()
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
    })
  }
  return Object.assign(runner, { commands })
}

const slurmV1Handle = (jobId: string, schedulerId = '12345'): string =>
  JSON.stringify({
    version: 1,
    driver: 'slurm',
    schedulerJobId: schedulerId,
    paths: {
      workdir: `~/.openscience/jobs/${jobId}`,
      stdout: `~/.openscience/jobs/${jobId}/stdout`,
      stderr: `~/.openscience/jobs/${jobId}/stderr`,
      exitCode: `~/.openscience/jobs/${jobId}/exit_code`
    }
  })

const driverJob = (jobId: string, handleRaw: string): DriverJob => ({
  jobId,
  handle: parseRemoteHandle(handleRaw)!
})

// ---------------------------------------------------------------------------
// parseSbatchJobId
// ---------------------------------------------------------------------------

describe('parseSbatchJobId', () => {
  it('parses --parsable output (a bare integer)', () => {
    expect(parseSbatchJobId('12345\n')).toBe('12345')
  })
  it('parses --parsable output with array suffix', () => {
    expect(parseSbatchJobId('12345_0\n')).toBe('12345')
  })
  it('parses the default "Submitted batch job N" line', () => {
    expect(parseSbatchJobId('Submitted batch job 98765\n')).toBe('98765')
  })
  it('returns undefined for unparseable output', () => {
    expect(parseSbatchJobId('something else')).toBeUndefined()
    expect(parseSbatchJobId('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('SlurmDriver.dispatch', () => {
  const resources: ResourceRequest = { partition: 'gpu', gpus: 1, timeLimitSeconds: 600 }

  it('submits via sbatch and returns a slurm-v1 handle with the scheduler job id', async () => {
    const runner = makeScriptedRunner([
      {
        match: /sbatch/,
        result: () => ({
          exitCode: 0,
          stdout: '4242\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const handle = await driver.dispatch({
      target,
      workdir: '~/.openscience/jobs/j1',
      command: 'python train.py',
      timeoutSeconds: 600,
      jobId: 'j1',
      resources
    })
    expect(handle).toMatchObject({ version: 1, driver: 'slurm', schedulerJobId: '4242' })
    // The dispatched command must be an sbatch invocation.
    expect(runner.commands.some((c) => /sbatch/.test(c))).toBe(true)
    // The wrapper script (base64-transferred) must include structured directives.
    const sbatchCmd = runner.commands.find((c) => /sbatch/.test(c))!
    const b64Match = sbatchCmd.match(/printf '%s' "([A-Za-z0-9+/=]+)" \| base64 -d > job\.sbatch/)
    expect(b64Match).not.toBeNull()
    const decoded = Buffer.from(b64Match![1], 'base64').toString('utf8')
    expect(decoded).toContain('--partition=gpu')
    expect(decoded).toContain('--gres=gpu:1')
  })

  it('rejects a reserved directive before any SSH (directive rejection)', async () => {
    const runner = makeScriptedRunner([])
    const driver = new SlurmDriver({ runner })
    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/j2',
        command: '#!/bin/bash\n#SBATCH --job-name=mine\necho hi',
        timeoutSeconds: 60,
        jobId: 'j2',
        resources: {}
      })
    ).rejects.toBeInstanceOf(SlurmDispatchError)
    // No SSH command should have been issued — rejection is pre-SSH.
    expect(runner.commands).toHaveLength(0)
  })

  it('rejects a directive conflicting with structured resources before SSH', async () => {
    const runner = makeScriptedRunner([])
    const driver = new SlurmDriver({ runner })
    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/j3',
        command: '#!/bin/bash\n#SBATCH --partition=cpu\necho hi',
        timeoutSeconds: 60,
        jobId: 'j3',
        resources: { partition: 'gpu' }
      })
    ).rejects.toBeInstanceOf(SlurmDispatchError)
    expect(runner.commands).toHaveLength(0)
  })

  it('accepts an allowed directive and renders it in the sbatch wrapper', async () => {
    const runner = makeScriptedRunner([
      {
        match: /sbatch/,
        result: () => ({
          exitCode: 0,
          stdout: '7\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const handle = await driver.dispatch({
      target,
      workdir: '~/.openscience/jobs/j4',
      command: '#!/bin/bash\n#SBATCH --mail-type=END\necho hi',
      timeoutSeconds: 60,
      jobId: 'j4',
      resources: {}
    })
    expect(handle).toMatchObject({ schedulerJobId: '7' })
    const sbatchCmd = runner.commands.find((c) => /sbatch/.test(c))!
    const b64Match = sbatchCmd.match(/printf '%s' "([A-Za-z0-9+/=]+)" \| base64 -d > job\.sbatch/)
    const decoded = Buffer.from(b64Match![1], 'base64').toString('utf8')
    expect(decoded).toContain('--mail-type=END')
  })

  it('maps host unreachable (exit 255) to host_unreachable', async () => {
    const runner = makeScriptedRunner([
      {
        match: /sbatch/,
        result: () => ({
          exitCode: 255,
          stdout: '',
          stderr: 'conn refused',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/j5',
        command: 'echo hi',
        timeoutSeconds: 60,
        jobId: 'j5',
        resources: {}
      })
    ).rejects.toMatchObject({ code: 'host_unreachable' })
  })

  it('maps a non-zero sbatch exit to dispatch_failed', async () => {
    const runner = makeScriptedRunner([
      {
        match: /sbatch/,
        result: () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'bad script',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    await expect(
      driver.dispatch({
        target,
        workdir: '~/.openscience/jobs/j6',
        command: 'echo hi',
        timeoutSeconds: 60,
        jobId: 'j6',
        resources: {}
      })
    ).rejects.toMatchObject({ code: 'dispatch_failed' })
  })
})

// ---------------------------------------------------------------------------
// pollMany: state mapping
// ---------------------------------------------------------------------------

describe('SlurmDriver.pollMany state mapping', () => {
  it('maps PENDING to alive, non-terminal, remoteState=PENDING, with queue reason', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({
          exitCode: 0,
          stdout: '111|PENDING|Priority\n222|RUNNING|\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '111')),
      driverJob('b', slurmV1Handle('b', '222'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const a = res.observations.get('a')!
    expect(a.alive).toBe(true)
    expect(a.hasExitCode).toBe(false)
    expect(a.remoteState).toBe('PENDING')
    expect(a.queueReason).toBe('Priority')
    const b = res.observations.get('b')!
    expect(b.alive).toBe(true)
    expect(b.hasExitCode).toBe(false)
    expect(b.remoteState).toBe('RUNNING')
  })

  it('uses sacct for terminal jobs not in squeue, returning exit code', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
      },
      {
        match: /sacct/,
        result: () => ({
          exitCode: 0,
          stdout: '333|COMPLETED|0:0\n444|FAILED|1:0\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '333')),
      driverJob('b', slurmV1Handle('b', '444'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const a = res.observations.get('a')!
    expect(a.hasExitCode).toBe(true)
    expect(a.exitCode).toBe(0)
    expect(a.remoteState).toBe('COMPLETED')
    const b = res.observations.get('b')!
    expect(b.hasExitCode).toBe(true)
    expect(b.exitCode).toBe(1)
    expect(b.remoteState).toBe('FAILED')
  })

  it('tolerates accounting delay: a job absent from both squeue and sacct stays non-terminal', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
      },
      {
        match: /sacct/,
        result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '555'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    // Not observed this tick — poller leaves it non-terminal and re-polls (accounting delay tolerance).
    expect(res.observations.get('a')).toBeUndefined()
  })

  it('reads stdout/stderr tails from the workdir for terminal jobs', async () => {
    const nonce = 'NONCE999_'
    // The tail batch emits nonce-prefixed markers around the captured content. The fake returns the
    // sectioned output the real ssh would produce when running the driver's echo+tail command.
    const tailSection = `${nonce}TAIL_START:a\nhello-out\n${nonce}STDOUT_END:a\nhello-err\n${nonce}STDERR_END:a\n`
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
      },
      {
        match: /sacct/,
        result: () => ({
          exitCode: 0,
          stdout: '666|COMPLETED|0:0\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      },
      {
        match: /TAIL_START/,
        result: () => ({
          exitCode: 0,
          stdout: tailSection,
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner, makeNonce: () => nonce })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '666'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const a = res.observations.get('a')!
    expect(a.stdoutTail).toContain('hello-out')
    expect(a.stderrTail).toContain('hello-err')
  })

  it('reports unreachable when the squeue SSH call times out (host down != job failed)', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({
          exitCode: 255,
          stdout: '',
          stderr: 'down',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '777'))
    ])
    expect(res.kind).toBe('unreachable')
    if (res.kind === 'unreachable') expect(res.message).toMatch(/down/)
  })

  it('handles empty job list', async () => {
    const runner = makeScriptedRunner([])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [])
    expect(res.kind).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('SlurmDriver.cancel', () => {
  it('issues scancel for the scheduler job id', async () => {
    const runner = makeScriptedRunner([
      {
        match: /scancel/,
        result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
      }
    ])
    const driver = new SlurmDriver({ runner })
    await driver.cancel(
      { target, workdir: '~/.openscience/jobs/x' },
      {
        version: 1,
        driver: 'slurm',
        schedulerJobId: '999',
        paths: parseRemoteHandle(slurmV1Handle('x', '999'))!.paths
      }
    )
    expect(runner.commands.some((c) => /scancel\s+999/.test(c))).toBe(true)
  })

  it('swallows connectivity errors (best-effort cancel)', async () => {
    const runner: SshRunner = {
      run: vi.fn(() => Promise.reject(new Error('host down')))
    }
    const driver = new SlurmDriver({ runner })
    await expect(
      driver.cancel(
        { target, workdir: '~/.openscience/jobs/x' },
        {
          version: 1,
          driver: 'slurm',
          schedulerJobId: '999',
          paths: parseRemoteHandle(slurmV1Handle('x', '999'))!.paths
        }
      )
    ).resolves.toBeUndefined()
  })

  it('ignores a non-slurm handle', async () => {
    const runner = makeScriptedRunner([])
    const driver = new SlurmDriver({ runner })
    await driver.cancel(
      { target, workdir: '~/.openscience/jobs/x' },
      {
        version: 1,
        driver: 'direct',
        pid: 1,
        pgid: 1,
        paths: parseRemoteHandle(slurmV1Handle('x', '999'))!.paths
      }
    )
    expect(runner.commands.some((c) => /scancel/.test(c))).toBe(false)
  })
})
