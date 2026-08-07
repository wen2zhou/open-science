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
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import type { SessionKey } from './session-records'
import type { AcpDelegateExecutionCallbacks, PreparedDelegateExecution } from './acp-execution'
import { assertClaudeCodeDelegatedWorkAvailable } from './claude-code-execution'
import { assertCodexLaunchIsolated } from './codex-execution'
import type { DelegateExecutionInput } from './execution-port'
import { assertOpenCodeNativeDelegationDisabled } from './opencode-execution'
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

const assertResolvedBackendAvailable = (
  frameworkId: PersistedChatSession['agentFrameworkId'],
  backend: ResolvedAgentBackend,
  runtimeHome: string
): void => {
  if (backend.framework.id !== frameworkId) {
    throw new Error('Resolved delegated backend does not match the Session framework.')
  }
  if (frameworkId === 'claude-code') {
    assertClaudeCodeDelegatedWorkAvailable(sessionSetup(backend))
    return
  }
  if (frameworkId === 'opencode') {
    assertOpenCodeNativeDelegationDisabled(openCodeModelConfig(backend))
    return
  }
  if (frameworkId === 'codex') {
    const spawn = {
      executablePath: backend.executablePath,
      args: [...(backend.args ?? [])],
      env: { ...backend.env, HOME: runtimeHome, CODEX_HOME: runtimeHome },
      proxyEnvironmentMode: backend.proxyEnvironmentMode
    }
    assertCodexLaunchIsolated(spawn, runtimeHome, {
      nativeVersion: CODEX_VERSION,
      adapterVersion: CODEX_ACP_VERSION
    })
  }
}

const createProductionDelegatedFrameworkRuntime = (
  options: ProductionFrameworkRuntimeOptions
): ProductionDelegatedFrameworks =>
  createProductionDelegatedFrameworks({
    capacity: options.capacity,
    async certify(session) {
      const frameworkId = session.agentFrameworkId
      if (!frameworkId) throw new Error('Delegated Work Session has no framework identity.')
      const auditRuntimeHome = join(options.dataRoot, 'delegated-work', '.certification')
      const preparedAttempts = new Map<
        string,
        Readonly<{ backend: ResolvedAgentBackend; connection: NotebookRpcConnection }>
      >()
      const assertProviderAvailable = async (): Promise<void> => {
        const backend = await options.runtime.settingsService.resolveAgentBackend({ frameworkId })
        try {
          assertResolvedBackendAvailable(frameworkId, backend, auditRuntimeHome)
        } finally {
          await releaseBackendLeases(backend)
        }
      }
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
          preparedAttempts.set(input.attemptId, { backend, connection: capability })
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
            ...(input.artifactCurrentRunFile
              ? { artifactCurrentRunFile: input.artifactCurrentRunFile }
              : {}),
            async disposeResources() {
              const owned = preparedAttempts.get(input.attemptId)
              preparedAttempts.delete(input.attemptId)
              if (owned) await releaseBackendLeases(owned.backend)
              await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
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
            ...(scope.artifactCurrentRunFile
              ? { delegatedArtifactCurrentRunFile: scope.artifactCurrentRunFile }
              : {}),
            ...(agentProcess ? { spawnAgent: () => agentProcess } : {})
          })
        } catch (error) {
          void releaseBackendLeases(owned.backend)
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
