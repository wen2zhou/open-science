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

type OwnerOptions = ConstructorParameters<typeof WslSetupOwner>[0]
const makeOwner = (
  options: Omit<OwnerOptions, 'volumeProbe'> & Partial<Pick<OwnerOptions, 'volumeProbe'>>
): WslSetupOwner =>
  new WslSetupOwner({
    volumeProbe: async () => ({ kind: 'local-ntfs' }),
    ...options
  })

describe('WslSetupOwner', () => {
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
      result('1000\nscientist'),
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
      result('1000\nscientist'),
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
      result('1000\nscientist'),
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
    const missing = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
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

  it('marks the namespace check as failed when bubblewrap cannot create the sandbox', async () => {
    const owner = makeOwner({
      runner: makeRunner(
        result('Default Version: 2'),
        result('Ubuntu'),
        result('* Ubuntu Running 2'),
        result('1000\nscientist'),
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
        result('1000\nscientist'),
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
