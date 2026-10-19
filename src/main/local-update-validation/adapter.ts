import {
  appendFileSync,
  createReadStream,
  readFileSync,
  realpathSync,
  lstatSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { app, session } from 'electron'
import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { findFile } from 'electron-updater/out/providers/Provider'
import { ElectronUpdaterStrategy } from '../update/electron-updater-strategy'
import type { CreateStrategyOptions } from '../update/create-strategy'
import type { UpdateStatus } from '../../shared/update'
import { UpdateLifecycleError } from '../../shared/update'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { RuntimeStartupOptions } from '../desktop-runtime-info'
import { assertLocalUpdateUrl, readLocalUpdateValidationConfig } from './config'
import { verifyLocalUpdateCredentialScope } from './credentials'
import {
  prepareSupervisedMacInstallation,
  type PreparedMacInstallation
} from '../update/installation-executor'
import type { DesktopRuntimeClient } from '../desktop-runtime-client'

export function localRuntimeRecoveryEvidence(
  client: DesktopRuntimeClient,
  endpoint: { port: number },
  version: string
): Record<string, unknown> {
  if (
    client.startupState().phase !== 'ready' ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    throw new Error('Recovered service endpoint is not ready.')
  return {
    pid: client.processId(),
    generation: client.runtimeInfo().generation,
    ready: true,
    serviceReady: true,
    port: endpoint.port,
    version,
    dataRoot: client.runtimeInfo().startupOptions.dataRoot
  }
}

// AppUpdater owns the same provider discovery, streaming download and SHA512 verification used by
// MacUpdater. Its native Squirrel bridge normally starts during download; omit that bridge entirely.
export class LocalMacDownloadUpdater extends AppUpdater {
  lastDownloadUsedNetwork = false
  private readonly downloadExecutor = new ElectronHttpExecutor()
  constructor(feedUrl: string, cacheRoot: string, metadata: string) {
    super({ provider: 'generic', url: feedUrl, useMultipleRangeRequest: false })
    Object.defineProperties(this.app, {
      baseCachePath: { value: cacheRoot },
      appUpdateConfigPath: { value: metadata }
    })
  }
  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    this.lastDownloadUsedNetwork = false
    const { info, provider } = options.updateInfoAndProvider
    const file = findFile(provider.resolveFiles(info), 'zip', ['pkg', 'dmg'])
    if (!file) throw new Error('The local macOS feed has no ZIP artifact.')
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: file,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        const result = await this.downloadExecutor.download(file.url, destination, downloadOptions)
        this.lastDownloadUsedNetwork = true
        return result
      },
      done: async (event) => this.dispatchUpdateDownloaded(event)
    })
  }
  quitAndInstall(): never {
    throw new Error('Native installation is disabled in this validation build.')
  }
}

export type LocalUpdateValidation = {
  config: ReturnType<typeof readLocalUpdateValidationConfig>
  record(type: string, fields?: Record<string, unknown>): void
  assertConfiguration(startup: RuntimeStartupOptions): void
  prepareInstallation(status: UpdateStatus, signal?: AbortSignal): Promise<PreparedMacInstallation>
  runtimeStarted(client: DesktopRuntimeClient, endpoint: { port: number }): void
  runtimeStopped(fields: Record<string, unknown>): void
  runtimeRecovered(client: DesktopRuntimeClient, endpoint: { port: number }): void
  createStrategy(options: CreateStrategyOptions): ElectronUpdaterStrategy
}

export function initializeLocalUpdateValidation(path: string): LocalUpdateValidation {
  if (process.platform !== 'darwin' || !app.isPackaged)
    throw new Error('Local update validation requires a packaged macOS test build.')
  const config = readLocalUpdateValidationConfig(path)
  const credentialScope = verifyLocalUpdateCredentialScope(config)
  const settingsPath = join(config.configRoot, 'settings.json')
  if (JSON.parse(readFileSync(settingsPath, 'utf8')).dataRoot !== config.dataRoot)
    throw new Error(
      'The local validation fixture must select its isolated data root before startup.'
    )
  app.setPath('home', config.homeRoot)
  process.env.HOME = config.homeRoot
  process.env.OPEN_SCIENCE_CONFIG_ROOT = config.configRoot
  process.env.OPEN_SCIENCE_USER_DATA = config.userDataRoot
  // The backend inherits the exact isolated roots; its persisted settings select dataRoot.
  const record = (type: string, fields: Record<string, unknown> = {}): void => {
    appendFileSync(
      config.eventsPath,
      JSON.stringify({
        schema: 1,
        type,
        at: new Date().toISOString(),
        runId: config.runId,
        scenario: config.scenario,
        ...fields
      }) + '\n',
      { mode: 0o600 }
    )
  }
  record('credential-scope-verified', credentialScope)
  const installationRoot = resolve(dirname(app.getPath('exe')), '../..')
  if (
    installationRoot !== join(config.runRoot, 'apps', 'Open-Science.app') ||
    realpathSync(installationRoot) !== installationRoot
  )
    throw new Error('Validation application must run from its owned installation directory.')
  record('application-started', { pid: process.pid, version: app.getVersion(), installationRoot })
  app.once('quit', () => record('application-quit', { pid: process.pid }))
  const assertConfiguration = (startup: RuntimeStartupOptions): void => {
    if (
      startup.configRoot !== config.configRoot ||
      startup.profilePath !== config.userDataRoot ||
      startup.dataRoot !== config.dataRoot
    )
      throw new Error('Runtime roots do not match the isolated local validation configuration.')
  }
  let stopped: Record<string, unknown> | undefined
  let verified: { localPath: string; artifactSha512: string } | undefined
  return {
    config,
    record,
    assertConfiguration,
    async prepareInstallation(status, signal): Promise<PreparedMacInstallation> {
      if (
        config.installBehavior !== 'upgrade' ||
        !status.localPath ||
        !status.latest ||
        !verified ||
        verified.localPath !== status.localPath ||
        verified.artifactSha512 !== status.artifactSha512
      )
        throw new Error('Real installation requires this run’s verified download.')
      const prepared = await prepareSupervisedMacInstallation({
        installationRoot,
        archive: status.localPath,
        targetVersion: status.latest,
        sha512: status.artifactSha512,
        signal,
        verifyPublisher: verifyLocalPublisher
      })
      record('installation-prepared', {
        directory: prepared.directory,
        stagedBundle: prepared.stagedBundle,
        installationRoot,
        targetVersion: status.latest,
        manifest: prepared.manifest
      })
      return prepared
    },
    runtimeStarted(client, endpoint): void {
      assertConfiguration(client.runtimeInfo().startupOptions)
      record('runtime-ready', {
        ...localRuntimeRecoveryEvidence(client, endpoint, app.getVersion()),
        desktopPid: process.pid,
        entryPath: client.runtimeInfo().entryPath,
        installationRoot
      })
    },
    runtimeStopped(fields: Record<string, unknown>): void {
      stopped = fields
      record('runtime-stopped', fields)
    },
    runtimeRecovered(client: DesktopRuntimeClient, endpoint: { port: number }): void {
      const fields = localRuntimeRecoveryEvidence(client, endpoint, app.getVersion())
      stopped = undefined
      record('runtime-recovered', fields)
    },
    createStrategy(options: CreateStrategyOptions): ElectronUpdaterStrategy {
      const origin = assertLocalUpdateUrl(config.feedUrl).origin
      // This partition belongs only to electron-updater. Check every request, including redirects.
      session
        .fromPartition('electron-updater', { cache: false })
        .webRequest.onBeforeRequest((details, callback) => {
          try {
            assertLocalUpdateUrl(details.url, origin)
            callback({ cancel: false })
          } catch {
            record('source-rejected', { url: details.url })
            callback({ cancel: true })
          }
        })
      const metadata = join(config.configRoot, 'local-update-validation-updater.yml')
      writeFileSync(metadata, 'updaterCacheDirName: local-update-validation\n', { mode: 0o600 })
      const updater = new LocalMacDownloadUpdater(config.feedUrl, config.updateCacheRoot, metadata)
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.disableDifferentialDownload = true
      updater.on('update-downloaded', (event) => {
        const match = event.files.filter((file) => file.url.split('?')[0].endsWith('.zip'))
        if (match.length === 1) {
          verified = { localPath: event.downloadedFile, artifactSha512: match[0].sha512 }
          record('download-verified', {
            ...verified,
            networkTransferred: updater.lastDownloadUsedNetwork,
            checksumAlgorithm: 'sha512'
          })
        }
      })
      return new ElectronUpdaterStrategy({
        ...options,
        updater,
        platform: 'darwin',
        manifestUrl: config.manifestUrl,
        fetchImpl: async (input, init) => {
          assertLocalUpdateUrl(String(input), origin)
          return fetch(input, { ...init, redirect: 'error' })
        },
        broadcast: (channel, payload) => {
          if (
            channel === 'update:status' &&
            ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(
              (payload as UpdateStatus).reason ?? ''
            )
          )
            record('runtime-stop-failed', { status: payload })
          record(
            channel === 'update:status' ? 'update-status' : 'update-progress',
            channel === 'update:status' ? { status: payload } : { progress: payload }
          )
          broadcastToRenderers(channel, payload)
        },
        beforeInstallHandoff: async (status: UpdateStatus) => {
          if (
            !stopped ||
            !verified ||
            status.localPath !== verified.localPath ||
            status.artifactSha512 !== verified.artifactSha512
          )
            throw new Error(
              'The validated download and confirmed runtime stop are required before handoff.'
            )
          const inside = relative(config.updateCacheRoot, verified.localPath)
          if (inside === '..' || inside.startsWith(`..${sep}`))
            throw new Error('Artifact escaped isolated cache.')
          if (
            realpathSync(verified.localPath) !== verified.localPath ||
            !lstatSync(verified.localPath).isFile()
          )
            throw new Error(
              'The downloaded artifact must be a regular file inside the isolated cache.'
            )
          const hash = createHash('sha512')
          for await (const chunk of createReadStream(verified.localPath)) hash.update(chunk)
          if (hash.digest('base64') !== verified.artifactSha512)
            throw new Error('Downloaded artifact changed before handoff.')
          if (config.installBehavior === 'upgrade') {
            await options.beforeInstallHandoff?.(status)
            record('native-install-started', { ...verified, stop: stopped, installationRoot })
            return
          }
          record(config.installBehavior === 'fail' ? 'handoff-failure' : 'handoff-boundary', {
            ...verified,
            stop: stopped,
            nativeInstallInvoked: false,
            targetStarted: false,
            injected: config.installBehavior === 'fail'
          })
          throw new UpdateLifecycleError(
            'install-failed',
            config.installBehavior === 'fail'
              ? 'Local validation injected an installation handoff failure. Restore the service to continue.'
              : 'Local validation reached the installation handoff boundary. Restore the service to continue.',
            {
              phase: 'stopped',
              runtime: 'stopped-clean',
              installation: 'unchanged',
              canCancel: true,
              canRecover: true,
              canRetryInstall: false
            }
          )
        },
        executeInstall: async (status, apply) => {
          if (config.installBehavior !== 'upgrade' || !options.executeInstall)
            throw new Error('This scenario does not authorize native installation.')
          return options.executeInstall(status, apply)
        }
      })
    }
  }
}

// Full code-signature integrity verification runs before this test-only publisher policy.
export function verifyLocalPublisher(signature: ReadonlySet<string>): void {
  if (
    !signature.has('Identifier=com.aipoch.open-science.local-update-validation') ||
    !signature.has('Signature=adhoc') ||
    !signature.has('TeamIdentifier=not set')
  )
    throw new Error('The local update must be an intact ad-hoc signed validation application.')
}
