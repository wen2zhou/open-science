import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  EnvironmentCheckResult,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  ValidateProviderResult
} from '../../shared/settings'
import type { ComputeHost } from '../../shared/compute'
import { parseFrontmatter } from '../../shared/skill-frontmatter'
import { isProviderUsableByFramework } from '../../shared/settings'
import { isModelBridgeSupported } from '../../shared/provider-registry'
import { CLAUDE_EXECUTABLE_MISSING_MESSAGE } from '../../shared/run-error-classification'
import { buildAgentSpawnEnv } from '../acp/agent-process'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentFrameworkId
} from '../agent-framework'
import type { AgentConfigFile } from '../agent-framework/types'
import {
  syncConnectorSkillDocs,
  syncMaterializedCustomServerSkillDocs
} from '../connectors/provision'
import { renderSkillDoc } from '../connectors/skill-doc'
import { connectorSkillDocsDir } from '../connectors/runtime-settings-projection'
import { ComputeHostRepository } from '../compute/repository'
import { createLogger } from '../logger'
import { getProjectDbClient } from '../projects/prisma-client'
import {
  COMPUTE_SKILL_ID,
  hasCanonicalComputeSkillDoc,
  projectComputeSkillDoc,
  syncComputeSkillDoc
} from '../compute/skill-doc'
import {
  SkillRuntimeProjectionOwner,
  type SkillRuntimeBindingPolicy,
  type SkillRuntimeProjectionInput
} from '../skills/runtime-projection'
import {
  CompositeLanguageRuntimeAdapter,
  PythonLanguageRuntimeAdapter,
  RLanguageRuntimeAdapter,
  SkillRuntimeStateOwner,
  type SkillRuntimeRoots
} from '../skills/runtime-state'
import type { BundledSkill } from '../skills/registry'
import { writeAgentConfigFiles } from './agent-config-files'
import { createDefaultDetectDeps, detectClaude, type ClaudeDetectDeps } from './claude-detect'
import {
  createDefaultDetectDeps as createOpencodeDetectDeps,
  detectOpencode,
  type OpencodeDetectDeps
} from './opencode-detect'
import {
  detectCodex,
  parseVersion as parseCodexVersion,
  runAcpInitializeSmoke,
  type CodexDetectDeps
} from './codex-detect'
import { detectNpmAvailable, runInstallWithFallback, type InstallTarget } from './claude-install'
import { OPENCODE_INSTALL_TARGET } from './opencode-install'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import {
  DEFAULT_REGISTRIES,
  installManagedClaude,
  isManagedClaudePath,
  managedClaudeDir,
  uninstallManagedClaude,
  type InstallManagedClaudeOptions,
  type ManagedInstallOutcome
} from './managed-claude'
import {
  installManagedOpencode,
  isManagedOpencodePath,
  managedOpencodeDir,
  uninstallManagedOpencode,
  type InstallManagedOpencodeOptions
} from './managed-opencode'
import {
  ensureManagedCodexContextUsage,
  installManagedCodex,
  managedCodexAdapterEntry,
  managedCodexBinary,
  uninstallManagedCodex,
  type InstallManagedCodexOptions,
  type ManagedCodexInstallOutcome
} from './managed-codex'
import { runEnvironmentCheck } from './environment-check'
import { computePreflight } from './preflight'
import { isEncryptionAvailable } from './crypto'
import { augmentedPathEnv } from './shell-path'
import { buildProviderEnv, getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import { resolveSystemProxyEnvironment, type SystemProxyEnvironment } from './system-proxy'
import type { ProviderAccountsModule } from './provider-accounts'
import type { SettingsRepository } from './repository'
import type { SkillCatalogModule } from './skill-catalog'
import type { ConnectorSettingsModule } from './connector-settings'
import type { StoredCodexInfo, StoredSettings } from './types'

const execFileAsync = promisify(execFile)
const log = createLogger('agent-runtime-manager')
const CLAUDE_PROBE_TIMEOUT_MS = 20_000
const CODEX_INSTALL_TARGET: InstallTarget = {
  npmPackage: '@agentclientprotocol/codex-acp',
  // Codex exposes no supported shell installer; InstallCodexRequest cannot select this branch.
  scriptUnix: ''
}

const isManagedCodexPath = (adapterPath: string, storageRoot: string): boolean =>
  adapterPath === managedCodexAdapterEntry(storageRoot)

export type ExecuteClaudeProbe = (
  executablePath: string,
  env: NodeJS.ProcessEnv,
  runtimeArgs?: string[]
) => Promise<void>

const executeClaudeProbe: ExecuteClaudeProbe = async (executablePath, env, runtimeArgs = []) => {
  await execFileAsync(executablePath, [...runtimeArgs, '-p', 'ok'], {
    env,
    timeout: CLAUDE_PROBE_TIMEOUT_MS,
    // On Windows the detected claude is a `claude.cmd` shim, which execFile cannot launch without a
    // shell. Keep the probe on the same platform-specific path as the pre-extraction implementation.
    shell: process.platform === 'win32',
    windowsHide: true
  })
}

const runCodexAdapterVersion = async (
  adapterPath: string,
  fallback: (path: string) => Promise<string | undefined>
): Promise<string | undefined> => {
  if (!/\.[cm]?js$/i.test(adapterPath)) return fallback(adapterPath)

  try {
    const { stdout } = await execFileAsync(process.execPath, [adapterPath, '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_BROWSER: '1' },
      timeout: 5_000,
      windowsHide: true
    })
    return stdout
  } catch {
    return undefined
  }
}

const allocateLoopbackPort = async (): Promise<number> => {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Could not reserve an OpenCode usage API port.')
    }
    return address.port
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as { killed?: boolean; signal?: string; code?: string }
  return (
    candidate.killed === true || candidate.signal === 'SIGTERM' || candidate.code === 'ETIMEDOUT'
  )
}

const classifyClaudeProbeFailure = (error: unknown): 'auth' | 'network' | 'unknown' => {
  if (typeof error !== 'object' || error === null) return 'unknown'

  const candidate = error as {
    code?: string | number
    message?: string
    stderr?: unknown
    stdout?: unknown
  }
  if (candidate.code === 'ENOENT' || candidate.code === 'EACCES') return 'unknown'

  const detail = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|not authenticated|not logged in|authentication failed|invalid api key|api key.*invalid|please run \/login|oauth.*(?:invalid|expired|reject)|(?:invalid|expired|rejected).*token|token.*(?:invalid|expired|rejected)/i.test(
      detail
    )
  ) {
    return 'auth'
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)\b|network|fetch failed|getaddrinfo/i.test(
      detail
    )
  ) {
    return 'network'
  }

  return 'unknown'
}

export type ProviderPreflightAccess = Pick<
  ProviderAccountsModule,
  'isProviderKeyUsable' | 'resolveActiveModel' | 'resolveProviderApiEndpoints'
>

export type RuntimeUninstallResult = {
  activeBackendAffected: boolean
}

export type AgentRuntimeManagerOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir: string
  skills: SkillCatalogModule
  connectors: ConnectorSettingsModule
  allocateSettingsIdSequence: () => number
  detectDeps?: ClaudeDetectDeps
  opencodeDetectDeps?: OpencodeDetectDeps
  codexDetectDeps?: CodexDetectDeps
  allocateOpenCodeUsagePort?: () => Promise<number>
  executeClaudeProbe?: ExecuteClaudeProbe
  installManagedClaudeImpl?: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedOpencodeImpl?: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedCodexImpl?: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  resolveCodexProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
  syncComputeSkillDocument?: (skillsDir: string) => Promise<void>
  readComputeHosts?: () => Promise<ComputeHost[]>
}

export type AcquiredSkillRuntimeBinding = Readonly<{
  generationId: string
  generationRoot: string
  skillsRoot: string
  discoveryRoot: string
  descriptors: readonly {
    id: string
    name: string
    description: string
    path: string
    source?: 'connector'
  }[]
  environment: Readonly<Record<string, string>>
  stateRoots: SkillRuntimeRoots
  release(): Promise<void>
}>

const digestBytes = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

// Catalog timestamps are presentation metadata and user packages may change an auxiliary file
// without rewriting SKILL.md. Hash the complete package tree so generation reuse is byte-accurate.
const packageContentRevision = async (sourceDir: string): Promise<string> => {
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Skill package contains symbolic link: ${relativePath}`)
      }
      hash.update(relativePath)
      hash.update('\0')
      if (metadata.isDirectory()) {
        hash.update('directory\0')
        await visit(path, relativePath)
      } else if (metadata.isFile()) {
        if (metadata.nlink > 1) throw new Error(`Skill package contains hard link: ${relativePath}`)
        hash.update((metadata.mode & 0o111) !== 0 ? 'executable\0' : 'file\0')
        hash.update(await readFile(path))
        hash.update('\0')
      } else {
        throw new Error(`Skill package contains unsupported entry: ${relativePath}`)
      }
    }
  }
  await visit(sourceDir)
  return `sha256:${hash.digest('hex')}`
}

// Owns host runtime discovery, installation, executable preparation, and runtime-specific filesystem
// provisioning. Durable records remain serialized by SettingsRepository; live ACP generations and
// reconnect decisions remain outside this module.
export class AgentRuntimeManager {
  private readonly repository: SettingsRepository
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private readonly skills: SkillCatalogModule
  private readonly connectors: ConnectorSettingsModule
  private readonly allocateSettingsIdSequence: () => number
  private readonly detectDeps: ClaudeDetectDeps
  private readonly opencodeDetectDeps: OpencodeDetectDeps
  private readonly codexDetectDeps: CodexDetectDeps
  private readonly allocateOpenCodeUsagePort: () => Promise<number>
  private readonly executeClaudeProbe: ExecuteClaudeProbe
  private readonly installManagedClaudeImpl: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedOpencodeImpl: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedCodexImpl: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  private readonly resolveProxyEnvironment: () => Promise<SystemProxyEnvironment | undefined>
  private readonly syncComputeSkillDocument: (skillsDir: string) => Promise<void>
  private readonly readComputeHosts: () => Promise<ComputeHost[]>
  private readonly skillProjection: SkillRuntimeProjectionOwner
  private readonly skillRuntimeState: SkillRuntimeStateOwner
  private skillRuntimeReconciliation?: Promise<void>

  constructor(options: AgentRuntimeManagerOptions) {
    this.repository = options.repository
    this.storageRoot = options.storageRoot
    this.userClaudeDir = options.userClaudeDir
    this.skills = options.skills
    this.connectors = options.connectors
    this.allocateSettingsIdSequence = options.allocateSettingsIdSequence

    const baseDetectDeps = options.detectDeps ?? createDefaultDetectDeps()
    this.detectDeps = {
      ...baseDetectDeps,
      extraDirs: [...(baseDetectDeps.extraDirs ?? []), managedClaudeDir(this.storageRoot)]
    }

    const baseOpencodeDetectDeps = options.opencodeDetectDeps ?? createOpencodeDetectDeps()
    this.opencodeDetectDeps = {
      ...baseOpencodeDetectDeps,
      extraDirs: [...(baseOpencodeDetectDeps.extraDirs ?? []), managedOpencodeDir(this.storageRoot)]
    }

    const managedAdapterPath = managedCodexAdapterEntry(this.storageRoot)
    const managedNativePath = managedCodexBinary(this.storageRoot)
    this.codexDetectDeps = options.codexDetectDeps ?? {
      env: baseOpencodeDetectDeps.env,
      homePath: baseOpencodeDetectDeps.homePath,
      platform: baseOpencodeDetectDeps.platform,
      isRunnable: baseOpencodeDetectDeps.isExecutable,
      getAdapterVersion: (path) => runCodexAdapterVersion(path, baseOpencodeDetectDeps.getVersion),
      getCodexVersion: baseOpencodeDetectDeps.getVersion,
      smokeInitialize: runAcpInitializeSmoke(baseOpencodeDetectDeps.platform),
      resolveNpmBinDirs: baseOpencodeDetectDeps.resolveNpmBinDirs,
      extraDirs: [dirname(managedAdapterPath)],
      managedAdapterPath,
      managedCodexPath: managedNativePath
    }

    this.allocateOpenCodeUsagePort = options.allocateOpenCodeUsagePort ?? allocateLoopbackPort
    this.executeClaudeProbe = options.executeClaudeProbe ?? executeClaudeProbe
    this.installManagedClaudeImpl = options.installManagedClaudeImpl ?? installManagedClaude
    this.installManagedOpencodeImpl = options.installManagedOpencodeImpl ?? installManagedOpencode
    this.installManagedCodexImpl = options.installManagedCodexImpl ?? installManagedCodex
    this.resolveProxyEnvironment =
      options.resolveCodexProxyEnvironment ?? resolveSystemProxyEnvironment
    this.readComputeHosts =
      options.readComputeHosts ??
      (() => new ComputeHostRepository(() => getProjectDbClient(this.storageRoot)).list())
    this.syncComputeSkillDocument =
      options.syncComputeSkillDocument ??
      (async (skillsDir) => {
        if (!(await hasCanonicalComputeSkillDoc(skillsDir))) return
        const hosts = await this.readComputeHosts()
        await syncComputeSkillDoc(skillsDir, hosts)
      })
    const skillRuntimeRoot = join(this.storageRoot, 'skill-runtime')
    this.skillProjection = new SkillRuntimeProjectionOwner({
      storageRoot: join(skillRuntimeRoot, 'projection')
    })
    this.skillRuntimeState = new SkillRuntimeStateOwner({
      storageRoot: join(skillRuntimeRoot, 'state')
    })
  }

  async getPreflight(providers: ProviderPreflightAccess): Promise<Preflight> {
    const settings = await this.repository.getSettings()
    const claudePathExists = settings.claude?.resolvedPath
      ? (await this.detectDeps.getVersion(settings.claude.resolvedPath)) !== undefined
      : false
    const opencodePathExists = settings.opencodePath
      ? (await this.opencodeDetectDeps.getVersion(settings.opencodePath)) !== undefined
      : false
    const codexPathExists = (await this.probeCodexRuntime(settings.codex)) !== undefined

    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const framework = getAgentFramework(agentFrameworkId)
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    const activeEndpoints = activeProvider
      ? providers.resolveProviderApiEndpoints(activeProvider, activeProvider.model)
      : undefined
    const activeProviderCompatible = activeProvider
      ? isProviderUsableByFramework(
          { apiEndpoints: activeEndpoints, type: activeProvider.type },
          framework
        ) &&
        (framework.id !== 'codex' ||
          isModelBridgeSupported(
            activeProvider,
            providers.resolveActiveModel(activeProvider, settings.activeModel)
          ))
      : false
    const activeProviderKeyUsable =
      activeProvider && activeProvider.lastValidatedAt !== undefined
        ? await providers.isProviderKeyUsable(activeProvider)
        : false

    return computePreflight({
      settings,
      claudePathExists,
      opencodePathExists,
      codexPathExists,
      agentFrameworkId,
      isProviderKeyUsable: (provider) =>
        provider.id === activeProvider?.id && activeProviderKeyUsable,
      activeProviderCompatible
    })
  }

  async checkEnvironment(): Promise<EnvironmentCheckResult> {
    const settings = await this.repository.getSettings()
    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const [claudeRuntime, opencodeRuntime, codexRuntime] = await Promise.all([
      this.resolveClaudeRuntime(settings),
      this.resolveOpencodeRuntime(settings),
      this.resolveCodexRuntime(settings)
    ])

    return runEnvironmentCheck({
      storageRoot: this.storageRoot,
      agentFrameworkId,
      frameworks: [
        {
          id: 'claude-code',
          label: getAgentFramework('claude-code').displayName,
          runtime: claudeRuntime
        },
        {
          id: 'opencode',
          label: getAgentFramework('opencode').displayName,
          runtime: opencodeRuntime
        },
        {
          id: 'codex',
          label: getAgentFramework('codex').displayName,
          runtime: codexRuntime
        }
      ],
      encryptionAvailable: isEncryptionAvailable()
    })
  }

  async detectClaude(): Promise<ClaudeDetectResult> {
    const result = await detectClaude(this.detectDeps)

    if (result.found && result.path) {
      await this.repository.setClaudeInfo({ resolvedPath: result.path, version: result.version })
    } else {
      const cached = (await this.repository.getSettings()).claude
      if (cached?.resolvedPath && !(await this.pathExists(cached.resolvedPath))) {
        await this.repository.setClaudeInfo({})
      }
    }

    return result
  }

  async detectOpencode(): Promise<void> {
    const detected = await detectOpencode(this.opencodeDetectDeps)

    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)
    } else {
      const cached = (await this.repository.getSettings()).opencodePath
      if (cached && !(await this.pathExists(cached))) await this.repository.clearOpencodeInfo()
    }
  }

  async detectCodex(): Promise<void> {
    const detected = await detectCodex(this.codexDetectDeps)

    if (detected) {
      await this.repository.setCodexInfo({
        resolvedPath: detected.adapterPath,
        version: detected.adapterVersion,
        nativePath: detected.nativeCodexPath,
        nativeVersion: detected.nativeCodexVersion
      })
    } else {
      const cached = (await this.repository.getSettings()).codex?.resolvedPath
      if (cached && !(await this.pathExists(cached))) await this.repository.clearCodexInfo()
    }
  }

  async installClaude(
    request: InstallClaudeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-${Date.now()}-${this.allocateSettingsIdSequence()}`

    if (request.source === 'managed') {
      const registries =
        request.managedRegistry === 'npmmirror'
          ? [DEFAULT_REGISTRIES[1], DEFAULT_REGISTRIES[0]]
          : DEFAULT_REGISTRIES
      const outcome = await this.installManagedClaudeImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot,
        registries
      })

      if (outcome.result.ok && outcome.resolvedPath) {
        const installedVersion = await this.detectDeps.getVersion(outcome.resolvedPath)
        if (!installedVersion) {
          const error =
            'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
          onEvent({ kind: 'log', installId, stream: 'system', chunk: `${error}\n` })
          return { installId, ok: false, error }
        }

        await this.repository.setClaudeInfo({
          resolvedPath: outcome.resolvedPath,
          version: outcome.version
        })
      }

      return outcome.result
    }

    const result = await runInstallWithFallback({ source: request.source, installId, onEvent })
    if (result.ok) await this.detectClaude()
    return result
  }

  async installOpencode(
    request: InstallOpencodeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-opencode-${Date.now()}-${this.allocateSettingsIdSequence()}`

    if (request.source === 'managed') {
      const outcome = await this.installManagedOpencodeImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot
      })
      if (outcome.result.ok && outcome.resolvedPath) {
        await this.repository.setOpencodeInfo(outcome.resolvedPath, outcome.version)
      }
      return outcome.result
    }

    const result = await runInstallWithFallback({
      source: request.source,
      installId,
      onEvent,
      installTarget: OPENCODE_INSTALL_TARGET
    })
    if (result.ok) await this.detectOpencode()
    return result
  }

  async installCodex(
    request: InstallCodexRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-codex-${Date.now()}-${this.allocateSettingsIdSequence()}`

    if (request.source === 'managed') {
      const outcome = await this.installManagedCodexImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot
      })
      if (
        outcome.result.ok &&
        outcome.adapterPath &&
        outcome.adapterVersion &&
        outcome.codexPath &&
        outcome.codexVersion
      ) {
        await this.repository.setCodexInfo({
          resolvedPath: outcome.adapterPath,
          version: outcome.adapterVersion,
          nativePath: outcome.codexPath,
          nativeVersion: outcome.codexVersion
        })
      }
      return outcome.result
    }

    const result = await runInstallWithFallback({
      source: request.source,
      installId,
      onEvent,
      installTarget: CODEX_INSTALL_TARGET
    })
    if (result.ok) await this.detectCodex()
    return result
  }

  async uninstallClaude(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.claude?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'claude-code'

    if (!resolvedPath || !isManagedClaudePath(resolvedPath, this.storageRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedClaude(this.storageRoot)
    await this.detectClaude()
    await this.autoSwitchAwayFrom('claude-code')
    return { activeBackendAffected: wasActive }
  }

  async uninstallOpencode(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.opencodePath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'opencode'

    if (!resolvedPath || !isManagedOpencodePath(resolvedPath, this.storageRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedOpencode(this.storageRoot)
    await this.detectOpencode()
    await this.autoSwitchAwayFrom('opencode')
    return { activeBackendAffected: wasActive }
  }

  async uninstallCodex(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.codex?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'codex'

    if (!resolvedPath || !isManagedCodexPath(resolvedPath, this.storageRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedCodex(this.storageRoot)
    await this.repository.clearCodexInfo()
    await this.detectCodex()
    await this.autoSwitchAwayFrom('codex')
    return { activeBackendAffected: wasActive }
  }

  isManagedRuntimePath(frameworkId: AgentFrameworkId, path: string): boolean {
    if (frameworkId === 'claude-code') return isManagedClaudePath(path, this.storageRoot)
    if (frameworkId === 'opencode') return isManagedOpencodePath(path, this.storageRoot)
    return isManagedCodexPath(path, this.storageRoot)
  }

  async isNpmAvailable(): Promise<boolean> {
    const { available } = await detectNpmAvailable()
    return available
  }

  async reserveOpenCodeUsagePort(): Promise<number> {
    return this.allocateOpenCodeUsagePort()
  }

  async resolveCodexProxyEnvironment(): Promise<SystemProxyEnvironment | undefined> {
    return this.resolveProxyEnvironment()
  }

  async acquireSkillRuntimeBinding(
    settings: StoredSettings,
    policyOrForcedSkillIds: SkillRuntimeBindingPolicy | ReadonlySet<string> = {
      kind: 'main'
    }
  ): Promise<AcquiredSkillRuntimeBinding | undefined> {
    const policy: SkillRuntimeBindingPolicy =
      'kind' in policyOrForcedSkillIds
        ? policyOrForcedSkillIds
        : { kind: 'main', forcedSkillIds: [...policyOrForcedSkillIds] }
    if (policy.kind === 'none') return undefined

    await this.reconcileSkillRuntimeOnce().catch((error) => {
      log.warn('Skill Runtime startup reconciliation failed; continuing without cleanup', error)
    })
    let packages: BundledSkill[]
    try {
      packages = await this.skills.runtimeProjectionCatalog()
    } catch (error) {
      if (policy.kind === 'exact') throw error
      // Without a current catalog there is no trustworthy authorization set for either a new or a
      // last-good generation. Fail closed to an ordinary backend instead of exposing stale Skills.
      log.warn('Failed to read the Skill Runtime catalog; disabling Skills for this backend', error)
      return undefined
    }
    let inputs: SkillRuntimeProjectionInput[] | undefined
    try {
      inputs = await this.skillRuntimeProjectionInputs(settings, packages)
      await this.skillProjection.publish({ inputs })
    } catch (error) {
      // Input construction and publication are transactional. A damaged or transiently unreadable
      // source must not evict the last complete generation; use that generation when one exists.
      log.warn('Failed to publish Skill Runtime Projection; retaining current generation', error)
    }

    const disabled = new Set(settings.disabledSkillIds ?? [])
    const forcedSkillIds = new Set(policy.kind === 'main' ? (policy.forcedSkillIds ?? []) : [])
    // Generated Skills have no independent catalog revision. Only authorize the identities proven
    // readable while constructing the current inputs; if any package aborts that construction, the
    // last-good generation remains usable for catalogued packages but generated entries fail closed.
    const generatedIds = inputs
      ? inputs.filter((input) => input.kind === 'generated').map((input) => input.id)
      : []
    const availableSkillIds = new Set([...packages.map((skill) => skill.id), ...generatedIds])
    const allowedSkillIds =
      policy.kind === 'exact'
        ? [...new Set(policy.allowedSkillIds)]
        : [
            ...packages
              .filter((skill) => !disabled.has(skill.id) || forcedSkillIds.has(skill.id))
              .map((skill) => skill.id),
            ...generatedIds
          ]
    if (policy.kind === 'exact') {
      const unavailable = allowedSkillIds.filter((id) => !availableSkillIds.has(id))
      if (unavailable.length > 0) {
        throw new Error(`Authorized Skill is unavailable: ${unavailable.join(', ')}`)
      }
    } else {
      // Internal package ids are stable catalog ids, not prefixed identities. Recover the exposure
      // decision from the catalog rather than encoding it into a framework-visible id.
      const internalIds = new Set(
        packages.filter((skill) => skill.exposure === 'internal').map((skill) => skill.id)
      )
      for (const id of internalIds) if (!allowedSkillIds.includes(id)) allowedSkillIds.push(id)
    }

    let projection
    try {
      projection = await this.skillProjection.acquire({
        allowedSkillIds,
        ...(policy.kind === 'main'
          ? {
              invocationNameCollisionPolicy: 'omit-ambiguous' as const,
              preferredSkillIds: [...forcedSkillIds]
            }
          : {})
      })
    } catch (error) {
      // An exact role contract must never silently become an ordinary no-Skill backend. This covers
      // the catalog-new/projection-last-good window when publication failed before an authorized
      // Specialist Skill reached the immutable generation.
      if (policy.kind === 'exact') throw error
      // First publication can fail before any last-good generation exists. Disable Skill exposure for
      // this backend instead of falling back to a protected framework home or blocking conversation.
      log.warn(
        'No valid Skill Runtime Projection is available; disabling Skills for this backend',
        error
      )
      return undefined
    }
    if (policy.kind === 'main') {
      const boundIds = new Set(projection.descriptors.map((descriptor) => descriptor.id))
      const omittedSkillIds = allowedSkillIds.filter((id) => !boundIds.has(id))
      if (omittedSkillIds.length > 0) {
        log.warn('Omitting ambiguous Skill invocation names from Main binding', {
          skillIds: omittedSkillIds
        })
      }
    }
    const runtimeId = randomUUID()
    let state
    try {
      state = await this.skillRuntimeState.acquire({
        agentSessionId: `agent-${runtimeId}`,
        runtimeBindingId: `binding-${projection.generationId}`,
        attemptId: `attempt-${runtimeId}`,
        language: new CompositeLanguageRuntimeAdapter([
          new PythonLanguageRuntimeAdapter(),
          new RLanguageRuntimeAdapter()
        ])
      })
    } catch (error) {
      // Writable state is optional to the ordinary backend, but never fall back to package-local
      // writes. Release the read-only projection lease and continue with Skills disabled.
      await projection.release().catch((releaseError) => {
        log.warn('Failed to release Skill Runtime Projection after state allocation failure', {
          error: releaseError
        })
      })
      if (policy.kind === 'exact') {
        log.warn('Failed to allocate writable state for an exact Skill Runtime binding', { error })
        throw error
      }
      log.warn(
        'Failed to allocate writable Skill Runtime state; disabling Skills for this backend',
        { error }
      )
      return undefined
    }

    let releaseCompleted = false
    let releaseOperation: Promise<void> | undefined
    return Object.freeze({
      generationId: projection.generationId,
      generationRoot: projection.root,
      skillsRoot: projection.skillsRoot,
      discoveryRoot: projection.discoveryRoot,
      descriptors: projection.descriptors,
      stateRoots: state.roots,
      environment: Object.freeze({
        ...state.environment,
        OPEN_SCIENCE_HANDOFF_DIR: state.roots.outputHandoffRoot,
        OPEN_SCIENCE_SKILL_TEMP_DIR: state.roots.temporaryRoot,
        OPEN_SCIENCE_SKILL_CACHE_DIR: state.roots.cacheRoot,
        OPEN_SCIENCE_SKILL_STATE_DIR: state.roots.stateRoot
      }),
      release: () => {
        if (releaseCompleted) return Promise.resolve()
        releaseOperation ??= Promise.allSettled([
          state.release().then(() =>
            this.skillRuntimeState.cleanupRuntimeBinding({
              agentSessionId: state.scope.agentSessionId,
              runtimeBindingId: state.scope.runtimeBindingId
            })
          ),
          projection.release()
        ])
          .then((results) => {
            const failure = results.find(
              (result): result is PromiseRejectedResult => result.status === 'rejected'
            )
            if (failure) throw failure.reason
            releaseCompleted = true
          })
          .catch((error) => {
            releaseOperation = undefined
            throw error
          })
        return releaseOperation
      }
    })
  }

  /** Reclaims Skill Runtime Projection/state left by an abnormal prior app process. */
  async reconcileSkillRuntime(): Promise<void> {
    await this.reconcileSkillRuntimeOnce()
  }

  private async reconcileSkillRuntimeOnce(): Promise<void> {
    this.skillRuntimeReconciliation ??= Promise.all([
      this.skillProjection.reconcile(),
      // A fresh owner has no live Attempts, so every prior binding is an app-crash orphan. Normal
      // teardown removes its own state immediately; this policy bounds abnormal-exit storage too.
      this.skillRuntimeState.reconcile({
        maxAttemptAgeMs: 0,
        maxBindingAgeMs: 0,
        maxCacheBytes: 1024 ** 3
      })
    ])
      .then(() => undefined)
      .catch((error) => {
        // A transient filesystem failure must not poison cleanup for the rest of this app process.
        // Startup logs and continues; a later binding acquisition retries the same owned cleanup.
        this.skillRuntimeReconciliation = undefined
        throw error
      })
    return this.skillRuntimeReconciliation
  }

  private async skillRuntimeProjectionInputs(
    settings: StoredSettings,
    packages: readonly BundledSkill[]
  ): Promise<SkillRuntimeProjectionInput[]> {
    const computeHosts = packages.some((skill) => skill.id === COMPUTE_SKILL_ID)
      ? await this.readComputeHosts()
      : []
    const packageInputs = await Promise.all(
      packages.map(async (skill): Promise<SkillRuntimeProjectionInput> => {
        const sourceRevision = await packageContentRevision(skill.sourceDir)
        if (skill.id !== COMPUTE_SKILL_ID) {
          return {
            kind: 'package',
            id: skill.id,
            name: skill.name,
            description: skill.description,
            directory: `os-${skill.id}`,
            revision: sourceRevision,
            sourceDir: skill.sourceDir
          }
        }
        const document = projectComputeSkillDoc(
          await readFile(join(skill.sourceDir, 'SKILL.md'), 'utf8'),
          computeHosts
        )
        return {
          kind: 'package',
          id: skill.id,
          name: skill.name,
          description: skill.description,
          directory: `os-${skill.id}`,
          revision: `${sourceRevision}:hosts:${digestBytes(document)}`,
          sourceDir: skill.sourceDir,
          overrides: [{ path: 'SKILL.md', content: document }]
        }
      })
    )

    const bundledConnectors: SkillRuntimeProjectionInput[] = this.connectors
      .enabledConnectorIds(settings.connectors)
      .map((id) => {
        const name = `mcp-${id}`
        const document = renderSkillDoc(id)
        return {
          kind: 'generated',
          id: name,
          name,
          description: parseFrontmatter(document).fields.description ?? `Use ${id}.`,
          source: 'connector',
          directory: name,
          revision: `sha256:${digestBytes(document)}`,
          files: [{ path: 'SKILL.md', content: document }]
        }
      })
    const customConnectors: SkillRuntimeProjectionInput[] = []
    for (const name of this.connectors.materializedCustomSkillNames()) {
      try {
        const document = await readFile(
          join(connectorSkillDocsDir(this.storageRoot), name, 'SKILL.md'),
          'utf8'
        )
        customConnectors.push({
          kind: 'generated',
          id: name,
          name,
          description: parseFrontmatter(document).fields.description ?? `Use ${name}.`,
          source: 'connector',
          directory: name,
          revision: `sha256:${digestBytes(document)}`,
          files: [{ path: 'SKILL.md', content: document }]
        })
      } catch (error) {
        log.warn('Skipping unavailable generated custom Connector Skill', { name, error })
      }
    }

    return [...packageInputs, ...bundledConnectors, ...customConnectors].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  }

  async materializeAgentSkills(
    settings: StoredSettings,
    configRoot: string,
    forcedSkillIds: ReadonlySet<string>
  ): Promise<string[]> {
    await this.skills.materializeSkills(configRoot, settings.disabledSkillIds ?? [], forcedSkillIds)
    const bundledIds = this.connectors.enabledConnectorIds(settings.connectors)
    await syncConnectorSkillDocs(join(configRoot, 'skills'), bundledIds)
    const customSkillSync = await syncMaterializedCustomServerSkillDocs(
      connectorSkillDocsDir(this.storageRoot),
      join(configRoot, 'skills'),
      this.connectors.materializedCustomSkillNames()
    )
    for (const failure of customSkillSync.failures) {
      log.warn('Failed to materialize custom Connector Skill doc', failure)
    }
    await this.syncComputeSkillDocument(join(configRoot, 'skills'))
    return [...bundledIds.map((id) => `mcp-${id}`), ...customSkillSync.materializedSkillNames]
  }

  async materializeAgentConfigFiles(files: AgentConfigFile[] | undefined): Promise<void> {
    await writeAgentConfigFiles(files)
  }

  async provisionClaudeRuntimeConfig(
    settings: StoredSettings,
    forcedSkillIds: ReadonlySet<string> = new Set(),
    modelConfig?: ClaudeRuntimeModelConfig | null
  ): Promise<string> {
    const configDir = getAppClaudeConfigDir(this.storageRoot)
    const disabledSkillIds = (settings.disabledSkillIds ?? []).filter(
      (id) => !forcedSkillIds.has(id)
    )
    // Claude config/auth remains protected and contains no Skill packages. The shared immutable
    // projection is attached independently as a session plugin.
    await this.skills.provisionClaudeConfig(configDir, disabledSkillIds, modelConfig, false)
    return configDir
  }

  async resolveClaudeExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) return storedPath

    const detected = await detectClaude(this.detectDeps)
    if (detected.found && detected.path) return detected.path
    throw new Error(CLAUDE_EXECUTABLE_MISSING_MESSAGE)
  }

  async resolveOpencodeExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) return storedPath

    const detected = await detectOpencode(this.opencodeDetectDeps)
    if (!detected) {
      throw new Error(
        'opencode executable not found. Install opencode or set its path in settings.'
      )
    }
    return detected.resolvedPath
  }

  async resolveCodexExecutable(
    storedPath: string | undefined,
    nativePath: string | undefined
  ): Promise<string> {
    void storedPath
    if (!nativePath) {
      throw new Error('Codex native executable not found. Re-detect or install Codex in settings.')
    }
    const adapterPath =
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.storageRoot)
    if (!(await this.pathExists(adapterPath))) {
      throw new Error('Open Science Codex ACP adapter not found. Install Codex in settings.')
    }

    await ensureManagedCodexContextUsage(adapterPath)
    return adapterPath
  }

  async probeCodexNativeVersion(nativePath: string | undefined): Promise<string | undefined> {
    if (!nativePath) return undefined
    const output = await this.codexDetectDeps.getCodexVersion(nativePath).catch(() => undefined)
    return output ? parseCodexVersion(output) : undefined
  }

  async runClaudeSubscriptionProbe(
    provider: ResolvedProvider,
    settings: StoredSettings
  ): Promise<ValidateProviderResult> {
    const executablePath = settings.claude?.resolvedPath
    if (!executablePath) {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude executable is not configured. Complete Claude detection in settings first.'
      }
    }

    const appConfigDir = await this.provisionClaudeRuntimeConfig(settings)
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })
    const env = buildAgentSpawnEnv(augmentedPathEnv(process.env), envOverrides, executablePath)

    try {
      if (provider.type === 'claude-shared') {
        await this.executeClaudeProbe(executablePath, env, [
          '--settings',
          join(appConfigDir, 'settings.json'),
          '--plugin-dir',
          appConfigDir
        ])
      } else {
        await this.executeClaudeProbe(executablePath, env)
      }
      return { ok: true, category: 'ok' }
    } catch (error) {
      if (isTimeoutError(error)) {
        return {
          ok: false,
          category: 'timeout',
          message:
            provider.type === 'claude-shared'
              ? 'Claude shared-profile validation timed out. Try again.'
              : 'Claude token validation timed out. Try again.'
        }
      }

      const category = classifyClaudeProbeFailure(error)
      const messages =
        provider.type === 'claude-shared'
          ? {
              auth: 'Claude rejected the shared profile. Sign in again and retry.',
              network:
                'Claude could not reach Anthropic while validating the shared profile. Check your network and try again.',
              unknown:
                'Claude could not run the shared-profile validation probe. Re-detect Claude and try again.'
            }
          : {
              auth: 'Claude rejected the setup token. Run `claude setup-token` again and paste a new token.',
              network:
                'Claude could not reach Anthropic while validating the token. Check your network and try again.',
              unknown:
                'Claude could not run the token validation probe. Re-detect Claude and try again.'
            }
      return { ok: false, category, message: messages[category] }
    }
  }

  private async resolveClaudeRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cached = settings.claude
    if (cached?.resolvedPath) {
      const version = await this.detectDeps.getVersion(cached.resolvedPath)
      if (version) {
        if (version !== cached.version) {
          await this.repository.setClaudeInfo({ resolvedPath: cached.resolvedPath, version })
        }
        return { found: true, path: cached.resolvedPath, version }
      }
    }
    return this.detectClaude()
  }

  private async resolveOpencodeRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cachedPath = settings.opencodePath
    if (cachedPath) {
      const version = await this.opencodeDetectDeps.getVersion(cachedPath)
      if (version) {
        if (version !== settings.opencodeVersion) {
          await this.repository.setOpencodeInfo(cachedPath, version)
        }
        return { found: true, path: cachedPath, version }
      }
    }

    const detected = await detectOpencode(this.opencodeDetectDeps)
    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)
      return { found: true, path: detected.resolvedPath, version: detected.version }
    }
    if (cachedPath && !(await this.pathExists(cachedPath)))
      await this.repository.clearOpencodeInfo()
    return { found: false }
  }

  private async resolveCodexRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cached = settings.codex
    const cachedVersions = await this.probeCodexRuntime(cached)
    if (cached?.resolvedPath && cachedVersions) {
      await this.repository.setCodexInfo({ ...cached, ...cachedVersions })
      let nativeCliFound = !!cached.nativePath
      let nativeCliPath = cached.nativePath
      let nativeCliVersion = cachedVersions.nativeVersion

      if (!cached.nativePath) {
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(this.codexDetectDeps)
        if (nativeCodex) {
          nativeCliPath = nativeCodex.path
          nativeCliVersion = nativeCodex.version
        }
      }

      return {
        found: true,
        path: cached.resolvedPath,
        version: cachedVersions.version,
        codexComponents: {
          adapterFound: true,
          adapterPath: cached.resolvedPath,
          adapterVersion: cachedVersions.version,
          nativeCliFound,
          nativeCliPath,
          nativeCliVersion
        }
      }
    }

    const detected = await detectCodex(this.codexDetectDeps)
    if (detected) {
      await this.repository.setCodexInfo({
        resolvedPath: detected.adapterPath,
        version: detected.adapterVersion,
        nativePath: detected.nativeCodexPath,
        nativeVersion: detected.nativeCodexVersion
      })
      let nativeCliFound = !!detected.nativeCodexPath
      let nativeCliPath = detected.nativeCodexPath
      let nativeCliVersion = detected.nativeCodexVersion

      if (!detected.nativeCodexPath) {
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(this.codexDetectDeps)
        if (nativeCodex) {
          nativeCliPath = nativeCodex.path
          nativeCliVersion = nativeCodex.version
        }
      }

      return {
        found: true,
        path: detected.adapterPath,
        version: detected.adapterVersion,
        codexComponents: {
          adapterFound: true,
          adapterPath: detected.adapterPath,
          adapterVersion: detected.adapterVersion,
          nativeCliFound,
          nativeCliPath,
          nativeCliVersion
        }
      }
    }

    if (cached?.resolvedPath && !(await this.pathExists(cached.resolvedPath))) {
      await this.repository.clearCodexInfo()
    }

    const { detectCodexComponents } = await import('./codex-detect')
    const components = await detectCodexComponents(this.codexDetectDeps)
    let diagnostic: string | undefined
    if (components.nativeCliFound && !components.adapterFound) {
      diagnostic = `Native Codex ${components.nativeCliVersion} is installed at ${components.nativeCliPath}, but the Codex ACP adapter required by Open Science is missing.`
    } else if (!components.nativeCliFound && components.adapterFound) {
      diagnostic =
        components.adapterFailureReason === 'smoke-test-failed'
          ? `Codex ACP adapter ${components.adapterVersion} is installed at ${components.adapterPath}, but it failed to initialize (native Codex CLI may be missing or incompatible).`
          : `Codex ACP adapter is installed at ${components.adapterPath}, but version detection failed.`
    } else if (components.nativeCliFound && components.adapterFound) {
      if (components.adapterFailureReason === 'smoke-test-failed') {
        diagnostic = `Both native Codex ${components.nativeCliVersion} and ACP adapter ${components.adapterVersion} are installed, but the adapter failed to initialize with the native CLI.`
      } else if (components.adapterFailureReason === 'version-probe-failed') {
        diagnostic = `Native Codex ${components.nativeCliVersion} is installed, and an ACP adapter exists at ${components.adapterPath}, but the adapter's version could not be determined.`
      }
    }

    return {
      found: false,
      diagnostic,
      codexComponents: {
        nativeCliFound: components.nativeCliFound,
        nativeCliPath: components.nativeCliPath,
        nativeCliVersion: components.nativeCliVersion,
        adapterFound: components.adapterFound,
        adapterPath: components.adapterPath,
        adapterVersion: components.adapterVersion,
        adapterFailureReason: components.adapterFailureReason
      }
    }
  }

  private async probeCodexRuntime(
    codex: StoredCodexInfo | undefined
  ): Promise<Pick<StoredCodexInfo, 'version' | 'nativeVersion'> | undefined> {
    if (!codex?.resolvedPath) return undefined
    const controlledAdapterPath =
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.storageRoot)
    if (codex.resolvedPath !== controlledAdapterPath) return undefined

    const adapterOutput = await this.codexDetectDeps.getAdapterVersion(codex.resolvedPath)
    const version = adapterOutput ? parseCodexVersion(adapterOutput) : undefined
    if (!version || !codex.nativePath) return undefined
    const nativeOutput = await this.codexDetectDeps.getCodexVersion(codex.nativePath)
    const nativeVersion = nativeOutput ? parseCodexVersion(nativeOutput) : undefined
    return nativeVersion ? { version, nativeVersion } : undefined
  }

  private async autoSwitchAwayFrom(uninstalled: AgentFrameworkId): Promise<void> {
    const settings = await this.repository.getSettings()
    const active = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    if (active !== uninstalled) return

    const candidates: AgentFrameworkId[] = ['claude-code', 'opencode', 'codex']
    for (const candidate of candidates) {
      if (candidate === uninstalled) continue
      const path =
        candidate === 'claude-code'
          ? settings.claude?.resolvedPath
          : candidate === 'opencode'
            ? settings.opencodePath
            : settings.codex?.resolvedPath
      if (!path) continue

      const version =
        candidate === 'claude-code'
          ? await this.detectDeps.getVersion(path)
          : candidate === 'opencode'
            ? await this.opencodeDetectDeps.getVersion(path)
            : await this.codexDetectDeps.getAdapterVersion(path)
      if (version) {
        await this.repository.setAgentFramework(candidate)
        return
      }
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
