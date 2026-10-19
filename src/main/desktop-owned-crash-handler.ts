import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

const OWNER_ANNOTATION = 'open_science_desktop_owner'
type ProcessIdentity = { pid: number; birth: string; bornAt: number; command: string }
type Inspection = {
  readProcesses(): string
  mappedFiles(pid: number): string[]
  canonical(path: string): string
  now(): number
}

const commandOutput = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (result.error || result.signal || result.status !== 0)
    throw new Error('Desktop crash handler ownership could not be inspected.')
  return result.stdout
}
const nativeInspection: Inspection = {
  readProcesses: () => commandOutput('/bin/ps', ['-axo', 'pid=,lstart=,command=']),
  mappedFiles: (pid) =>
    commandOutput('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', 'txt', '-Fn'])
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1)),
  canonical: realpathSync,
  now: Date.now
}

const processes = (text: string): ProcessIdentity[] =>
  text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
      line
    )
    if (!match) return []
    const pid = Number(match[1])
    const bornAt = Date.parse(match[2])
    return Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(bornAt)
      ? [{ pid, birth: match[2], bornAt, command: match[3] }]
      : []
  })

/**
 * Crashpad daemonizes on macOS and is absent from app.getAppMetrics(). Bind only this
 * Desktop's handler; never exempt a process by name, shared profile, or installation alone.
 * Electron globalExtra becomes handler --annotation arguments (Electron v43
 * electron_api_crash_reporter.cc / ElectronCrashReporterClient::SetGlobalAnnotations).
 */
export function createDesktopOwnedCrashHandler(
  options: {
    resourcesPath: string
    profilePath: string
    crashDatabasePath: string
    platform?: NodeJS.Platform
  },
  inspection: Inspection = nativeInspection
): { globalExtra: Record<string, string>; allowedProcessIds(): number[] } {
  const owner = randomUUID()
  const startedAt = Math.floor(inspection.now() / 1000) * 1000
  const handler = join(
    options.resourcesPath,
    '../Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
  )
  const globalExtra = Object.freeze({ [OWNER_ANNOTATION]: owner })
  let accepted: Pick<ProcessIdentity, 'pid' | 'birth'> | undefined
  return {
    globalExtra,
    allowedProcessIds: () => {
      if ((options.platform ?? process.platform) !== 'darwin') return []
      try {
        const canonicalHandler = inspection.canonical(handler)
        const canonicalProfile = inspection.canonical(options.profilePath)
        const canonicalDatabase = inspection.canonical(options.crashDatabasePath)
        const within = relative(canonicalProfile, canonicalDatabase)
        if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
          return []
        // ps does not preserve argv boundaries. Admit only the known fixed executable prefix,
        // then split at Crashpad's option boundaries; ambiguous paths/options fail closed.
        if ([handler, options.crashDatabasePath].some((path) => /[\r\n]| --/.test(path))) return []
        const matches = (row: ProcessIdentity): boolean => {
          if (!row.command.startsWith(`${handler} --`) || row.bornAt < startedAt) return false
          if (row.bornAt > inspection.now()) return false
          const args = row.command.slice(handler.length + 1).split(' --')
          const value = (key: string): string | undefined => {
            const prefix = `${key}=`
            const values = args
              .map((arg) => arg.replace(/^--/, ''))
              .filter((arg) => arg.startsWith(prefix))
            return values.length === 1 ? values[0].slice(prefix.length) : undefined
          }
          return (
            value('database') === options.crashDatabasePath &&
            value(`annotation=${OWNER_ANNOTATION}`) === owner
          )
        }
        const candidates = processes(inspection.readProcesses()).filter(matches)
        if (candidates.length !== 1) return []
        const candidate = candidates[0]
        if (accepted && (accepted.pid !== candidate.pid || accepted.birth !== candidate.birth))
          return []
        if (
          !inspection.mappedFiles(candidate.pid).some((path) => {
            try {
              return inspection.canonical(path) === canonicalHandler
            } catch {
              return false
            }
          })
        )
          return []
        // Recheck after the mapping query so a reused PID cannot inherit an earlier allowance.
        const current = processes(inspection.readProcesses()).filter(matches)
        if (
          current.length !== 1 ||
          current[0].pid !== candidate.pid ||
          current[0].birth !== candidate.birth
        )
          return []
        accepted = { pid: candidate.pid, birth: candidate.birth }
        return [candidate.pid]
      } catch {
        // No exemption on missing files, process exit, permission failure or malformed output.
        // The ordinary occupancy inspection still rejects every unproven process.
        return []
      }
    }
  }
}
