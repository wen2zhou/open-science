import { execFile } from 'node:child_process'
import { posix, win32 } from 'node:path'

import type { FilesystemLayoutInput } from './filesystem-layout.js'

type Wsl2Target = Readonly<{
  kind: 'wsl2'
  profileId: string
  distro: string
  user: string
}>

type Wsl2PathMapper = (path: string) => Promise<string>

type Wsl2LaunchRequest = Readonly<{
  target: Wsl2Target
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  filesystem: FilesystemLayoutInput
  mapPath?: Wsl2PathMapper
}>

type Wsl2Launch = Readonly<{
  argv: string[]
  env: NodeJS.ProcessEnv
  release: () => Promise<void>
}>

const WINDOWS_PATH = /^[a-z]:[\\/]/iu
const SAFE_USER = /^[a-z_][a-z0-9_-]*[$]?$/u
const PATH_ENVIRONMENT_KEYS = new Set([
  'OPEN_SCIENCE_HANDOFF_DIR',
  'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR',
  'PIP_CACHE_DIR',
  'HF_HOME',
  'HF_HUB_CACHE',
  'TORCH_HOME',
  'XDG_CACHE_HOME'
])

const wslExecutable = (): string =>
  win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wsl.exe')

const validateTarget = (target: Wsl2Target): void => {
  if (!target.profileId.trim() || !target.distro.trim() || /[\0\r\n]/u.test(target.distro)) {
    throw new Error('WSL2 sandbox profile is invalid.')
  }
  if (!SAFE_USER.test(target.user)) throw new Error('WSL2 sandbox user is invalid.')
}

const defaultPathMapper =
  (target: Wsl2Target): Wsl2PathMapper =>
  async (path) => {
    if (!WINDOWS_PATH.test(path)) {
      if (path.startsWith('/')) return path
      throw new Error('Only canonical Windows or absolute guest paths are supported.')
    }
    return new Promise<string>((resolve, reject) => {
      execFile(
        wslExecutable(),
        [
          '--distribution',
          target.distro,
          '--user',
          target.user,
          '--exec',
          '/usr/bin/wslpath',
          '-a',
          '-u',
          path
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5_000, windowsHide: true },
        (error, stdout) => {
          const mapped = stdout.trim()
          if (error || !mapped.startsWith('/') || /[\0\r\n]/u.test(mapped)) {
            reject(new Error('WSL2 sandbox path mapping failed.'))
            return
          }
          resolve(mapped)
        }
      )
    })
  }

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const mountParents = (path: string): string[] => {
  const parents: string[] = []
  let parent = posix.dirname(path)
  while (parent !== '/') {
    parents.push(parent)
    parent = posix.dirname(parent)
  }
  return parents.reverse()
}

const wsl2Launch = async (request: Wsl2LaunchRequest): Promise<Wsl2Launch> => {
  validateTarget(request.target)
  const mapPath = request.mapPath ?? defaultPathMapper(request.target)
  const map = async (path: string): Promise<string> => {
    try {
      const mapped = await mapPath(path)
      if (!mapped.startsWith('/') || /[\0\r\n]/u.test(mapped)) throw new Error('invalid path')
      return mapped
    } catch {
      throw new Error('WSL2 sandbox path mapping failed.')
    }
  }

  const cwd = await map(request.cwd)
  const readOnlyRoots = await Promise.all(unique(request.filesystem.readOnlyRoots).map(map))
  const readWriteRoots = await Promise.all(unique(request.filesystem.readWriteRoots).map(map))
  const deniedReadRoots = await Promise.all(unique(request.filesystem.deniedReadRoots).map(map))
  const deniedWriteRoots = await Promise.all(unique(request.filesystem.deniedWriteRoots).map(map))
  const privateRoot = request.filesystem.privateRoot
    ? await map(request.filesystem.privateRoot)
    : undefined
  const contains = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
  const exposedRoots = [...readOnlyRoots, ...readWriteRoots]
  const needsExplicitDeny = (path: string): boolean =>
    !privateRoot ||
    !contains(privateRoot, path) ||
    exposedRoots.some((root) => contains(root, path))
  const explicitDeniedReadRoots = deniedReadRoots.filter(needsExplicitDeny)
  const explicitDeniedWriteRoots = deniedWriteRoots.filter(needsExplicitDeny)

  const guestEnvironment: Record<string, string> = {
    HOME: '/tmp/open-science-home',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin'
  }
  for (const [key, value] of Object.entries(request.env)) {
    if (!value || !PATH_ENVIRONMENT_KEYS.has(key)) continue
    guestEnvironment[key] = await map(value)
  }

  const bwrap = [
    '/usr/bin/bwrap',
    '--die-with-parent',
    '--new-session',
    // Includes a fresh network namespace. Issue 06 deliberately has no gateway bridge.
    '--unshare-all',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/',
    '/',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/home',
    '--tmpfs',
    '/mnt',
    '--tmpfs',
    '/media',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/tmp/open-science-home',
    '--dev',
    '/dev',
    '--proc',
    '/proc'
  ]

  const coveredBySensitiveRoot = (path: string): boolean =>
    ['/home', '/mnt', '/media'].some((root) => path === root || path.startsWith(`${root}/`))
  const sensitiveRoots = unique([
    '/home',
    '/mnt',
    '/media',
    ...(privateRoot && !coveredBySensitiveRoot(privateRoot) ? [privateRoot] : [])
  ])
  const mountDestinations = unique([
    ...readOnlyRoots,
    ...readWriteRoots,
    ...explicitDeniedReadRoots,
    ...explicitDeniedWriteRoots
  ])
  const visibleParents = unique(mountDestinations.flatMap(mountParents)).filter(
    (parent) => parent !== '/home' && parent !== '/mnt' && parent !== '/media'
  )
  for (const parent of visibleParents) bwrap.push('--dir', parent)
  for (const root of readWriteRoots) bwrap.push('--dir', root)
  for (const root of explicitDeniedReadRoots) bwrap.push('--dir', root)
  for (const root of readOnlyRoots) bwrap.push('--ro-bind', root, root)
  for (const root of sensitiveRoots) bwrap.push('--remount-ro', root)
  for (const root of readWriteRoots) bwrap.push('--bind', root, root)
  for (const root of explicitDeniedWriteRoots) bwrap.push('--ro-bind', root, root)
  for (const root of explicitDeniedReadRoots) bwrap.push('--tmpfs', root)
  bwrap.push('--clearenv')
  for (const [key, value] of Object.entries(guestEnvironment)) {
    bwrap.push('--setenv', key, value)
  }
  bwrap.push('--chdir', cwd, '--', '/bin/bash', '--noprofile', '--norc', '-c', request.command)

  const hostEnvironment: NodeJS.ProcessEnv = {}
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (systemRoot) {
    hostEnvironment.SystemRoot = systemRoot
    hostEnvironment.WINDIR = systemRoot
  }
  return {
    argv: [
      wslExecutable(),
      '--distribution',
      request.target.distro,
      '--user',
      request.target.user,
      '--exec',
      ...bwrap
    ],
    env: hostEnvironment,
    release: async () => undefined
  }
}

export { wsl2Launch }
export type { Wsl2Launch, Wsl2LaunchRequest, Wsl2PathMapper, Wsl2Target }
