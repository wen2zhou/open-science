// Driver conformance kit validation (design.md §11, Issue 07).
//
// Proves the reusable `runDriverConformanceKit` asserts the frozen contract across handle/submit/
// observe/state-map/cancel/errors. It drives the REAL SlurmDriver through the kit via a scripted fake
// cluster (sbatch/squeue/sacct/scancel), the same shape a future PBS/LSF adapter harness will provide.
// This keeps ONE authoritative contract assertion location and prevents silent drift between drivers.

import { describe, expect, it, vi } from 'vitest'

import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { SlurmDriver, parseSbatchJobId } from './slurm-driver'
import { runDriverConformanceKit, type DriverConformanceHarness } from './scheduler-conformance-kit'

const target: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'cluster.example',
  extraArgs: ['-o', 'BatchMode=yes']
}

// A scripted fake Slurm cluster — same shape as slurm-conformance.test.ts but minimal for the kit.
type FakeJob = { id: string; state: string; reason?: string; exit?: string }

const makeHarness = (): DriverConformanceHarness & {
  jobs: Map<string, FakeJob>
  cancelDown: boolean
} => {
  const jobs = new Map<string, FakeJob>()
  let nextId = 1000
  let cancelDown = false
  const runner: SshRunner = {
    run: vi.fn(async (_t: ResolvedSshTarget, cmd: string) => {
      if (/sbatch/.test(cmd)) {
        const id = String(nextId++)
        jobs.set(id, { id, state: 'PENDING', reason: 'Priority' })
        return { exitCode: 0, stdout: `${id}\n`, stderr: '', truncated: false, timedOut: false }
      }
      if (/squeue/.test(cmd)) {
        const lines: string[] = []
        for (const j of jobs.values()) {
          if (j.state === 'PENDING' || j.state === 'RUNNING') {
            lines.push(`${j.id}|${j.state}|${j.reason ?? ''}`)
          }
        }
        return {
          exitCode: 0,
          stdout: lines.join('\n') + '\n',
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }
      if (/sacct/.test(cmd)) {
        const lines: string[] = []
        for (const j of jobs.values()) {
          if (j.state !== 'PENDING' && j.state !== 'RUNNING') {
            lines.push(`${j.id}|${j.state}|${j.exit ?? '0:0'}`)
          }
        }
        return {
          exitCode: 0,
          stdout: lines.join('\n') + '\n',
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }
      if (/scancel/.test(cmd)) {
        if (cancelDown) {
          return {
            exitCode: 255,
            stdout: '',
            stderr: 'host down',
            truncated: false,
            timedOut: false
          }
        }
        const m = cmd.match(/scancel\s+(\d+)/)
        if (m) jobs.delete(m[1]!)
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
    })
  }
  const driver = new SlurmDriver({ runner })

  return {
    driver,
    dispatchContext: { target, workdir: '~/.openscience/jobs/conf-handle', timeoutSeconds: 60 },
    driverContext: { target, workdir: '~/.openscience/jobs/conf-handle' },
    jobs,
    cancelDown,
    advanceToRunning(sid) {
      const j = jobs.get(sid)
      if (!j) throw new Error(`fake job ${sid} not found for advanceToRunning`)
      j.state = 'RUNNING'
    },
    advanceToTerminal(sid, exitCode) {
      const j = jobs.get(sid)
      if (!j) throw new Error(`fake job ${sid} not found for advanceToTerminal`)
      j.state = exitCode === 0 ? 'COMPLETED' : 'FAILED'
      j.exit = `${exitCode}:0`
    },
    parseSubmitId: parseSbatchJobId,
    setCancelUnreachable(down) {
      cancelDown = down
    }
  }
}

describe('scheduler driver conformance kit (real SlurmDriver)', () => {
  it('asserts handle / submit / observe / state-map / cancel against the real Slurm driver', async () => {
    const harness = makeHarness()
    await expect(runDriverConformanceKit(harness)).resolves.toBeUndefined()
  })

  it('cancel is best-effort even when the host is down', async () => {
    const harness = makeHarness()
    // The kit itself flips unreachable ON and asserts cancel resolves. Verify the invariant directly
    // too so the contract is load-bearing in this file, not only inside the kit.
    harness.setCancelUnreachable?.(true)
    const handle = await harness.driver.dispatch({
      ...harness.dispatchContext,
      jobId: 'conf-cancel',
      command: 'echo hi',
      resources: {},
      timeoutSeconds: 30
    })
    await expect(harness.driver.cancel(harness.driverContext, handle)).resolves.toBeUndefined()
  })

  it('state mapping keeps provider state in remoteState, not in the alive/exit signal', async () => {
    const harness = makeHarness()
    const handle = await harness.driver.dispatch({
      ...harness.dispatchContext,
      jobId: 'conf-statemap',
      command: 'echo hi',
      resources: {},
      timeoutSeconds: 30
    })
    const sid = handle.driver === 'slurm' ? handle.schedulerJobId : ''
    harness.advanceToRunning(sid)
    const result = await harness.driver.pollMany(harness.driverContext, [
      { jobId: 'conf-statemap', handle: { kind: 'slurm-v1', ...handle } as never }
    ])
    expect(result.kind).toBe('ok')
    const obs = (result as { observations: Map<string, unknown> }).observations.get(
      'conf-statemap'
    ) as {
      alive: boolean
      remoteState: string
      queueReason?: string
    }
    // RUNNING → alive=true, hasExitCode=false, but remoteState carries the provider name.
    expect(obs.alive).toBe(true)
    expect(obs.remoteState).toBe('RUNNING')
    expect(obs.queueReason).toBe('Priority')
  })
})
