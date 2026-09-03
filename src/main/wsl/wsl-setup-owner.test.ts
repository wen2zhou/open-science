import { describe, expect, it, vi } from 'vitest'

import {
  RECOMMENDED_WSL_DISTRO,
  WslSetupOwner,
  type WslCommandRunner,
  type WslPlatformInstaller,
  type WslTerminalLauncher
} from './wsl-setup-owner'

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

type OwnerOptions = ConstructorParameters<typeof WslSetupOwner>[0]
const makeOwner = (
  options: Omit<OwnerOptions, 'volumeProbe'> & Partial<Pick<OwnerOptions, 'volumeProbe'>>
): WslSetupOwner =>
  new WslSetupOwner({
    volumeProbe: async () => ({ kind: 'local-ntfs' }),
    ...options
  })

describe('WslSetupOwner', () => {
  it('installs the WSL platform only through the explicit owner command and confirms OS state', async () => {
    const installer: WslPlatformInstaller = {
      install: vi.fn(async () => ({ kind: 'exited' as const, exitCode: 1 }))
    }
    const runner = makeRunner(result('private-host-output'), result(''), result(''))
    const log = { info: vi.fn(), warn: vi.fn() }
    const owner = makeOwner({
      installer,
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      operationReference: () => 'install1',
      log
    })

    await expect(owner.installPlatform()).resolves.toEqual({
      outcome: 'completed',
      operationReference: 'install1',
      snapshot: {
        state: 'distro-required',
        distros: [],
        errorCode: 'wsl_distro_missing',
        operationReference: 'install1'
      }
    })
    expect(installer.install).toHaveBeenCalledOnce()
    expect(runner.run).toHaveBeenCalledWith(['--status'])
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain(
      'private-host-output'
    )
  })

  it.each([
    [
      'UAC cancellation',
      { kind: 'uac-cancelled' as const },
      'uac-cancelled',
      'wsl_install_uac_cancelled'
    ],
    [
      'launcher failure',
      { kind: 'spawn-failed' as const },
      'spawn-failed',
      'wsl_install_spawn_failed'
    ]
  ])(
    'reports %s without probing or replaying the installer',
    async (_label, execution, outcome, code) => {
      const installer: WslPlatformInstaller = { install: vi.fn(async () => execution) }
      const runner = makeRunner()
      const owner = makeOwner({
        installer,
        runner,
        workspacePath: 'C:\\science',
        readSelection: async () => undefined,
        writeSelection: vi.fn(),
        operationReference: () => 'install2'
      })

      await expect(owner.installPlatform()).resolves.toMatchObject({
        outcome,
        operationReference: 'install2',
        snapshot: { state: 'not-installed', errorCode: code, operationReference: 'install2' }
      })
      expect(installer.install).toHaveBeenCalledOnce()
      expect(runner.run).not.toHaveBeenCalled()
    }
  )

  it('reports an unknown result when the post-install OS probe itself fails', async () => {
    const installer: WslPlatformInstaller = {
      install: vi.fn(async () => ({ kind: 'exited' as const, exitCode: 0 }))
    }
    const runner: WslCommandRunner = { run: vi.fn(async () => Promise.reject(new Error('boom'))) }
    const owner = makeOwner({
      installer,
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      operationReference: () => 'install5'
    })

    await expect(owner.installPlatform()).resolves.toMatchObject({
      outcome: 'unknown',
      operationReference: 'install5',
      snapshot: {
        state: 'failed',
        errorCode: 'wsl_install_unknown',
        operationReference: 'install5'
      }
    })
    expect(installer.install).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'restart-required',
      3010,
      [result('', 1, 'localized pending state'), result('', 1, 'localized unavailable')],
      'restart-required'
    ],
    [
      'unknown',
      1,
      [result('', 1, 'localized failure'), result('', 1, 'localized failure')],
      'failed'
    ]
  ])(
    'keeps an uncertain %s install single-shot and returns a fresh probe',
    async (outcome, exitCode, responses, state) => {
      const installer: WslPlatformInstaller = {
        install: vi.fn(async () => ({ kind: 'exited' as const, exitCode }))
      }
      const runner = makeRunner(...responses)
      const owner = makeOwner({
        installer,
        runner,
        workspacePath: 'C:\\science',
        readSelection: async () => undefined,
        writeSelection: vi.fn(),
        operationReference: () => 'install3'
      })

      await expect(owner.installPlatform()).resolves.toMatchObject({
        outcome,
        operationReference: 'install3',
        snapshot: { state, operationReference: 'install3' }
      })
      expect(installer.install).toHaveBeenCalledOnce()
      expect(runner.run).toHaveBeenCalledTimes(2)
    }
  )

  it('installs only the recommended distro after an explicit request and returns a fresh OS probe', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result(''),
      result(''),
      result('', 0),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    )
    const log = { info: vi.fn(), warn: vi.fn() }
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      log
    })

    const snapshot = await owner.installRecommendedDistro()

    expect(RECOMMENDED_WSL_DISTRO).toBe('Ubuntu-22.04')
    expect(runner.run).toHaveBeenNthCalledWith(4, [
      '--install',
      '--distribution',
      'Ubuntu-22.04',
      '--no-launch'
    ])
    expect(snapshot).toMatchObject({
      state: 'distro-required',
      distros: [{ name: 'Ubuntu-22.04', version: 2 }]
    })
    expect(runner.run).toHaveBeenCalledTimes(7)
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain(
      'Ubuntu-22.04'
    )
  })

  it('opens an installed distro for interactive first launch without supplying credentials', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2'),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Stopped 2')
    )
    const terminal: WslTerminalLauncher = { open: vi.fn(async () => undefined) }
    const owner = makeOwner({
      runner,
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    const snapshot = await owner.openTerminal({ distro: 'Ubuntu-22.04' })

    expect(terminal.open).toHaveBeenCalledWith(['--distribution', 'Ubuntu-22.04'])
    expect(snapshot).toMatchObject({ state: 'distro-required' })
  })

  it('fails closed when install does not produce the recommended distro', async () => {
    const runner = makeRunner(
      result('Default Version: 2'),
      result(''),
      result(''),
      result('', 1, 'localized install failure'),
      result('Default Version: 2'),
      result(''),
      result('')
    )
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })

    await expect(owner.installRecommendedDistro()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_distro_install_failed'
    })

    const unconfirmed = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result(''),
        result(''),
        result('', 0),
        result('Default Version: 2'),
        result(''),
        result('')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(unconfirmed.installRecommendedDistro()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_distro_install_unconfirmed'
    })
  })

  it('opens dependency help as the selected non-root user and rejects unprobed distros', async () => {
    const terminal: WslTerminalLauncher = { open: vi.fn(async () => undefined) }
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash'),
      result('Default Version: 2'),
      result('Ubuntu-22.04'),
      result('* Ubuntu-22.04 Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash')
    )
    const owner = makeOwner({
      runner,
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu-22.04', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(
      owner.openTerminal({ distro: 'Ubuntu-22.04', user: 'scientist' })
    ).resolves.toMatchObject({ state: 'dependency-required', errorCode: 'wsl_bwrap_missing' })
    expect(terminal.open).toHaveBeenCalledWith([
      '--distribution',
      'Ubuntu-22.04',
      '--user',
      'scientist'
    ])

    const rejected = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-22.04'),
        result('* Ubuntu-22.04 Running 2')
      ),
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(rejected.openTerminal({ distro: 'Attacker\n--exec' })).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_terminal_request_invalid'
    })
    expect(terminal.open).toHaveBeenCalledTimes(1)
  })

  it('returns a stable code without logging terminal errors or profile identity', async () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    const terminal: WslTerminalLauncher = {
      open: vi.fn(async () => {
        throw new Error('private terminal output for scientist')
      })
    }
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu-22.04'),
        result('* Ubuntu-22.04 Stopped 2')
      ),
      terminal,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn(),
      log
    })

    await expect(owner.openTerminal({ distro: 'Ubuntu-22.04' })).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_terminal_open_failed'
    })
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain('scientist')
    expect(logged).not.toContain('Ubuntu-22.04')
    expect(logged).not.toContain('private terminal output')
  })

  it('distinguishes platform, restart, and distro-required setup states', async () => {
    const absent = makeOwner({
      runner: makeRunner(result('', 1, 'WSL is not installed')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(absent.probe()).resolves.toMatchObject({
      state: 'not-installed',
      errorCode: 'wsl_not_installed'
    })

    const restart = makeOwner({
      runner: makeRunner(result('', 1, 'A system restart is required')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(restart.probe()).resolves.toMatchObject({
      state: 'restart-required',
      errorCode: 'wsl_restart_required'
    })

    const noDistro = makeOwner({
      runner: makeRunner(result('Default Version: 2'), result('')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(noDistro.probe()).resolves.toMatchObject({
      state: 'distro-required',
      errorCode: 'wsl_distro_missing'
    })

    const localizedList = makeOwner({
      runner: makeRunner(
        result('默认版本: 2'),
        result('Ubuntu-24.04'),
        result('* Ubuntu-24.04 已停止 2')
      ),
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
    const restart = makeOwner({
      runner: makeRunner(result('', 1, '需要重新启动'), result('WSL 2.4.0')),
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection: vi.fn()
    })
    await expect(restart.probe()).resolves.toMatchObject({
      state: 'restart-required',
      errorCode: 'wsl_restart_required'
    })

    const absent = makeOwner({
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
      result('Ubuntu-24.04'),
      result('* Ubuntu-24.04 Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/bwrap'),
      result('ok'),
      result('/mnt/c/science\nok')
    )
    const owner = makeOwner({
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
      6,
      expect.arrayContaining([
        'bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true && printf ok'
      ])
    )
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain('Ubuntu-24.04')
    expect(logged).not.toContain('scientist')
    expect(logged).not.toContain('C:\\\\science')
  })

  it('keeps exact distro names when verbose states contain localized words', async () => {
    const writeSelection = vi.fn()
    const nulSeparated = (value: string): string => [...value].join('\0')
    const runner = makeRunner(
      result('Default Version: 2'),
      result(nulSeparated('Ubuntu Pro\r\nDebian 中文\r\nSUSE Dev')),
      result(
        nulSeparated(
          '  NAME                  STATE             VERSION\r\n' +
            '* Ubuntu Pro            En ejecución      2\r\n' +
            '  Debian 中文            Wird ausgeführt   1\r\n' +
            '  SUSE Dev               正在 运行           2'
        )
      ),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/bwrap'),
      result('ok'),
      result('/mnt/c/science\nok')
    )
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => undefined,
      writeSelection
    })

    const snapshot = await owner.select({ distro: 'Ubuntu Pro', user: 'scientist' })

    expect(writeSelection).toHaveBeenCalledWith({ distro: 'Ubuntu Pro', user: 'scientist' })
    expect(snapshot).toMatchObject({
      state: 'ready',
      selection: { distro: 'Ubuntu Pro', user: 'scientist' },
      distros: [
        { name: 'Ubuntu Pro', version: 2, isDefault: true },
        { name: 'Debian 中文', version: 1, isDefault: false },
        { name: 'SUSE Dev', version: 2, isDefault: false }
      ]
    })
    expect(runner.run).toHaveBeenNthCalledWith(2, ['--list', '--quiet'])
    expect(runner.run).toHaveBeenNthCalledWith(3, ['--list', '--verbose'])
  })

  it.each([
    [{ kind: 'not-local' as const }, 'wsl_workspace_not_local'],
    [{ kind: 'not-ntfs' as const, fileSystem: 'exFAT' }, 'wsl_workspace_not_ntfs'],
    [{ kind: 'not-ntfs' as const, fileSystem: 'ReFS' }, 'wsl_workspace_not_ntfs'],
    [{ kind: 'unavailable' as const }, 'wsl_workspace_volume_unavailable']
  ])('never becomes ready for an unsupported Windows volume', async (volume, errorCode) => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2')
      ),
      workspacePath: 'Z:\\science',
      volumeProbe: vi.fn(async () => volume),
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode,
      readiness: { wsl2: true, localWorkspace: false }
    })
  })

  it('resolves the configured data root when probing instead of capturing it at construction', async () => {
    let configuredRoot = 'C:\\default-data'
    const volumeProbe = vi.fn(async () => ({ kind: 'local-ntfs' as const }))
    const runner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu'),
      result('* Ubuntu Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n/usr/bin/bwrap'),
      result('ok'),
      result('/mnt/d/custom-data\nok')
    )
    const owner = makeOwner({
      runner,
      workspacePath: () => configuredRoot,
      volumeProbe,
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    configuredRoot = 'D:\\custom-data'
    await expect(owner.probe()).resolves.toMatchObject({ state: 'ready' })
    expect(volumeProbe).toHaveBeenCalledWith('D:\\custom-data')
    expect(runner.run).toHaveBeenLastCalledWith(expect.arrayContaining(['D:\\custom-data']))
  })

  it.each([
    [
      'WSL1 distro',
      'wsl1_unsupported',
      makeRunner(result('Default Version: 2'), result('Ubuntu'), result('* Ubuntu Stopped 1'))
    ],
    [
      'root user',
      'wsl_root_user',
      makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('0\nroot')
      )
    ],
    [
      'uninitialized distro',
      'wsl_first_launch_required',
      makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Stopped 2'),
        result('', 1, 'localized first-launch failure'),
        result('', 1, 'localized first-launch failure')
      )
    ]
  ])('fails safely for %s', async (_label, errorCode, runner) => {
    const owner = makeOwner({
      runner,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'root' }),
      writeSelection: vi.fn()
    })
    await expect(owner.probe()).resolves.toMatchObject({ errorCode })
  })

  it('reports missing dependencies and unsupported workspace paths with actionable stable codes', async () => {
    const missingRunner = makeRunner(
      result('Default Version: 2'),
      result('Ubuntu'),
      result('* Ubuntu Running 2'),
      result('1000\nscientist\nhome-ok'),
      result('/usr/bin/bash\n', 1)
    )
    const missing = makeOwner({
      runner: missingRunner,
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(missing.probe()).resolves.toMatchObject({
      state: 'dependency-required',
      errorCode: 'wsl_bwrap_missing',
      suggestedCommand: 'sudo apt-get update && sudo apt-get install bubblewrap'
    })
    expect(
      JSON.stringify((missingRunner.run as ReturnType<typeof vi.fn>).mock.calls)
    ).not.toContain('sudo apt-get')

    const unsupported = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2')
      ),
      workspacePath: '\\\\server\\share',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })
    await expect(unsupported.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_workspace_path_unsupported'
    })
  })

  it('does not mark a selected user ready without an existing Linux home directory', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_home_missing',
      readiness: { wsl2: true, home: false }
    })
  })

  it('marks the namespace check as failed when bubblewrap cannot create the sandbox', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap'),
        result('', 1, 'namespace unavailable')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'dependency-required',
      errorCode: 'wsl_namespace_unavailable',
      readiness: { wsl2: true, bash: true, bwrap: true, namespaces: false }
    })
  })

  it('marks the local workspace check as failed when the selected user cannot reach it', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist\nhome-ok'),
        result('/usr/bin/bash\n/usr/bin/bwrap'),
        result('ok'),
        result('/mnt/c/science', 1, 'workspace unavailable')
      ),
      workspacePath: 'C:\\science',
      readSelection: async () => ({ distro: 'Ubuntu', user: 'scientist' }),
      writeSelection: vi.fn()
    })

    await expect(owner.probe()).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'wsl_workspace_unreachable',
      readiness: {
        wsl2: true,
        bash: true,
        bwrap: true,
        namespaces: true,
        localWorkspace: false
      }
    })
  })
})
