import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { wsl2Launch } from '../runtime/src/platform/wsl2-isolation.js'
import { notebookWorkloadCacheEnv } from '../../../src/main/notebook/notebook-workload-cache-paths.js'

const mapped = new Map([
  ['C:\\Open Science\\Workspace 路径', '/mnt/c/Open Science/Workspace 路径'],
  ['C:\\Open Science\\handoff', '/mnt/c/Open Science/handoff'],
  ['C:\\Open Science\\cache', '/mnt/c/Open Science/cache'],
  ['C:\\private', '/mnt/c/private']
])

beforeEach(() => vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1'))
afterEach(() => vi.unstubAllEnvs())

describe('WSL2 sandbox adapter', () => {
  it('does not prepare a WSL launch while the development gate is disabled', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '')
    const mapPath = vi.fn(async () => '/mnt/c/workspace')

    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        mapPath
      })
    ).rejects.toThrow('Notebook WSL2 Bash runtime is unavailable.')
    expect(mapPath).not.toHaveBeenCalled()
  })

  it('compiles Windows filesystem policy into a networkless bwrap Bash launch', async () => {
    const runtimeRoot = 'C:\\Open Science\\runtime 路径'
    const cacheEnvironment = notebookWorkloadCacheEnv(runtimeRoot)
    const cacheRoot = cacheEnvironment.OPEN_SCIENCE_NOTEBOOK_CACHE_DIR!
    const mapPath = vi.fn(async (path: string) => {
      const known = mapped.get(path)
      if (known) return known
      if (/^C:\\/u.test(path)) return `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
      return path
    })

    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: `printf '你好 world'`,
      cwd: 'C:\\Open Science\\Workspace 路径',
      env: {
        PATH: 'C:\\Windows\\System32',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak'
      },
      pathEnvironment: {
        OPEN_SCIENCE_HANDOFF_DIR: 'C:\\Open Science\\handoff',
        ...cacheEnvironment
      },
      filesystem: {
        privateRoot: 'C:\\private',
        readOnlyRoots: ['/usr', '/bin'],
        readWriteRoots: [
          'C:\\Open Science\\Workspace 路径',
          'C:\\Open Science\\handoff',
          cacheRoot
        ],
        deniedReadRoots: ['C:\\private'],
        deniedWriteRoots: []
      },
      mapPath
    })

    expect(launch.argv[0]).toMatch(/wsl\.exe$/i)
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        '--distribution',
        'Ubuntu-22.04',
        '--user',
        'open-science-spike',
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        expect.stringContaining('export OPEN_SCIENCE_WSL_EXECUTION_TOKEN="$token"'),
        'open-science-wsl-execution',
        expect.stringMatching(/^\/tmp\/\.open-science-execution-[0-9a-f-]{36}\.receipt$/u),
        expect.stringMatching(/^open-science-execution-[0-9a-f-]{36}$/u),
        '/usr/bin/bwrap',
        '--unshare-all',
        '--tmpfs',
        '/mnt',
        '--bind',
        '/mnt/c/Open Science/Workspace 路径',
        '/mnt/c/Open Science/Workspace 路径',
        '--chdir',
        '/mnt/c/Open Science/Workspace 路径',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        `printf '你好 world'`
      ])
    )
    expect(launch.argv.slice(1).join('\n')).not.toContain('C:\\')
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        '--setenv',
        'PATH',
        '/usr/bin:/bin',
        '--setenv',
        'OPEN_SCIENCE_HANDOFF_DIR',
        '/mnt/c/Open Science/handoff',
        '--setenv',
        'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR',
        '/mnt/c/Open Science/runtime 路径/cache/notebook'
      ])
    )
    for (const [key, value] of Object.entries(cacheEnvironment)) {
      const keyIndex = launch.argv.indexOf(key)
      expect(keyIndex).toBeGreaterThan(0)
      expect(launch.argv[keyIndex + 1]).toBe(`/mnt/c/${value!.slice(3).replaceAll('\\', '/')}`)
    }
    expect(launch.argv.join('\n')).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(launch.env.PATH).toBeUndefined()
    expect(launch.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(mapPath).toHaveBeenCalledWith('C:\\Open Science\\Workspace 路径')
  })

  it('releases one exact guest execution once and reports incomplete cleanup', async () => {
    const cleanupGuest = vi.fn(async () => false)
    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: 'sleep 30',
      cwd: 'C:\\workspace',
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      mapPath: async () => '/mnt/c/workspace',
      cleanupGuest
    })

    const first = launch.release('cancel')
    const second = launch.release('timeout')

    await expect(first).resolves.toBe(false)
    expect(second).toBe(first)
    expect(cleanupGuest).toHaveBeenCalledOnce()
    expect(cleanupGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike',
        reason: 'cancel',
        receipt: expect.stringMatching(/^\/tmp\/\.open-science-execution-/u),
        token: expect.stringMatching(/^open-science-execution-/u)
      })
    )
  })

  it('fails closed when an authorized Windows path cannot be mapped', async () => {
    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        mapPath: async () => {
          throw new Error('mapping failed')
        }
      })
    ).rejects.toThrow('WSL2 sandbox path mapping failed')
  })

  it('fails closed when a declared cache path is outside every writable root', async () => {
    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: { AWS_SECRET_FILE: 'C:\\private\\secret' },
        pathEnvironment: { UV_CACHE_DIR: 'C:\\unauthorized\\uv' },
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        mapPath: async (path) => `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
      })
    ).rejects.toThrow('WSL2 sandbox path environment is not writable')
  })

  it('fails closed rather than overriding the fixed guest PATH', async () => {
    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        pathEnvironment: { PATH: 'C:\\workspace\\bin' },
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        mapPath: async (path) => `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
      })
    ).rejects.toThrow('WSL2 sandbox path environment key is reserved')
  })
})
