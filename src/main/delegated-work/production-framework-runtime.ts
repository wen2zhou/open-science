import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { AgentModelConfig, ResolvedAgentBackend, SessionSetup } from '../agent-framework'
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
    | 'spawnAgent'
    | 'delegatedWork'
  >
  notebookRpcServer(): NotebookLocalRpcServer
  readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
}>

const releaseBackendLeases = async (backend: ResolvedAgentBackend): Promise<void> => {
  await Promise.allSettled([
    backend.responsesBridgeLease?.release(),
    backend.anthropicBridgeLease?.release(),
    backend.providerTransportLease?.release()
  ])
}

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
      const auditBackend = await options.runtime.settingsService.resolveAgentBackend({
        frameworkId
      })
      if (auditBackend.framework.id !== frameworkId) {
        await releaseBackendLeases(auditBackend)
        throw new Error('Resolved delegated backend does not match the Session framework.')
      }
      const auditRuntimeHome = join(options.dataRoot, 'delegated-work', '.certification')
      let auditModelConfig: AgentModelConfig | undefined
      let auditSessionSetup: ReturnType<typeof sessionSetup> | undefined
      try {
        auditModelConfig =
          frameworkId === 'opencode' ? openCodeModelConfig(auditBackend) : undefined
        auditSessionSetup = frameworkId === 'claude-code' ? sessionSetup(auditBackend) : undefined
      } finally {
        await releaseBackendLeases(auditBackend)
      }

      const backends = new Map<string, ResolvedAgentBackend>()
      const connections = new Map<string, NotebookRpcConnection>()
      const claimedBackends = new Set<string>()
      const prepare = async (
        input: DelegateExecutionInput
      ): Promise<PreparedProductionFrameworkScope> => {
        if (!input.workspaceCwd) throw new Error('Delegated Attempt has no prepared Frame cwd.')
        const backend = await options.runtime.settingsService.resolveAgentBackend({ frameworkId })
        if (backend.framework.id !== frameworkId) {
          await releaseBackendLeases(backend)
          throw new Error('Resolved delegated backend changed framework during admission.')
        }
        const runtimeHome = join(
          options.dataRoot,
          'delegated-work',
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
          backends.set(input.attemptId, backend)
          connections.set(input.attemptId, capability)
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
            capability,
            async disposeResources() {
              connections.delete(input.attemptId)
              const unclaimed = !claimedBackends.delete(input.attemptId)
              const owned = backends.get(input.attemptId)
              backends.delete(input.attemptId)
              if (unclaimed && owned) await releaseBackendLeases(owned)
              await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
            }
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
          return base
        } catch (error) {
          backends.delete(input.attemptId)
          connections.delete(input.attemptId)
          await releaseBackendLeases(backend)
          await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
      }
      const createRuntime = (
        scope: PreparedProductionFrameworkScope,
        callbacks: AcpDelegateExecutionCallbacks,
        agentProcess?: ChildProcessWithoutNullStreams
      ): ReturnType<typeof createAcpRuntime> => {
        const backend = backends.get(scope.executionId)
        const connection = connections.get(scope.executionId)
        if (!backend || !connection) throw new Error('Delegated runtime scope is unavailable.')
        const runtime = createAcpRuntime({
          ...options.runtime,
          notebookRpcServer: options.notebookRpcServer(),
          fixedBackend: backend,
          runtimeCallbacks: callbacks,
          delegatedNotebookConnection: connection,
          ...(agentProcess ? { spawnAgent: () => agentProcess } : {})
        })
        claimedBackends.add(scope.executionId)
        return runtime
      }

      return {
        frameworkId,
        ...(auditSessionSetup ? { sessionSetup: auditSessionSetup } : {}),
        ...(auditModelConfig ? { modelConfig: auditModelConfig } : {}),
        ...(frameworkId === 'codex'
          ? {
              codexSpawn: {
                executablePath: auditBackend.executablePath,
                args: [...(auditBackend.args ?? [])],
                env: {
                  ...auditBackend.env,
                  HOME: auditRuntimeHome,
                  CODEX_HOME: auditRuntimeHome
                },
                proxyEnvironmentMode: auditBackend.proxyEnvironmentMode
              }
            }
          : {}),
        prepare,
        createRuntime
      }
    }
  })

export { createProductionDelegatedFrameworkRuntime }
export type { ProductionFrameworkRuntimeOptions }
