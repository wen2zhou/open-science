import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { ReasoningEffort } from '../../shared/settings'
import {
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isCodexSubscriptionProvider
} from '../../shared/settings'
import {
  buildActiveModelIncompatibleMessage,
  CODEX_BRIDGE_UNSUPPORTED_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from '../../shared/run-error-classification'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import {
  getAgentFramework,
  releaseResolvedAgentBackendLeases,
  type AgentModelChangeTarget,
  type AgentModelRoute,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import type { SkillRuntimeBindingPolicy } from '../skills/runtime-projection'
import { buildProviderEnv } from './provider-env'
import type { AcquiredSkillRuntimeBinding, AgentRuntimeManager } from './agent-runtime-manager'
import type { ConnectorSettingsModule } from './connector-settings'
import {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  type ProviderAccountsModule,
  type ProviderRuntimeTarget,
  type RuntimeProviderModelSelection
} from './provider-accounts'
import { ensureCodexAuthHome } from './codex-auth'
import type { StoredSettings } from './types'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import {
  BackendSelectionOwner,
  type AgentBackendSelection,
  type BackendSelectionResolution,
  type ExplicitAgentBackendTarget
} from './backend-selection-owner'
import { BackendRoutePlanner } from './backend-route-planner'
import {
  ProviderTransportOwner,
  type ProviderTransportOwnerOptions
} from './provider-transport-owner'
import { mergeClaudeSessionOptions, SkillRuntimeBackendOwner } from './skill-runtime-backend-owner'

export type { AgentBackendSelection, ExplicitAgentBackendTarget } from './backend-selection-owner'

export type AdmittedAgentBackendTarget = ExplicitAgentBackendTarget &
  Readonly<{
    expectedBackendId: string
    expectedModelRoute: AgentModelRoute
  }>

export type AgentBackendResolutionContext = {
  forcedSkillIds?: string[]
  skillBindingPolicy?: SkillRuntimeBindingPolicy
  systemPromptAppends?: string[]
  forceCodexNativeResponsesCompatibility?: boolean
}

export type AgentSpawnConfig = {
  envOverrides: Record<string, string>
  executablePath: string
  contextWindow?: number
  sessionOptions?: Record<string, unknown>
}

export type AgentBackendRuntimePort = Pick<
  AgentRuntimeManager,
  | 'resolveClaudeExecutable'
  | 'resolveOpencodeExecutable'
  | 'resolveCodexExecutable'
  | 'probeCodexNativeVersion'
  | 'acquireSkillRuntimeBinding'
  | 'provisionClaudeRuntimeConfig'
  | 'materializeAgentSkills'
  | 'materializeAgentConfigFiles'
  | 'reserveOpenCodeUsagePort'
  | 'resolveCodexProxyEnvironment'
>

export type AgentBackendProviderPort = Pick<
  ProviderAccountsModule,
  'resolveRuntimeTarget' | 'resolveRuntimeModelCatalog' | 'resolveRuntimeReasoningEffortProfile'
>

export type AgentBackendConnectorPort = Pick<ConnectorSettingsModule, 'connectorSkillNames'>

export type AgentBackendResolverOptions = ProviderTransportOwnerOptions & {
  readSettings: () => Promise<StoredSettings>
  providers: AgentBackendProviderPort
  runtime: AgentBackendRuntimePort
  connectors: AgentBackendConnectorPort
  storageRoot: string
  userClaudeDir: string
  readFrameworkOverride?: () => string | undefined
  ensureCodexSubscriptionHome?: () => Promise<void>
}

export class AgentBackendResolver {
  private readonly readSettings: () => Promise<StoredSettings>
  private readonly providers: AgentBackendProviderPort
  private readonly runtime: AgentBackendRuntimePort
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private readonly selection: BackendSelectionOwner
  private readonly planner: BackendRoutePlanner
  private readonly transports: ProviderTransportOwner
  private readonly ensureCodexSubscriptionHome: () => Promise<void>
  private readonly skillRuntimes = new SkillRuntimeBackendOwner()

  constructor(options: AgentBackendResolverOptions) {
    this.readSettings = options.readSettings
    this.providers = options.providers
    this.runtime = options.runtime
    this.storageRoot = options.storageRoot
    this.userClaudeDir = options.userClaudeDir
    this.selection = new BackendSelectionOwner({
      readSettings: this.readSettings,
      readFrameworkOverride:
        options.readFrameworkOverride ?? (() => process.env.OPEN_SCIENCE_AGENT_FRAMEWORK),
      resolveRuntimeReasoningEffortProfile: (provider, model) =>
        this.providers.resolveRuntimeReasoningEffortProfile(provider, model)
    })
    this.planner = new BackendRoutePlanner({ providers: this.providers })
    this.transports = new ProviderTransportOwner(options)
    this.ensureCodexSubscriptionHome =
      options.ensureCodexSubscriptionHome ??
      (() => ensureCodexAuthHome('isolated', this.storageRoot))
  }

  async resolveActiveSpawnConfig(
    context: AgentBackendResolutionContext = {}
  ): Promise<AgentSpawnConfig> {
    const settings = await this.readSettings()
    const executablePath = await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath)
    const target = this.resolveConfiguredProviderTarget(settings, getAgentFramework('claude-code'))
    if (target.providerType === 'claude-shared' && target.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const plan = this.planner.planBackend({
      settings,
      frameworkId: 'claude-code',
      target,
      effortIntent: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      conversationSkillImportEnabled:
        settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED
    })
    return this.resolveClaudeSpawnConfig(
      settings,
      target,
      new Set(context.forcedSkillIds ?? []),
      executablePath,
      plan.claudeModelConfig
    )
  }

  async resolveActiveBackend(
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendSelection(await this.selection.resolveActiveSelection(), context)
  }

  async resolveActiveModelChangeTarget(): Promise<AgentModelChangeTarget | undefined> {
    const selection = await this.selection.resolveActiveModelChangeSelection()
    if (!selection) return undefined
    const { settings, frameworkId, providerId, modelSelection, reasoningEffort } = selection
    const framework = getAgentFramework(frameworkId)
    const storedProvider = settings.providers.find((provider) => provider.id === providerId)
    if (!storedProvider) return undefined

    const target = this.providers.resolveRuntimeTarget(storedProvider, modelSelection, framework)
    if (!target.frameworkCompatible || (frameworkId === 'codex' && !target.modelBridgeSupported)) {
      return undefined
    }
    return this.planner.projectModelChange({
      settings,
      frameworkId,
      target,
      effortIntent: reasoningEffort
    })
  }

  async captureConfiguredSelection(): Promise<AgentBackendSelection> {
    return this.selection.captureConfiguredSelection()
  }

  async captureExplicitTarget(): Promise<ExplicitAgentBackendTarget> {
    return this.selection.captureExplicitTarget()
  }

  async resolveSelection(
    selection: AgentBackendSelection,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendSelection(await this.selection.resolveSelection(selection), context)
  }

  async resolveExplicitTarget(
    target: ExplicitAgentBackendTarget,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendSelection(await this.selection.resolveExplicitTarget(target), context)
  }

  async resolveAdmittedTarget(
    target: AdmittedAgentBackendTarget,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const backend = await this.resolveExplicitTarget(target, context)
    if (
      backend.framework.id === target.frameworkId &&
      backend.backendId === target.expectedBackendId &&
      backend.modelRoute === target.expectedModelRoute
    ) {
      return backend
    }
    await releaseResolvedAgentBackendLeases(backend)
    throw new Error('The configured Subagent backend route changed since admission.')
  }

  async forkAdmittedBackendSkillRuntime(
    backend: ResolvedAgentBackend,
    policy: SkillRuntimeBindingPolicy
  ): Promise<ResolvedAgentBackend> {
    return this.skillRuntimes.fork(backend, policy, async () =>
      this.runtime.acquireSkillRuntimeBinding(await this.readSettings(), policy)
    )
  }

  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    return this.selection.resolveActiveReasoningEffort(intent)
  }

  private resolveBackendSelection(
    selection: BackendSelectionResolution,
    context: AgentBackendResolutionContext
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendFromSettings(
      selection.settings,
      selection.frameworkId,
      selection.providerId,
      selection.modelSelection,
      selection.reasoningEffort,
      context,
      selection.resolvedReasoningEffort
    )
  }

  private resolveConfiguredProviderTarget(
    settings: StoredSettings,
    framework: ReturnType<typeof getAgentFramework>
  ): ProviderRuntimeTarget {
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    if (!activeProvider) throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    return this.providers.resolveRuntimeTarget(
      activeProvider,
      { kind: 'configured', requestedModel: settings.activeModel },
      framework
    )
  }

  private async resolveBackendFromSettings(
    settings: StoredSettings,
    frameworkId: AgentFrameworkId,
    providerId: string | undefined,
    modelSelection: RuntimeProviderModelSelection,
    effortIntent: ReasoningEffort,
    context: AgentBackendResolutionContext,
    resolvedEffort?: ResolvedReasoningEffort
  ): Promise<ResolvedAgentBackend> {
    await this.skillRuntimes.retryPendingReleases()
    const framework = getAgentFramework(frameworkId)
    const storedProvider = providerId
      ? settings.providers.find((provider) => provider.id === providerId)
      : undefined
    if (!storedProvider) throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)

    const target = this.providers.resolveRuntimeTarget(storedProvider, modelSelection, framework)
    if (!target.frameworkCompatible) {
      throw new Error(buildActiveModelIncompatibleMessage(framework.displayName))
    }
    if (framework.id === 'codex' && !target.modelBridgeSupported) {
      throw new Error(CODEX_BRIDGE_UNSUPPORTED_MESSAGE)
    }
    const forceNativeResponsesCompatibility =
      context.forceCodexNativeResponsesCompatibility === true &&
      framework.id === 'codex' &&
      !target.needsChatResponsesBridge &&
      !target.needsNativeResponsesCompatibility
    if (forceNativeResponsesCompatibility && isCodexSubscriptionProvider(target.provider.type)) {
      throw new Error(
        'Artifact code reconstruction is unavailable with Codex subscription authentication.'
      )
    }
    const skillBindingPolicy: SkillRuntimeBindingPolicy = context.skillBindingPolicy ?? {
      kind: 'main',
      forcedSkillIds: context.forcedSkillIds ?? []
    }
    const forcedSkillIds = new Set(
      skillBindingPolicy.kind === 'main'
        ? (skillBindingPolicy.forcedSkillIds ?? [])
        : skillBindingPolicy.kind === 'exact'
          ? skillBindingPolicy.allowedSkillIds
          : []
    )
    const acquireSkillBinding = (): Promise<AcquiredSkillRuntimeBinding | undefined> => {
      if (skillBindingPolicy.kind === 'none') return Promise.resolve(undefined)
      // Keep the old Set-shaped runtime port for callers that have not opted into scoped bindings.
      // Explicit policies always cross the new typed seam.
      return this.runtime.acquireSkillRuntimeBinding(
        settings,
        context.skillBindingPolicy ? skillBindingPolicy : forcedSkillIds
      )
    }
    const executablePath =
      framework.id === 'claude-code'
        ? await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath)
        : framework.id === 'codex'
          ? await this.runtime.resolveCodexExecutable(
              settings.codex?.resolvedPath,
              settings.codex?.nativePath
            )
          : await this.runtime.resolveOpencodeExecutable(settings.opencodePath)
    const codexNativeVersion =
      framework.id === 'codex'
        ? await this.runtime.probeCodexNativeVersion(settings.codex?.nativePath)
        : undefined
    if (
      framework.id === 'claude-code' &&
      target.providerType === 'claude-shared' &&
      target.disconnectedAt !== undefined
    ) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const plan = this.planner.planBackend({
      settings,
      frameworkId,
      target,
      effortIntent,
      resolvedEffort,
      conversationSkillImportEnabled:
        settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
      forceNativeResponsesCompatibility
    })
    const modelRoute = plan.modelRoute
    const sessionEffort = plan.sessionEffort
    const supportedReasoningEfforts = plan.supportedReasoningEfforts
    if (framework.id === 'claude-code') {
      const skillBinding = await acquireSkillBinding()
      let transport: Awaited<ReturnType<ProviderTransportOwner['acquire']>> | undefined
      try {
        const {
          envOverrides,
          executablePath: claudeExecutablePath,
          sessionOptions,
          contextWindow
        } = await this.resolveClaudeSpawnConfig(
          settings,
          target,
          forcedSkillIds,
          executablePath,
          plan.claudeModelConfig
        )
        transport = await this.transports.acquire({ activeTarget: target, plan })
        const buildBackend = async (
          binding: AcquiredSkillRuntimeBinding | undefined,
          ownsProviderLease: boolean
        ): Promise<ResolvedAgentBackend> => {
          const skillRuntime = this.skillRuntimes.view(binding)
          const projectedModelConfig = framework.prepareModelConfig(target.provider, {
            storageRoot: this.storageRoot,
            executablePath,
            reasoningEffort: sessionEffort,
            reasoningEfforts: supportedReasoningEfforts,
            ...(skillRuntime ? { skillRuntime } : {})
          })
          const instructions = this.skillRuntimes.connectorInstructions(binding)
          const resolvedSessionOptions = mergeClaudeSessionOptions(
            sessionOptions,
            projectedModelConfig.sessionOptions
          )
          return {
            framework,
            backendId: `${framework.id}:${target.providerId}`,
            modelRoute,
            executablePath: claudeExecutablePath,
            env: {
              ...(skillRuntime?.environment ?? {}),
              ...envOverrides,
              ...(transport?.environment ?? {})
            },
            sessionOptions: resolvedSessionOptions,
            ...(skillRuntime ? { skillRuntime } : {}),
            ...(binding ? { skillRuntimeLease: this.skillRuntimes.lease(binding) } : {}),
            sessionEffort,
            contextWindow,
            ...(target.provider.supportsImageInput ? { supportsImageInput: true } : {}),
            contextUsageModel: target.effectiveModel,
            ...(instructions ? { systemPromptAppends: [instructions] } : {}),
            ...(ownsProviderLease && transport?.anthropicBridgeLease
              ? { anthropicBridgeLease: transport.anthropicBridgeLease }
              : {})
          }
        }
        const backend = await buildBackend(skillBinding, true)
        this.skillRuntimes.register(backend, (binding) => buildBackend(binding, false))
        return backend
      } catch (error) {
        try {
          await transport?.release()
        } finally {
          if (skillBinding) await this.skillRuntimes.release(skillBinding).catch(() => undefined)
        }
        throw error
      }
    }

    if (framework.id === 'codex' && isCodexSubscriptionProvider(target.provider.type)) {
      await this.ensureCodexSubscriptionHome()
    }
    const backendProviderId = plan.backendProviderId
    const skillBinding = await acquireSkillBinding()
    let transport: Awaited<ReturnType<ProviderTransportOwner['acquire']>> | undefined
    try {
      transport = await this.transports.acquire({ activeTarget: target, plan })
      const resolvedTransport = transport
      const provider = resolvedTransport.provider ?? target.provider
      const providerModelCatalog =
        resolvedTransport.providerModelCatalog ?? plan.providerModelCatalog
      const responsesBridge = resolvedTransport.responsesBridge
      const usesCodexSystemProxy =
        framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)
      const proxyEnv = usesCodexSystemProxy
        ? await this.runtime.resolveCodexProxyEnvironment()
        : undefined

      const buildBackend = async (
        binding: AcquiredSkillRuntimeBinding | undefined,
        ownsProviderLeases: boolean
      ): Promise<ResolvedAgentBackend> => {
        const skillRuntime = this.skillRuntimes.view(binding)
        const instructions = this.skillRuntimes.connectorInstructions(binding)
        const persistentSystemPromptAppends = [
          ...(context.systemPromptAppends ?? []),
          ...(framework.id === 'codex' && instructions ? [instructions] : [])
        ]
        const modelConfig = framework.prepareModelConfig(provider, {
          storageRoot: this.storageRoot,
          executablePath,
          ...(codexNativeVersion ? { nativeVersion: codexNativeVersion } : {}),
          responsesBridge,
          reasoningEffort: sessionEffort,
          reasoningEfforts: supportedReasoningEfforts,
          providerModelCatalog,
          ...(skillRuntime ? { skillRuntime } : {}),
          instructions,
          ...(persistentSystemPromptAppends.length > 0
            ? { systemPromptAppends: persistentSystemPromptAppends }
            : {})
        })
        await this.runtime.materializeAgentConfigFiles(modelConfig.configFiles)
        const opencodeUsagePort =
          framework.id === 'opencode' ? await this.runtime.reserveOpenCodeUsagePort() : undefined
        const opencodeUsagePassword = opencodeUsagePort === undefined ? undefined : randomUUID()
        const sessionModel = modelConfig.sessionModel ?? provider.model
        return {
          framework,
          backendId: `${framework.id}:${backendProviderId}`,
          modelRoute,
          ...(modelRoute === 'codex-bridge' && responsesBridge?.continuityToken
            ? { providerContinuityToken: responsesBridge.continuityToken }
            : {}),
          executablePath,
          env: {
            ...(modelConfig.env ?? {}),
            ...(opencodeUsagePassword ? { OPENCODE_SERVER_PASSWORD: opencodeUsagePassword } : {}),
            ...(proxyEnv ?? {}),
            ...(resolvedTransport.environment ?? {}),
            ...(framework.id === 'codex' && settings.codex?.nativePath
              ? { CODEX_PATH: settings.codex.nativePath }
              : {})
          },
          ...(skillRuntime ? { skillRuntime } : {}),
          skillRuntimeHandoff: modelConfig.skillRuntimeHandoff,
          ...(binding ? { skillRuntimeLease: this.skillRuntimes.lease(binding) } : {}),
          args:
            opencodeUsagePort === undefined
              ? modelConfig.args
              : [
                  ...(modelConfig.args ?? []),
                  '--port',
                  String(opencodeUsagePort),
                  '--hostname',
                  '127.0.0.1'
                ],
          ...(usesCodexSystemProxy
            ? { proxyEnvironmentMode: proxyEnv === undefined ? 'inherit' : 'replace' }
            : {}),
          sessionModel,
          ...(framework.id === 'codex' && isCodexSubscriptionProvider(provider.type) && sessionModel
            ? { sessionModelRequired: true }
            : {}),
          sessionEffort,
          contextWindow: provider.contextWindow,
          ...(provider.supportsImageInput ? { supportsImageInput: true } : {}),
          contextUsageModel: provider.model,
          authentication: modelConfig.authentication,
          providerConfiguration: modelConfig.providerConfiguration,
          persistentSystemPrompt: modelConfig.persistentSystemPrompt,
          ...(opencodeUsagePort === undefined || !opencodeUsagePassword
            ? {}
            : {
                opencodeUsageApi: {
                  baseUrl: `http://127.0.0.1:${opencodeUsagePort}`,
                  authorization: `Basic ${Buffer.from(`opencode:${opencodeUsagePassword}`).toString('base64')}`
                }
              }),
          ...(ownsProviderLeases && responsesBridge?.lease
            ? { responsesBridgeLease: responsesBridge.lease }
            : {}),
          ...(ownsProviderLeases && resolvedTransport.providerTransportLease
            ? { providerTransportLease: resolvedTransport.providerTransportLease }
            : {})
        }
      }
      const backend = await buildBackend(skillBinding, true)
      this.skillRuntimes.register(backend, (binding) => buildBackend(binding, false))
      return backend
    } catch (error) {
      try {
        await transport?.release()
      } finally {
        if (skillBinding) await this.skillRuntimes.release(skillBinding).catch(() => undefined)
      }
      throw error
    }
  }

  private async resolveClaudeSpawnConfig(
    settings: StoredSettings,
    target: ProviderRuntimeTarget,
    forcedSkillIds: ReadonlySet<string>,
    resolvedExecutablePath?: string,
    modelConfig?: ClaudeRuntimeModelConfig
  ): Promise<AgentSpawnConfig> {
    const executablePath =
      resolvedExecutablePath ??
      (await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath))
    if (target.providerType === 'claude-shared' && target.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const provider = target.provider
    const appConfigDir = await this.runtime.provisionClaudeRuntimeConfig(
      settings,
      forcedSkillIds,
      modelConfig ?? null
    )
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })
    const sessionOptions =
      target.providerType === 'claude-shared'
        ? {
            settings: join(appConfigDir, 'settings.json'),
            plugins: [{ type: 'local', path: appConfigDir }]
          }
        : provider.type === 'custom'
          ? {
              settings: {
                skipWebFetchPreflight: true,
                permissions: { ask: ['WebFetch'] },
                ...(modelConfig ?? {})
              }
            }
          : undefined

    return {
      envOverrides,
      executablePath,
      sessionOptions,
      contextWindow: provider.contextWindow
    }
  }
}
