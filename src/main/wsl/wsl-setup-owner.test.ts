import { describe, expect, it, vi } from 'vitest'

import { WslSetupOwner, type WslCommandRunner } from './wsl-setup-owner'

const result = (
  stdout = '',
  exitCode = 0,
  stderr = '',
  failure?: 'not-found' | 'timeout'
): {
  stdout: string
  stderr: string
  exitCode: number
  failure?: 'not-found' | 'timeout'
} => ({ stdout, stderr, exitCode, ...(failure ? { failure } : {}) })

const makeRunner = (...responses: ReturnType<typeof result>[]): WslCommandRunner => ({
  run: vi.fn(async () => responses.shift() ?? result())
})

describe('WslSetupOwner', () => {
  it('distinguishes platform, restart, and distro-required setup states', async () => {
    const absent = new WslSetupOwner({
      runner: makeRunner(result('', 1, 'WSL is not installed')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(absent.probe()).resolves.toMatchObject({
      state: 'not-installed',
      errorCode: 'wsl_not_installed'
    })

    const restart = new WslSetupOwner({
      runner: makeRunner(result('', 1, 'A system restart is required')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(restart.probe()).resolves.toMatchObject({
      state: 'restart-required',
      errorCode: 'wsl_restart_required'
    })

    const noDistro = new WslSetupOwner({
      runner: makeRunner(result('Default Version: 2'), result('')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(noDistro.probe()).resolves.toMatchObject({
      state: 'distro-required',
      errorCode: 'wsl_distro_missing'
    })

    const localizedList = new WslSetupOwner({
      runner: makeRunner(result('默认版本: 2'), result('* Ubuntu-24.04 已停止 2')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(localizedList.probe()).resolves.toMatchObject({
      state: 'distro-required',
      distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }]
    })
  })

  it('classifies localized platform failures without depending on translated prose', async () => {
    const restart = new WslSetupOwner({
      runner: makeRunner(result('', 1, '需要重新启动'), result('WSL 2.4.0')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(restart.probe()).resolves.toMatchObject({
      state: 'restart-required',
      errorCode: 'wsl_restart_required'
    })

    const absent = new WslSetupOwner({
      runner: makeRunner(result('', 1, '找不到命令', 'not-found')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(absent.probe()).resolves.toMatchObject({
      state: 'not-installed',
      errorCode: 'wsl_not_installed'
    })
  })

  it('persists an exact distro and non-root user but reports ready only after every check passes', async () => {
    const writeSelection = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }
    const runner = makeRunner(
      result('Default Version: 2'),
      result('* Ubuntu-24.04 Running 2'),
      result('1000\nscientist'),
      result('/usr/bin/bash\n/usr/bin/bwrap'),
      result('ok'),
      result('/mnt/c/science\nok')
    )
    const owner = new WslSetupOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection,
      log
    })

    const snapshot = await owner.select({ distro: 'Ubuntu-24.04', user: 'scientist' })

    expect(writeSelection).toHaveBeenCalledWith({ distro: 'Ubuntu-24.04', user: 'scientist' })
    expect(snapshot).toMatchObject({
      state: 'ready',
      selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
      readiness: { wsl2: true, bash: true, bwrap: true, namespaces: true, localWorkspace: true }
    })
    expect(snapshot.operationReference).toMatch(/^[a-f0-9]{8}$/)
    expect(runner.run).toHaveBeenNthCalledWith(
      5,
      expect.arrayContaining([
        'bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true && printf ok'
      ])
    )
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain('Ubuntu-24.04')
    expect(logged).not.toContain('scientist')
    expect(logged).not.toContain('C:\\\\science')
  })

  it.each([
    [
      'WSL1 distro',
      'wsl1_unsupported',
      makeRunner(result('Default Version: 2'), result('* Ubuntu Stopped 1'))
    ],
    [
      'root user',
      'wsl_root_user',
      makeRunner(result('Default Version: 2'), result('* Ubuntu Running 2'), result('0\nroot'))
    ],
    [
      'uninitialized distro',
      'wsl_first_launch_required',
      makeRunner(
        result('Default Version: 2'),
        result('* Ubuntu Stopped 2'),
        result('', 1, 'localized first-launch failure'),
        result('', 1, 'localized first-launch failure')
      )
    ]
  ])('fails safely for %s', async (_label, errorCode, runner) => {
    const owner = new WslSetupOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'root' }),
      writeSelection: vi.fn()
    })
    await expect(owner.probe()).resolves.toMatchObject({ errorCode })
  })

  it('reports missing dependencies and unsupported workspace paths with actionable stable codes', async () => {
    const missing = new WslSetupOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist'),
        result('/usr/bin/bash\n', 1)
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(missing.probe()).resolves.toMatchObject({
      state: 'dependency-required',
      errorCode: 'wsl_bwrap_missing'
    })

    const unsupported = new WslSetupOwner({
      runner: makeRunner(result('Default Version: 2'), result('* Ubuntu Running 2')),
      workspacePath: '\\\\server\\share',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(unsupported.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_workspace_path_unsupported'
    })
  })
})
