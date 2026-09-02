import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { sandboxedPackageSpawn } from './package-process-sandbox'
import type { NotebookProcessSandbox } from './process-sandbox'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('sandboxedPackageSpawn', () => {
  it('runs an installer through the Notebook sandbox and preserves its lifecycle', async () => {
    const endExecution = vi.fn()
    const cleanup = vi.fn().mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        beginExecution: () => endExecution,
        annotateStderr: (stderr: string) =>
          `${stderr}<sandbox_violations>blocked</sandbox_violations>`,
        cleanup
      }))
    }
    const storageRoot = process.cwd()
    const packageCache = mkdtempSync(join(tmpdir(), 'open-science-package-cache-'))
    const matplotlibCache = join(packageCache, 'matplotlib')
    temporaryDirectories.push(packageCache)
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: {
        language: 'python',
        packages: ['example'],
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceCwd: process.cwd()
      },
      runtimeRoot: join(storageRoot, '.open-science-test-runtime', 'package-sandbox', 'runtime'),
      storageRoot
    })

    const result = await spawn(process.execPath, ['-e', 'process.stderr.write("installer")'], {
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem',
      CONDA_PKGS_DIRS: packageCache,
      MPLCONFIGDIR: matplotlibCache,
      OPENAI_API_KEY: 'must-not-cross'
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('installer<sandbox_violations>blocked</sandbox_violations>')
    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'python',
        cwd: process.cwd()
      })
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).toMatchObject({
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem',
      MPLCONFIGDIR: matplotlibCache
    })
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).not.toHaveProperty(
      'OPENAI_API_KEY'
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].filesystem.readWriteRoots).toContain(
      packageCache
    )
    expect(endExecution).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith('exit', {
      processesTerminated: process.platform !== 'win32'
    })
  })

  it.each([
    {
      event: 'close',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      code: 0
    },
    {
      event: 'spawn error',
      executable: join(process.cwd(), 'missing-installer-executable'),
      args: [],
      code: 1
    }
  ])(
    'waits for bounded installer-tree observation after $event',
    async ({ executable, args, code }) => {
      let releaseReaping: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseReaping = resolve
      })
      const terminateTree = vi.fn(async () => {
        await gate
        return { reaped: false }
      })
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      const spawn = sandboxedPackageSpawn({
        processSandbox,
        request: { language: 'python', packages: ['example'] },
        runtimeRoot: join(process.cwd(), '.open-science-test-runtime'),
        storageRoot: process.cwd(),
        platform: 'linux',
        terminateTree
      })
      let completed = false

      const completion = spawn(executable, args).then((result) => {
        completed = true
        return result
      })

      await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      expect(cleanup).not.toHaveBeenCalled()
      releaseReaping?.()
      await expect(completion).resolves.toMatchObject({ code })
      expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: false })
    }
  )

  it.runIf(process.platform !== 'win32')(
    'reaps an installer helper that outlives its leader',
    async () => {
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      const spawn = sandboxedPackageSpawn({
        processSandbox,
        request: { language: 'python', packages: ['example'] },
        runtimeRoot: join(process.cwd(), '.open-science-test-runtime'),
        storageRoot: process.cwd()
      })
      let helperPid: number | undefined

      try {
        const result = await spawn(process.execPath, [
          '-e',
          "const {spawn}=require('node:child_process'); const helper=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true}); helper.unref(); process.stdout.write(String(helper.pid));"
        ])
        helperPid = Number(result.stdout)
        expect(result.code).toBe(0)
        await vi.waitFor(() => expect(() => process.kill(helperPid as number, 0)).toThrow())
        expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: true })
      } finally {
        if (helperPid) {
          try {
            process.kill(helperPid, 'SIGKILL')
          } catch {
            // Expected once the owned installer group has been reaped.
          }
        }
      }
    }
  )
})
