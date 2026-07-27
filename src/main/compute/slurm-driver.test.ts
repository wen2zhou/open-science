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

  // Regression: a command that submits its own job made the tracked wrapper terminate in under a
  // second, which took status, harvest, and cancel with it while the real work ran unobserved.
  it('rejects a nested sbatch submission before any SSH', async () => {
    const runner = makeScriptedRunner([])
    const driver = new SlurmDriver({ runner })
    const err = await driver
      .dispatch({
        target,
        workdir: '~/.openscience/jobs/j2b',
        command: 'sbatch -c 1 --mem=500M -p debug --wrap "python3 work.py"',
        timeoutSeconds: 300,
        jobId: 'j2b',
        resources: {}
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SlurmDispatchError)
    expect((err as SlurmDispatchError).code).toBe('invalid_directives')
    expect((err as SlurmDispatchError).detail).toContain('resources')
    expect(runner.commands).toHaveLength(0)
  })

  it('still dispatches a command that uses srun inside the allocation', async () => {
    const runner = makeScriptedRunner([
      {
        match: /sbatch/,
        result: () => ({
          exitCode: 0,
          stdout: '777\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const handle = await driver.dispatch({
      target,
      workdir: '~/.openscience/jobs/j2c',
      command: 'srun -n 4 ./solver',
      timeoutSeconds: 300,
      jobId: 'j2c',
      resources: { tasks: 4 }
    })
    expect(handle).toMatchObject({ driver: 'slurm', schedulerJobId: '777' })
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

  // Regression: squeue has no --parsable2 flag. Passing one made real squeue exit 1 printing nothing,
  // which looked identical to "every job left the queue" and terminated live jobs off a sacct row.
  it('builds a squeue command real slurm accepts (--format, never --parsable2)', async () => {
    const runner = makeScriptedRunner([])
    const driver = new SlurmDriver({ runner })
    await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '888'))
    ])
    const squeue = runner.commands.find((c) => c.includes('squeue'))!
    expect(squeue).not.toContain('--parsable2')
    expect(squeue).toContain("--format='%i|%T|%r'")
  })
})

// ---------------------------------------------------------------------------
// pollMany — sacct state gating (regression: "sleep 300" reported done in seconds)
// ---------------------------------------------------------------------------

describe('SlurmDriver.pollMany sacct state gating', () => {
  // sacct answers for jobs that are STILL QUEUED OR RUNNING. Reading such a row as terminal reported a
  // `sleep 300` job as succeeded with exit 0 and empty output seconds after submission.
  const nonTerminal = ['PENDING', 'RUNNING', 'SUSPENDED', 'COMPLETING', 'REQUEUED', 'RESIZING']
  for (const state of nonTerminal) {
    it(`keeps a job alive when sacct reports ${state}`, async () => {
      const runner = makeScriptedRunner([
        {
          match: /squeue/,
          result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
        },
        {
          match: /sacct/,
          result: () => ({
            exitCode: 0,
            stdout: `901|${state}|0:0\n901.batch|${state}|0:0\n`,
            stderr: '',
            truncated: false,
            timedOut: false
          })
        }
      ])
      const driver = new SlurmDriver({ runner })
      const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
        driverJob('a', slurmV1Handle('a', '901'))
      ])
      expect(res.kind).toBe('ok')
      if (res.kind !== 'ok') return
      const a = res.observations.get('a')!
      expect(a.alive).toBe(true)
      expect(a.hasExitCode).toBe(false)
      expect(a.exitCode).toBeNull()
      expect(a.remoteState).toBe(state)
      // No tail batch: the job is still writing to stdout/stderr.
      expect(runner.commands.some((c) => c.includes('TAIL_START'))).toBe(false)
    })
  }

  // Regression: `--states=all` keeps reporting a FINISHED job for MinJobAge (default 300s) with its
  // terminal state. Treating "present in squeue" as alive parked completed jobs at `running` for five
  // minutes, so the e2e gate timed out waiting for a terminal status.
  it('terminates a job squeue still reports with a terminal state (MinJobAge window)', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({
          exitCode: 0,
          stdout: '905|FAILED|NonZeroExitCode\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      },
      {
        match: /sacct/,
        result: () => ({
          exitCode: 0,
          stdout: '905|FAILED|3:0\n905.batch|FAILED|3:0\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '905'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const a = res.observations.get('a')!
    expect(a.alive).toBe(false)
    expect(a.hasExitCode).toBe(true)
    expect(a.exitCode).toBe(3)
    expect(a.remoteState).toBe('FAILED')
  })

  it('keeps a COMPLETING job in squeue alive (it is not terminal yet)', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({
          exitCode: 0,
          stdout: '906|COMPLETING|None\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '906'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.observations.get('a')!.alive).toBe(true)
    expect(runner.commands.some((c) => c.includes('sacct'))).toBe(false)
  })

  it('normalizes "CANCELLED by <uid>" so the poller classifies it as cancelled', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
      },
      {
        match: /sacct/,
        result: () => ({
          exitCode: 0,
          stdout: '902|CANCELLED by 1000|0:0\n902.batch|CANCELLED|0:15\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '902'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const a = res.observations.get('a')!
    expect(a.hasExitCode).toBe(true)
    expect(a.remoteState).toBe('CANCELLED')
  })

  it('reports unreachable when squeue fails for a non-benign reason', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({
          exitCode: 1,
          stdout: '',
          stderr: "squeue: unrecognized option '--bogus'",
          truncated: false,
          timedOut: false
        })
      },
      {
        match: /sacct/,
        result: () => ({
          exitCode: 0,
          stdout: '903|COMPLETED|0:0\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '903'))
    ])
    // A broken squeue must not be read as "the job left the queue" — no sacct, no terminal flip.
    expect(res.kind).toBe('unreachable')
    expect(runner.commands.some((c) => c.includes('sacct'))).toBe(false)
  })

  it('treats squeue exit 1 with "Invalid job id" as "all ids left the queue"', async () => {
    const runner = makeScriptedRunner([
      {
        match: /squeue/,
        result: () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'slurm_load_jobs error: Invalid job id specified',
          truncated: false,
          timedOut: false
        })
      },
      {
        match: /sacct/,
        result: () => ({
          exitCode: 0,
          stdout: '904|COMPLETED|0:0\n',
          stderr: '',
          truncated: false,
          timedOut: false
        })
      }
    ])
    const driver = new SlurmDriver({ runner })
    const res = await driver.pollMany({ target, workdir: '~/.openscience/jobs/x' }, [
      driverJob('a', slurmV1Handle('a', '904'))
    ])
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.observations.get('a')!.hasExitCode).toBe(true)
    expect(res.observations.get('a')!.remoteState).toBe('COMPLETED')
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
