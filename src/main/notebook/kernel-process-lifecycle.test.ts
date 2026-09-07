import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { KernelProcessLifecycleOwner } from './kernel-process-lifecycle'
import { readProcessStartToken } from './operation-recovery'

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('KernelProcessLifecycleOwner', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('reaps a verified stale owner before opening process admission', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-owner-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a',
      controller: {
        probe: vi.fn(async () => 'owned' as const),
        terminate: vi.fn(async () => ({ reaped: true }))
      }
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-a'
    })
    first.recordSpawned(intent, {
      pid: 4242,
      processStartToken: '100',
      commandIdentityMarker: 'marker-a'
    })

    const terminate = vi.fn(async () => ({ reaped: true }))
    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: { probe: vi.fn(async () => 'owned' as const), terminate }
    })
    await restarted.ensureReady()

    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerInstanceId: 'owner-a',
        kernelEpochId: 'epoch-a',
        laneKey: '["project-1","session-1","root",null,null]',
        processKey: 'python:default-python',
        pid: 4242
      })
    )
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it('retains an unverified old writer and keeps admission fenced', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-fence-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'repl',
      kernelEpochId: 'epoch-repl'
    })
    first.recordSpawned(intent, { pid: 5252, commandIdentityMarker: 'marker-repl' })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })

    await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    const [entry] = await readdir(join(root, 'runtime', 'kernel-processes'))
    expect(
      JSON.parse(await readFile(join(root, 'runtime', 'kernel-processes', entry!), 'utf8'))
    ).toMatchObject({
      ownerInstanceId: 'owner-a',
      processKey: 'repl',
      pid: 5252
    })
  })

  it('rolls back an interrupted pre-admission spawn intent on the next startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-pre-spawn-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    await first.ensureReady()
    first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-pre-spawn'
    })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b'
    })
    await restarted.ensureReady()

    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it('prevents a delayed process host from activating after recovery cancels its intent', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-cancelled-host-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'repl',
      kernelEpochId: 'epoch-delayed-host'
    })
    const marker = join(root, 'must-not-run.txt')

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b'
    })
    await restarted.ensureReady()

    const host = spawn(
      process.execPath,
      [
        join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
        intent.path,
        intent.record.receiptId,
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      host.once('error', reject)
      host.once('exit', resolve)
    })

    expect(exitCode).toBe(125)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  describe.skipIf(process.platform === 'win32')('POSIX startup recovery', () => {
    it('recovers a process host that survived before its main owner recorded the PID', async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-host-recovery-'))
      const first = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-a'
      })
      await first.ensureReady()
      const ownerToken = first.createOwnerToken()
      const intent = first.beginSpawn(
        {
          laneKey: '["project-1","session-1","root",null,null]',
          processKey: 'repl',
          kernelEpochId: 'epoch-host-crash-window'
        },
        ownerToken
      )
      const host = spawn(
        process.execPath,
        [
          join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
          intent.path,
          intent.record.receiptId,
          process.execPath,
          '-e',
          'setInterval(() => undefined, 1_000)'
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...first.environment(ownerToken) }
        }
      )
      const pid = host.pid!
      await vi.waitFor(async () => {
        const names = await readdir(join(root!, 'runtime', 'kernel-processes'))
        expect(names).toContainEqual(expect.stringContaining(`.active.${pid}.`))
      })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b'
      })
      await restarted.ensureReady()

      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }, 15_000)

    it('verifies and reaps a real orphaned process group before admission', async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-posix-recovery-'))
      const first = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-a'
      })
      await first.ensureReady()
      const ownerToken = first.createOwnerToken()
      const intent = first.beginSpawn(
        {
          laneKey: '["project-1","session-1","root",null,null]',
          processKey: 'python:default-python',
          kernelEpochId: 'epoch-posix'
        },
        ownerToken
      )
      const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...first.environment(ownerToken) }
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid!
      first.recordSpawned(intent, {
        pid,
        processStartToken: readProcessStartToken(pid)
      })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b'
      })
      await restarted.ensureReady()

      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }, 15_000)
  })

  describe.skipIf(process.platform !== 'win32')('Windows startup recovery', () => {
    it('verifies a real command identity and taskkills its complete process tree', async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-windows-recovery-'))
      const first = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-a'
      })
      await first.ensureReady()
      const ownerToken = first.createOwnerToken()
      const marker = `open-science-kernel-${ownerToken}`
      const intent = first.beginSpawn(
        {
          laneKey: '["project-1","session-1","root",null,null]',
          processKey: 'repl',
          kernelEpochId: 'epoch-windows'
        },
        ownerToken
      )
      const child = spawn(
        process.execPath,
        [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']); setInterval(()=>{},1000)",
          marker
        ],
        { windowsHide: true, env: { ...process.env, ...first.environment(ownerToken) } }
      )
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid!
      first.recordSpawned(intent, { pid, commandIdentityMarker: marker })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b'
      })
      await restarted.ensureReady()

      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }, 20_000)
  })
})
