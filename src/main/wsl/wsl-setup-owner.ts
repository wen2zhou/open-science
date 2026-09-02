import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type {
  SelectWslProfileRequest,
  WslDistro,
  WslReadiness,
  WslSelection,
  WslSetupSnapshot,
  WslSetupState
} from '../../shared/wsl-setup'
import { createLogger } from '../logger'
import type { WindowsVolumeProbeResult } from './windows-volume-probe'

export type WslCommandResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
  failure?: 'not-found' | 'timeout'
}>

export interface WslCommandRunner {
  run(args: readonly string[]): Promise<WslCommandResult>
}

type WslSetupOwnerOptions = Readonly<{
  runner?: WslCommandRunner
  workspacePath: string | (() => string)
  volumeProbe(path: string): Promise<WindowsVolumeProbeResult>
  readSelection(): Promise<WslSelection | undefined>
  writeSelection(selection: WslSelection): Promise<unknown>
  operationReference?: () => string
  log?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>
}>

const executeWsl: WslCommandRunner = {
  run: (args) =>
    new Promise((resolve) => {
      execFile(
        'wsl.exe',
        [...args],
        { windowsHide: true, timeout: 15_000, encoding: 'buffer' },
        (error, stdout, stderr) => {
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: unknown })?.code === 'number'
              ? ((error as NodeJS.ErrnoException & { code: number }).code ?? 1)
              : error
                ? 1
                : 0
          const decode = (value: Buffer): string => {
            const sample = value.subarray(0, Math.min(value.length, 64))
            const nullBytes = [...sample].filter((byte) => byte === 0).length
            return value.toString(nullBytes > sample.length / 4 ? 'utf16le' : 'utf8')
          }
          const code = (error as NodeJS.ErrnoException | null)?.code
          resolve({
            stdout: decode(stdout),
            stderr: decode(stderr),
            exitCode,
            ...(code === 'ENOENT'
              ? { failure: 'not-found' as const }
              : (error as (NodeJS.ErrnoException & { killed?: boolean }) | null)?.killed
                ? { failure: 'timeout' as const }
                : {})
          })
        }
      )
    })
}

const clean = (value: string): string => value.replaceAll('\0', '').replaceAll('\r', '').trim()

export const parseWslDistros = (output: string): WslDistro[] => {
  const distros: WslDistro[] = []
  for (const rawLine of clean(output).split('\n')) {
    const line = rawLine.trim()
    if (!line || /^NAME\s+STATE\s+VERSION$/i.test(line)) continue
    // State and the table header are localized by Windows; the version is the stable final column.
    const match = line.match(/^(\*)?\s*(.+?)\s+\S+\s+([12])$/i)
    if (!match) continue
    distros.push({
      name: match[2].trim(),
      version: Number(match[3]) as 1 | 2,
      isDefault: !!match[1]
    })
  }
  return distros
}

const setupSnapshot = (
  state: WslSetupState,
  operationReference: string,
  distros: readonly WslDistro[] = [],
  extra: Partial<Omit<WslSetupSnapshot, 'state' | 'operationReference' | 'distros'>> = {}
): WslSetupSnapshot => ({ state, operationReference, distros, ...extra })

const platformFailure = (output: string): { state: WslSetupState; code: string } => {
  if (/restart|reboot/i.test(output))
    return { state: 'restart-required', code: 'wsl_restart_required' }
  if (/not installed|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(output)) {
    return { state: 'not-installed', code: 'wsl_not_installed' }
  }
  return { state: 'failed', code: 'wsl_probe_failed' }
}

export class WslSetupOwner {
  private readonly runner: WslCommandRunner
  private readonly log: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>

  constructor(private readonly options: WslSetupOwnerOptions) {
    this.runner = options.runner ?? executeWsl
    this.log = options.log ?? createLogger('wsl-setup')
  }

  async select(request: SelectWslProfileRequest): Promise<WslSetupSnapshot> {
    const selection = { distro: request.distro.trim(), user: request.user.trim() }
    if (
      !selection.distro ||
      !selection.user ||
      selection.distro.length > 256 ||
      selection.user.length > 128 ||
      /[\0\r\n]/.test(selection.distro) ||
      /[\0\r\n]/.test(selection.user)
    ) {
      return setupSnapshot('failed', this.reference(), [], { errorCode: 'wsl_selection_invalid' })
    }
    await this.options.writeSelection(selection)
    return this.probe(selection)
  }

  async probe(selectionOverride?: WslSelection): Promise<WslSetupSnapshot> {
    const startedAt = Date.now()
    const operationReference = this.reference()
    this.log.info('wsl probe started', { operationReference })
    let snapshot: WslSetupSnapshot
    try {
      snapshot = await this.runProbe(operationReference, selectionOverride)
    } catch {
      snapshot = setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_probe_failed' })
    }
    const fields = {
      operationReference,
      state: snapshot.state,
      errorCode: snapshot.errorCode,
      durationMs: Date.now() - startedAt
    }
    if (snapshot.state === 'ready') this.log.info('wsl probe completed', fields)
    else this.log.warn('wsl probe completed', fields)
    return snapshot
  }

  private async runProbe(
    operationReference: string,
    selectionOverride?: WslSelection
  ): Promise<WslSetupSnapshot> {
    const status = await this.runner.run(['--status'])
    if (status.exitCode !== 0) {
      if (status.failure === 'not-found') {
        return setupSnapshot('not-installed', operationReference, [], {
          errorCode: 'wsl_not_installed'
        })
      }
      const failure = platformFailure(`${status.stdout}\n${status.stderr}`)
      if (failure.state !== 'failed') {
        return setupSnapshot(failure.state, operationReference, [], { errorCode: failure.code })
      }
      const version = await this.runner.run(['--version'])
      if (version.exitCode === 0) {
        return setupSnapshot('restart-required', operationReference, [], {
          errorCode: 'wsl_restart_required'
        })
      }
      return setupSnapshot(failure.state, operationReference, [], { errorCode: failure.code })
    }

    const listed = await this.runner.run(['--list', '--verbose'])
    if (listed.exitCode !== 0) {
      return setupSnapshot('failed', operationReference, [], { errorCode: 'wsl_probe_failed' })
    }
    const distros = parseWslDistros(listed.stdout)
    if (distros.length === 0) {
      return setupSnapshot('distro-required', operationReference, [], {
        errorCode: 'wsl_distro_missing'
      })
    }

    const selection = selectionOverride ?? (await this.options.readSelection())
    if (!selection) return setupSnapshot('distro-required', operationReference, distros)
    const distro = distros.find((candidate) => candidate.name === selection.distro)
    if (!distro) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        errorCode: 'wsl_distro_not_found'
      })
    }
    if (distro.version !== 2) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness(),
        errorCode: 'wsl1_unsupported'
      })
    }
    const workspacePath = this.workspacePath()
    if (!/^[A-Za-z]:\\/.test(workspacePath) || workspacePath.startsWith('\\\\')) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true }),
        errorCode: 'wsl_workspace_path_unsupported'
      })
    }
    const volume = await this.options.volumeProbe(workspacePath)
    if (volume.kind !== 'local-ntfs') {
      const errorCode =
        volume.kind === 'not-local'
          ? 'wsl_workspace_not_local'
          : volume.kind === 'not-ntfs'
            ? 'wsl_workspace_not_ntfs'
            : 'wsl_workspace_volume_unavailable'
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, localWorkspace: false }),
        errorCode
      })
    }

    const identity = await this.inGuest(selection, ['sh', '-lc', 'id -u; id -un'])
    const identityOutput = clean(identity.stdout)
    if (identity.exitCode !== 0) {
      // Retrying with the distro's default user distinguishes an uninitialized distro from an
      // invalid explicit username without interpreting localized wsl.exe error prose.
      const defaultIdentity = await this.runner.run([
        '--distribution',
        selection.distro,
        '--exec',
        'id',
        '-u'
      ])
      const firstLaunchRequired = defaultIdentity.exitCode !== 0
      return setupSnapshot(
        firstLaunchRequired ? 'first-launch-required' : 'failed',
        operationReference,
        distros,
        {
          selection,
          readiness: this.readiness({ wsl2: true }),
          errorCode: firstLaunchRequired ? 'wsl_first_launch_required' : 'wsl_user_not_found'
        }
      )
    }
    const [uid, actualUser] = identityOutput.split('\n')
    if (uid === '0') {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true }),
        errorCode: 'wsl_root_user'
      })
    }
    if (actualUser !== selection.user) {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true }),
        errorCode: 'wsl_user_mismatch'
      })
    }

    const dependencies = await this.inGuest(selection, [
      'sh',
      '-lc',
      'command -v bash; command -v bwrap'
    ])
    const dependencyOutput = clean(dependencies.stdout)
    const bash = /(^|\n)\/[^\n]*bash(\n|$)/.test(dependencyOutput)
    const bwrap = /(^|\n)\/[^\n]*bwrap(\n|$)/.test(dependencyOutput)
    if (!bash || !bwrap) {
      return setupSnapshot('dependency-required', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, bash, bwrap }),
        errorCode: bash ? 'wsl_bwrap_missing' : 'wsl_bash_missing'
      })
    }

    const namespaces = await this.inGuest(selection, [
      'bash',
      '-lc',
      'bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true && printf ok'
    ])
    if (namespaces.exitCode !== 0 || clean(namespaces.stdout) !== 'ok') {
      return setupSnapshot('dependency-required', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, bash: true, bwrap: true }),
        errorCode: 'wsl_namespace_unavailable'
      })
    }

    const workspace = await this.inGuest(selection, [
      'bash',
      '-lc',
      'guest_path=$(wslpath -u "$1") && printf "%s\\n" "$guest_path" && test -d "$guest_path" && printf ok',
      '--',
      workspacePath
    ])
    const workspaceLines = clean(workspace.stdout).split('\n')
    if (workspace.exitCode !== 0 || workspaceLines.at(-1) !== 'ok') {
      return setupSnapshot('failed', operationReference, distros, {
        selection,
        readiness: this.readiness({ wsl2: true, bash: true, bwrap: true, namespaces: true }),
        errorCode: 'wsl_workspace_unreachable'
      })
    }

    return setupSnapshot('ready', operationReference, distros, {
      selection,
      readiness: this.readiness({
        wsl2: true,
        bash: true,
        bwrap: true,
        namespaces: true,
        localWorkspace: true
      })
    })
  }

  private inGuest(selection: WslSelection, command: readonly string[]): Promise<WslCommandResult> {
    return this.runner.run([
      '--distribution',
      selection.distro,
      '--user',
      selection.user,
      '--exec',
      ...command
    ])
  }

  private readiness(ready: Partial<WslReadiness> = {}): WslReadiness {
    return ready
  }

  private workspacePath(): string {
    return typeof this.options.workspacePath === 'function'
      ? this.options.workspacePath()
      : this.options.workspacePath
  }

  private reference(): string {
    return (this.options.operationReference?.() ?? randomUUID()).replaceAll('-', '').slice(0, 8)
  }
}
