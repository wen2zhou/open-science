import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'

import type { FilesystemLayoutInput } from './filesystem-layout.js'
import { assertWsl2BashDevelopmentEnabled } from '../wsl2-development-gate.js'

type Wsl2Target = Readonly<{
  kind: 'wsl2'
  profileId: string
  distro: string
  user: string
}>

type Wsl2PathMapper = (path: string) => Promise<string>
type Wsl2CleanupReason = 'exit' | 'cancel' | 'timeout' | 'spawn-failed'

type Wsl2GuestCleanupRequest = Readonly<{
  distro: string
  user: string
  receipt: string
  token: string
  reason: Wsl2CleanupReason
}>

type Wsl2GuestCleanup = (request: Wsl2GuestCleanupRequest) => Promise<boolean>

type Wsl2LaunchRequest = Readonly<{
  target: Wsl2Target
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  pathEnvironment?: NodeJS.ProcessEnv
  filesystem: FilesystemLayoutInput
  mapPath?: Wsl2PathMapper
  cleanupGuest?: Wsl2GuestCleanup
}>

type Wsl2Launch = Readonly<{
  argv: string[]
  env: NodeJS.ProcessEnv
  release: (reason?: Wsl2CleanupReason) => Promise<boolean>
}>

const MAX_CLEANUP_CAPTURE_BYTES = 64 * 1024
const GUEST_CLEANUP_TIMEOUT_MS = 8_000

const executionWrapperScript = String.raw`
receipt=$1; token=$2; shift 2
umask 077
printf 'v1 %s\n' "$token" > "$receipt.tmp" || exit 71
mv -f -- "$receipt.tmp" "$receipt" || exit 71
export OPEN_SCIENCE_WSL_EXECUTION_TOKEN="$token"
exec "$@"
`

// Every process launched below bwrap inherits the unguessable token. Cleanup scans the guest
// process table for that exact environment marker, freezes the matches so they cannot fork, and
// signals only identities whose PID start time and token still match. The distribution stays up.
const exactExecutionCleanupScript = String.raw`
receipt=$1; token=$2
i=0
while [ ! -r "$receipt" ] && [ "$i" -lt 40 ]; do
  i=$((i + 1)); sleep 0.05
done
[ -r "$receipt" ] || exit 3
IFS=' ' read -r version recorded_token < "$receipt" || exit 4
[ "$version" = v1 ] && [ "$recorded_token" = "$token" ] || exit 4
marker="OPEN_SCIENCE_WSL_EXECUTION_TOKEN=$token"
identities=
known=' '
capture() {
  capture_found=0
  for environment in /proc/[0-9]*/environ; do
    [ -r "$environment" ] || continue
    tr '\0' '\n' < "$environment" 2>/dev/null | grep -Fqx "$marker" || continue
    target_pid=${'$'}{environment#/proc/}; target_pid=${'$'}{target_pid%/environ}
    case "$known" in *" $target_pid "*) continue;; esac
    target_start=$(awk '{print $22}' "/proc/$target_pid/stat" 2>/dev/null) || continue
    case "$target_pid:$target_start" in *[!0-9:]*) exit 6;; esac
    kill -STOP -- "$target_pid" 2>/dev/null || continue
    retry=0
    while [ "$retry" -lt 25 ]; do
      state=$(awk '{print $3}' "/proc/$target_pid/stat" 2>/dev/null) || break
      [ "$state" = T ] || [ "$state" = t ] || { retry=$((retry + 1)); sleep 0.01; continue; }
      current_start=$(awk '{print $22}' "/proc/$target_pid/stat" 2>/dev/null) || break
      [ "$current_start" = "$target_start" ] || exit 6
      identities="$identities $target_pid:$target_start"
      known="$known$target_pid "
      capture_found=1
      break
    done
  done
}
i=0
while [ "$i" -lt 5 ]; do
  capture || exit $?
  [ "$capture_found" -eq 0 ] && break
  i=$((i + 1))
done
verify() {
  verify_pid=$1; verify_start=$2
  [ -r "/proc/$verify_pid/stat" ] || return 1
  [ "$(awk '{print $3}' "/proc/$verify_pid/stat" 2>/dev/null)" != Z ] || return 1
  [ "$(awk '{print $22}' "/proc/$verify_pid/stat" 2>/dev/null)" = "$verify_start" ] || return 1
  tr '\0' '\n' < "/proc/$verify_pid/environ" 2>/dev/null | grep -Fqx "$marker" || return 2
}
signal_all() {
  requested_signal=$1
  for identity in $identities; do
    IFS=: read -r member_pid member_start <<EOF
$identity
EOF
    verify "$member_pid" "$member_start"; verified=$?
    [ "$verified" -eq 1 ] && continue
    [ "$verified" -eq 0 ] || return 6
    kill "-$requested_signal" -- "$member_pid" 2>/dev/null || return 7
  done
}
signal_all TERM || exit $?
signal_all CONT || exit $?
sleep 0.25
signal_all KILL || exit $?
i=0
while [ "$i" -lt 30 ]; do
  alive=0
  for identity in $identities; do
    IFS=: read -r member_pid member_start <<EOF
$identity
EOF
    verify "$member_pid" "$member_start"; verified=$?
    [ "$verified" -eq 0 ] && alive=1
    [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || exit 6
  done
  [ "$alive" -eq 0 ] && break
  i=$((i + 1)); sleep 0.1
done
[ "${'$'}{alive:-0}" -eq 0 ] || exit 5
rm -f -- "$receipt" "$receipt.tmp" || exit 8
`

const WINDOWS_PATH = /^[a-z]:[\\/]/iu
const SAFE_USER = /^[a-z_][a-z0-9_-]*[$]?$/u
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

const defaultCleanupGuest: Wsl2GuestCleanup = ({ distro, user, receipt, token }) =>
  new Promise((resolve) => {
    execFile(
      wslExecutable(),
      [
        '--distribution',
        distro,
        '--user',
        user,
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        exactExecutionCleanupScript,
        'open-science-wsl-cleanup',
        receipt,
        token
      ],
      {
        encoding: 'buffer',
        maxBuffer: MAX_CLEANUP_CAPTURE_BYTES,
        timeout: GUEST_CLEANUP_TIMEOUT_MS,
        windowsHide: true
      },
      (error) => resolve(!error)
    )
  })

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
  assertWsl2BashDevelopmentEnabled()
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
  const token = `open-science-execution-${randomUUID()}`
  const receipt = `/tmp/.open-science-execution-${token.slice('open-science-execution-'.length)}.receipt`
  guestEnvironment.OPEN_SCIENCE_WSL_EXECUTION_TOKEN = token
  const hostContains = (parent: string, child: string): boolean => {
    const relative = win32.relative(parent, child)
    return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative))
  }
  for (const [key, value] of Object.entries(request.pathEnvironment ?? {})) {
    if (!value) continue
    if (Object.hasOwn(guestEnvironment, key)) {
      throw new Error('WSL2 sandbox path environment key is reserved.')
    }
    if (
      !WINDOWS_PATH.test(value) ||
      !request.filesystem.readWriteRoots.some((root) => hostContains(root, value))
    ) {
      throw new Error('WSL2 sandbox path environment is not writable.')
    }
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
  let releasePromise: Promise<boolean> | undefined
  return {
    argv: [
      wslExecutable(),
      '--distribution',
      request.target.distro,
      '--user',
      request.target.user,
      '--exec',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      executionWrapperScript,
      'open-science-wsl-execution',
      receipt,
      token,
      ...bwrap
    ],
    env: hostEnvironment,
    release: (reason = 'exit') =>
      (releasePromise ??= (request.cleanupGuest ?? defaultCleanupGuest)({
        distro: request.target.distro,
        user: request.target.user,
        receipt,
        token,
        reason
      }))
  }
}

export { wsl2Launch }
export type {
  Wsl2GuestCleanup,
  Wsl2GuestCleanupRequest,
  Wsl2Launch,
  Wsl2LaunchRequest,
  Wsl2PathMapper,
  Wsl2Target
}
