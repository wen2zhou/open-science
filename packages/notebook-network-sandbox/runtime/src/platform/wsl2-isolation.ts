import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import type { FilesystemLayoutInput } from './filesystem-layout.js'
import type { GatewayCredentials } from '../gateway/command-gateway.js'
import { assertWsl2BashDevelopmentEnabled } from '../wsl2-development-gate.js'

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
  pathEnvironment?: NodeJS.ProcessEnv
  filesystem: FilesystemLayoutInput
  gatewayPort?: number
  gatewayCredentials?: GatewayCredentials
  mapPath?: Wsl2PathMapper
  openBridge?: Wsl2GatewayBridgeOpener
}>

type Wsl2Launch = Readonly<{
  argv: string[]
  env: NodeJS.ProcessEnv
  release: () => Promise<void>
}>

type Wsl2GatewayBridge = Readonly<{
  socketPath: string
  close: () => Promise<void>
}>

type Wsl2GatewayBridgeOpener = (request: {
  target: Wsl2Target
  gatewayPort: number
}) => Promise<Wsl2GatewayBridge>

const WINDOWS_PATH = /^[a-z]:[\\/]/iu
const SAFE_USER = /^[a-z_][a-z0-9_-]*[$]?$/u
const wslExecutable = (): string =>
  win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wsl.exe')

const bridgeProgram = String.raw`
import os, socket, sys, threading
socket_path, port_text = sys.argv[1:]
directory = os.path.dirname(socket_path)
os.makedirs(directory, mode=0o700, exist_ok=False)
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
peers = set()
stopping = threading.Event()
def close_all():
    stopping.set()
    try: listener.close()
    except OSError: pass
    for peer in list(peers):
        try: peer.close()
        except OSError: pass
def watch_owner():
    sys.stdin.buffer.read()
    close_all()
threading.Thread(target=watch_owner, daemon=True).start()
try:
    listener.bind(socket_path)
    os.chmod(socket_path, 0o600)
    listener.listen(32)
    listener.settimeout(0.5)
    print('OPEN_SCIENCE_WSL_GATEWAY_READY', flush=True)
    while not stopping.is_set():
        try: client, _ = listener.accept()
        except socket.timeout: continue
        except OSError: break
        try: upstream = socket.create_connection(('127.0.0.1', int(port_text)), timeout=5)
        except OSError:
            client.close()
            continue
        peers.update((client, upstream))
        def relay(source, target):
            try:
                while True:
                    data = source.recv(65536)
                    if not data: break
                    target.sendall(data)
            except OSError: pass
            try: target.shutdown(socket.SHUT_WR)
            except OSError: pass
        threading.Thread(target=relay, args=(client, upstream), daemon=True).start()
        threading.Thread(target=relay, args=(upstream, client), daemon=True).start()
finally:
    close_all()
    try: os.unlink(socket_path)
    except FileNotFoundError: pass
    try: os.rmdir(directory)
    except OSError: pass
`

const sandboxGatewayProgram = String.raw`
import os, signal, socket, subprocess, sys, threading, urllib.parse
socket_path, port_text, username, password, command = sys.argv[1:]
peers = set()
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', int(port_text)))
listener.listen(32)
listener.settimeout(0.5)
stopping = threading.Event()
def relay(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data: break
            target.sendall(data)
    except OSError: pass
    try: target.shutdown(socket.SHUT_WR)
    except OSError: pass
def accept_connections():
    while not stopping.is_set():
        try: client, _ = listener.accept()
        except socket.timeout: continue
        except OSError: break
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try: upstream.connect(socket_path)
        except OSError:
            client.close(); upstream.close(); continue
        peers.update((client, upstream))
        threading.Thread(target=relay, args=(client, upstream), daemon=True).start()
        threading.Thread(target=relay, args=(upstream, client), daemon=True).start()
threading.Thread(target=accept_connections, daemon=True).start()
authority = f'{urllib.parse.quote(username)}:{urllib.parse.quote(password)}@127.0.0.1:{port_text}'
http_proxy = f'http://{authority}'
socks_proxy = f'socks5h://{authority}'
child_env = dict(os.environ)
for key in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','GRPC_PROXY','grpc_proxy','DOCKER_HTTP_PROXY','DOCKER_HTTPS_PROXY'):
    child_env[key] = http_proxy
for key in ('FTP_PROXY','ftp_proxy'):
    child_env[key] = socks_proxy
child_env.update({'NO_PROXY':'','no_proxy':'','CLOUDSDK_PROXY_TYPE':'http','CLOUDSDK_PROXY_ADDRESS':'127.0.0.1','CLOUDSDK_PROXY_PORT':port_text,'CLOUDSDK_PROXY_USERNAME':username,'CLOUDSDK_PROXY_PASSWORD':password})
child = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-c', command], env=child_env)
def forward(signum, _frame):
    try: child.send_signal(signum)
    except ProcessLookupError: pass
for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(signum, forward)
status = child.wait()
stopping.set()
listener.close()
for peer in list(peers):
    try: peer.close()
    except OSError: pass
raise SystemExit(status)
`

const compressedPython = (program: string): string =>
  `import base64,zlib;exec(zlib.decompress(base64.b64decode('${deflateRawSync(program).toString('base64')}'),-15))`

const sandboxGatewayLauncher = compressedPython(sandboxGatewayProgram)

const sanitizedHostEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (systemRoot) {
    env.SystemRoot = systemRoot
    env.WINDIR = systemRoot
  }
  return env
}

const waitForBridgeReady = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderrBytes = 0
    const timer = setTimeout(
      () => finish(new Error('WSL2 network bridge did not become ready.')),
      5_000
    )
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onStdout = (chunk: Buffer): void => {
      stdout = (stdout + chunk.toString('utf8')).slice(-128)
      if (stdout.includes('OPEN_SCIENCE_WSL_GATEWAY_READY\n')) finish()
    }
    const onStderr = (chunk: Buffer): void => {
      stderrBytes += chunk.length
      if (stderrBytes > 64 * 1024)
        finish(new Error('WSL2 network bridge output exceeded its limit.'))
    }
    const onError = (): void => finish(new Error('WSL2 network bridge could not start.'))
    const onExit = (): void => finish(new Error('WSL2 network bridge exited before ready.'))
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })

const closeBridgeProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.stdin.end()
  const closed = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))
  ])
  if (!closed) {
    child.kill()
    throw new Error('WSL2 network bridge cleanup was incomplete.')
  }
}

const openWsl2GatewayBridge: Wsl2GatewayBridgeOpener = async ({ target, gatewayPort }) => {
  const socketPath = `/tmp/open-science-network-${randomUUID()}/gateway.sock`
  const child = spawn(
    wslExecutable(),
    [
      '--distribution',
      target.distro,
      '--user',
      target.user,
      '--exec',
      '/usr/bin/python3',
      '-c',
      bridgeProgram,
      socketPath,
      String(gatewayPort)
    ],
    { env: sanitizedHostEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  try {
    await waitForBridgeReady(child)
  } catch (error) {
    child.stdin.end()
    child.kill()
    throw error
  }
  return { socketPath, close: () => closeBridgeProcess(child) }
}

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

  if (!request.gatewayPort || !request.gatewayCredentials) {
    throw new Error('WSL2 network gateway is unavailable.')
  }
  const bridge = await (request.openBridge ?? openWsl2GatewayBridge)({
    target: request.target,
    gatewayPort: request.gatewayPort
  })

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
    '--dir',
    '/run/open-science-notebook',
    '--bind',
    bridge.socketPath,
    '/run/open-science-notebook/gateway.sock',
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
  bwrap.push(
    '--chdir',
    cwd,
    '--',
    '/usr/bin/python3',
    '-c',
    sandboxGatewayLauncher,
    '/run/open-science-notebook/gateway.sock',
    '3128',
    request.gatewayCredentials.username,
    request.gatewayCredentials.password,
    request.command
  )

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
    env: sanitizedHostEnvironment(),
    release: () => bridge.close()
  }
}

export { openWsl2GatewayBridge, wsl2Launch }
export type {
  Wsl2GatewayBridge,
  Wsl2GatewayBridgeOpener,
  Wsl2Launch,
  Wsl2LaunchRequest,
  Wsl2PathMapper,
  Wsl2Target
}
