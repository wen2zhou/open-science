import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import {
  filterSpecialistConnectorSkills,
  resolveEffectiveSpecialistSkills
} from '../../shared/specialist'
import {
  releaseResolvedAgentBackendLeases,
  type AgentModelConfig,
  type ResolvedAgentBackend,
  type SessionSetup
} from '../agent-framework'
import { createAcpRuntime, type AcpRuntimeCompositionOptions } from '../acp/runtime-composition'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type { SessionKey } from './session-records'
import type { AcpDelegateExecutionCallbacks, PreparedDelegateExecution } from './acp-execution'
import type { DelegateExecutionInput } from './execution-port'
import {
  createProductionDelegatedFrameworks,
  type PreparedProductionFrameworkScope,
  type ProductionDelegatedFrameworks
} from './production-frameworks'

type ProductionFrameworkRuntimeOptions = Readonly<{
  capacity: number
  dataRoot: string
  runtime: Omit<
    AcpRuntimeCompositionOptions,
    | 'notebookRpcServer'
    | 'fixedBackend'
    | 'runtimeCallbacks'
    | 'delegatedNotebookConnection'
    | 'delegatedArtifactCurrentRunFile'
    | 'spawnAgent'
    | 'delegatedWork'
  >
  notebookRpcServer(): NotebookLocalRpcServer
  readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
  resolvePermissionProfile?(sessionId: string): PermissionProfileId | undefined
}>

const openCodeModelConfig = (backend: ResolvedAgentBackend): AgentModelConfig => ({
  env: { ...backend.env },
  configFiles: [
    {
      path: 'opencode.json',
      content: backend.env.OPENCODE_CONFIG_CONTENT ?? '{}'
    }
  ]
})

const sessionSetup = (backend: ResolvedAgentBackend): SessionSetup =>
  backend.framework.buildSessionSetup({
    systemPromptAppends: [
      ...(backend.systemPromptAppends ?? []),
      ...(backend.persistentSystemPrompt ? [backend.persistentSystemPrompt] : [])
    ],
    ...(backend.sessionOptions ? { sessionOptions: backend.sessionOptions } : {})
  })

const createProductionDelegatedFrameworkRuntime = (
  options: ProductionFrameworkRuntimeOptions
): ProductionDelegatedFrameworks =>
  createProductionDelegatedFrameworks({
    capacity: options.capacity,
    async certify(session) {
      const frameworkId = session.agentFrameworkId
      if (!frameworkId) throw new Error('Delegated Work Session has no framework identity.')
      const preparedAttempts = new Map<
        string,
        Readonly<{
          backend: ResolvedAgentBackend
          connection: NotebookRpcConnection
          releaseBackend: boolean
        }>
      >()
      const cleanupPreparedBackend = async (
        backend: ResolvedAgentBackend,
        runtimeHome: string,
        releaseBackend: boolean
      ): Promise<void> => {
        const [releaseResult] = await Promise.allSettled([
          releaseBackend
            ? Promise.resolve().then(() => releaseResolvedAgentBackendLeases(backend))
            : Promise.resolve(),
          rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
        ])
        if (releaseResult.status === 'rejected') throw releaseResult.reason
      }
      // The exact provider/model is validated by admission's model resolver. This certification hook
      // must not read the process-wide Active model, which may differ from the originating Session.
      const assertProviderAvailable = async (): Promise<void> => undefined
      const prepare = async (
        input: DelegateExecutionInput
      ): Promise<PreparedProductionFrameworkScope> => {
        if (!input.workspaceCwd) throw new Error('Delegated Attempt has no prepared Frame cwd.')
        if (!input.executionModel) {
          throw new Error('Delegated Attempt has no admitted model snapshot.')
        }
        if (!input.executionBackend || !input.forkExecutionBackendSkillRuntime) {
          throw new Error('Delegated Attempt has no admitted backend capability.')
        }
        const specialistAllowedSkillIds = input.profile
          ? await resolveSpecialistAllowedSkillIds(input.profile)
          : undefined
        // Provider/model/transport stay pinned to the admission snapshot even if settings change or
        // the provider is deleted. Only Skill projection/state is forked per Attempt so siblings never
        // share writable roots; Specialist children additionally narrow native discovery exactly.
        const releaseResolvedBackend = true
        const backend = await input.forkExecutionBackendSkillRuntime(
          specialistAllowedSkillIds
            ? {
                kind: 'exact',
                allowedSkillIds: specialistAllowedSkillIds
              }
            : { kind: 'main' }
        )
        if (backend.framework.id !== frameworkId) {
          if (releaseResolvedBackend) await releaseResolvedAgentBackendLeases(backend)
          throw new Error('Resolved delegated backend changed framework during admission.')
        }
        const runtimeHome = join(
          options.dataRoot,
          'delegation',
          input.session.projectId,
          input.session.sessionId,
          'runtime',
          input.attemptId
        )
        try {
          await mkdir(runtimeHome, { recursive: true, mode: 0o700 })
          const durable = await options.readSession(input.session)
          const graph = durable && materializeSessionConversationGraph(durable).conversationGraph
          const frame = graph?.frames.find((candidate) => candidate.id === input.frameId)
          const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)
          const prompt = graph?.messages.find(
            (candidate) => candidate.id === branch?.headMessageId && candidate.role === 'user'
          )
          if (!durable || !graph || !frame || !branch || !prompt) {
            throw new Error('Delegated Attempt has no durable Frame provenance.')
          }
          const capability = await options.notebookRpcServer().issueDelegatedNotebookConnection({
            projectId: input.session.projectId,
            sessionId: input.session.sessionId,
            rootFrameId: graph.rootFrameId,
            agentFrameId: input.frameId,
            attemptId: input.attemptId,
            messageBranchId: branch.id,
            runtimeSegmentId: input.runtimeSegmentId,
            promptMessageId: prompt.id,
            workspaceCwd: input.workspaceCwd,
            isAttemptWritable: async () => {
              const latest = await options.readSession(input.session)
              const attempt = latest?.runtimeContext?.delegatedWork?.records
                .find((record) => record.agentFrameId === input.frameId)
                ?.attempts.at(-1)
              return attempt?.id === input.attemptId && attempt.status === 'running'
            }
          })
          preparedAttempts.set(input.attemptId, {
            backend,
            connection: capability,
            releaseBackend: releaseResolvedBackend
          })
          const base: PreparedDelegateExecution = {
            executionId: input.attemptId,
            provenance: {
              projectId: input.session.projectId,
              sessionId: input.session.sessionId,
              agentFrameId: input.frameId,
              runtimeSegmentId: input.runtimeSegmentId,
              promptMessageId: prompt.id,
              messageBranchId: branch.id
            },
            workspace: { cwd: input.workspaceCwd },
            runtimeHome,
            frameworkId,
            permissionProfile:
              options.resolvePermissionProfile?.(input.session.sessionId) ??
              durable.permissionProfile ??
              DEFAULT_PERMISSION_PROFILE,
            capability,
            ...(input.artifactCurrentRunFile
              ? { artifactCurrentRunFile: input.artifactCurrentRunFile }
              : {}),
            async disposeResources() {
              const owned = preparedAttempts.get(input.attemptId)
              preparedAttempts.delete(input.attemptId)
              await cleanupPreparedBackend(
                owned?.backend ?? backend,
                runtimeHome,
                owned?.releaseBackend ?? false
              )
            }
          }
          if (frameworkId === 'claude-code') {
            return { ...base, sessionSetup: sessionSetup(backend) }
          }
          if (frameworkId === 'opencode') {
            return { ...base, modelConfig: openCodeModelConfig(backend) }
          }
          if (frameworkId === 'codex') {
            return {
              ...base,
              spawn: {
                executablePath: backend.executablePath,
                args: [...(backend.args ?? [])],
                env: {
                  ...backend.env,
                  HOME: runtimeHome,
                  CODEX_HOME: runtimeHome
                },
                proxyEnvironmentMode: backend.proxyEnvironmentMode
              }
            }
          }
          const unsupported: never = frameworkId
          throw new Error(`Unsupported delegated-work framework: ${String(unsupported)}`)
        } catch (error) {
          preparedAttempts.delete(input.attemptId)
          await cleanupPreparedBackend(backend, runtimeHome, releaseResolvedBackend).catch(
            () => undefined
          )
          throw error
        }
      }

      const resolveSpecialistAllowedSkillIds = async (specialistId: string): Promise<string[]> => {
        const profiles = options.runtime.profileService
        if (!profiles) throw new Error('Specialist profile resolution is unavailable.')
        const profile = await profiles.resolveRunnableById(specialistId)
        if (!profile.enabled) throw new Error('The delegated Specialist is disabled.')
        const effective = resolveEffectiveSpecialistSkills(
          profile,
          await options.runtime.settingsService.listSpecialistSkillCatalog()
        )
        if (effective.kind !== 'specialist') {
          throw new Error('The delegated Specialist Skill scope is unavailable.')
        }
        const connectorSkills = filterSpecialistConnectorSkills(
          await options.runtime.settingsService.provisionedConnectorSkillNames(),
          profile
        )
        return [...new Set([...effective.skillIds, ...connectorSkills])]
      }
      const createRuntime = (
        scope: PreparedProductionFrameworkScope,
        callbacks: AcpDelegateExecutionCallbacks,
        agentProcess?: ChildProcessWithoutNullStreams
      ): ReturnType<typeof createAcpRuntime> => {
        const owned = preparedAttempts.get(scope.executionId)
        if (!owned) throw new Error('Delegated runtime scope is unavailable.')
        preparedAttempts.delete(scope.executionId)
        try {
          return createAcpRuntime({
            ...options.runtime,
            notebookRpcServer: options.notebookRpcServer(),
            fixedBackend: owned.backend,
            runtimeCallbacks: callbacks,
            delegatedNotebookConnection: owned.connection,
            permissionGrantContext: {
              projectId: scope.provenance.projectId,
              sessionId: scope.provenance.sessionId
            },
            ...(scope.artifactCurrentRunFile
              ? { delegatedArtifactCurrentRunFile: scope.artifactCurrentRunFile }
              : {}),
            ...(agentProcess ? { spawnAgent: () => agentProcess } : {})
          })
        } catch (error) {
          void cleanupPreparedBackend(owned.backend, scope.runtimeHome, owned.releaseBackend).catch(
            () => undefined
          )
          throw error
        }
      }

      return {
        frameworkId,
        assertProviderAvailable,
        prepare,
        createRuntime
      }
    }
  })

export { createProductionDelegatedFrameworkRuntime }
export type { ProductionFrameworkRuntimeOptions }
