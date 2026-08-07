import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  SessionSetup
} from '../agent-framework'
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import type {
  AcpDelegateExecutionCallbacks,
  AcpDelegateRuntime,
  PreparedDelegateExecution
} from './acp-execution'
import {
  assertClaudeCodeDelegatedWorkAvailable,
  createClaudeCodeDelegateExecution
} from './claude-code-execution'
import {
  assertCodexLaunchIsolated,
  createCodexDelegateExecution,
  type CodexRuntimeIdentity,
  type PreparedCodexDelegateExecution
} from './codex-execution'
import type { DelegateExecution, DelegateExecutionInput } from './execution-port'
import {
  assertOpenCodeNativeDelegationDisabled,
  createOpenCodeDelegateExecution,
  type PreparedOpenCodeDelegateExecution
} from './opencode-execution'

type PreparedProductionFrameworkScope =
  PreparedDelegateExecution | PreparedOpenCodeDelegateExecution | PreparedCodexDelegateExecution

type ProductionFrameworkCertification = Readonly<{
  frameworkId: AgentFrameworkId
  sessionSetup?: SessionSetup
  modelConfig?: AgentModelConfig
  codexRuntime?: CodexRuntimeIdentity
  codexSpawn?: AgentSpawnInput
  codexFramework?: Pick<AgentFramework, 'spawn'>
  assertProviderAvailable?(): Promise<void> | void
  prepare(
    input: DelegateExecutionInput
  ): Promise<PreparedProductionFrameworkScope> | PreparedProductionFrameworkScope
  createRuntime(
    scope: PreparedProductionFrameworkScope,
    callbacks: AcpDelegateExecutionCallbacks,
    agentProcess?: ChildProcessWithoutNullStreams
  ): AcpDelegateRuntime
}>

type ProductionDelegatedFrameworksOptions = Readonly<{
  capacity: number
  certify(session: PersistedChatSession): Promise<ProductionFrameworkCertification>
}>

type ProductionDelegatedFrameworks = Readonly<{
  forSession(session: PersistedChatSession): Promise<{
    frameworkId: AgentFrameworkId
    execution: DelegateExecution
    assertAvailable(): Promise<void>
  }>
}>

const requireOpenCodeConfig = (
  certification: ProductionFrameworkCertification
): AgentModelConfig => {
  if (!certification.modelConfig) {
    throw new Error('OpenCode delegated execution requires its authoritative model config.')
  }
  return certification.modelConfig
}

const requireCodexRuntime = (
  certification: ProductionFrameworkCertification
): CodexRuntimeIdentity =>
  certification.codexRuntime ?? {
    nativeVersion: CODEX_VERSION,
    adapterVersion: CODEX_ACP_VERSION
  }

const requireCodexSpawn = (certification: ProductionFrameworkCertification): AgentSpawnInput => {
  if (!certification.codexSpawn) {
    throw new Error('Codex delegated execution requires its authoritative launch configuration.')
  }
  return certification.codexSpawn
}

const createProductionDelegatedFrameworks = (
  options: ProductionDelegatedFrameworksOptions
): ProductionDelegatedFrameworks => ({
  async forSession(session) {
    const frameworkId = session.agentFrameworkId
    if (!frameworkId) throw new Error('Delegated Work Session has no framework identity.')
    const certification = await options.certify(session)
    if (certification.frameworkId !== frameworkId) {
      throw new Error('Delegated Work certification does not match the Session framework.')
    }

    if (frameworkId === 'claude-code') {
      assertClaudeCodeDelegatedWorkAvailable(certification.sessionSetup)
      const execution = createClaudeCodeDelegateExecution({
        capacity: options.capacity,
        prepare: (input) => certification.prepare(input) as Promise<PreparedDelegateExecution>,
        sessionSetup: () => certification.sessionSetup ?? {},
        createRuntime: (scope, callbacks) => certification.createRuntime(scope, callbacks)
      })
      return Object.freeze({
        frameworkId,
        execution,
        async assertAvailable() {
          assertClaudeCodeDelegatedWorkAvailable(certification.sessionSetup)
          await certification.assertProviderAvailable?.()
        }
      })
    }

    if (frameworkId === 'opencode') {
      const modelConfig = requireOpenCodeConfig(certification)
      assertOpenCodeNativeDelegationDisabled(modelConfig)
      const execution = createOpenCodeDelegateExecution({
        capacity: options.capacity,
        certificationConfig: () => modelConfig,
        prepare: (input) =>
          certification.prepare(input) as Promise<PreparedOpenCodeDelegateExecution>,
        createRuntime: (scope, callbacks) => certification.createRuntime(scope, callbacks)
      })
      return Object.freeze({
        frameworkId,
        execution,
        async assertAvailable() {
          assertOpenCodeNativeDelegationDisabled(modelConfig)
          await certification.assertProviderAvailable?.()
        }
      })
    }

    if (frameworkId === 'codex') {
      const codexRuntime = requireCodexRuntime(certification)
      const codexSpawn = requireCodexSpawn(certification)
      assertCodexLaunchIsolated(codexSpawn, codexSpawn.env.CODEX_HOME ?? '', codexRuntime)
      const codex = createCodexDelegateExecution({
        capacity: options.capacity,
        runtime: codexRuntime,
        framework: certification.codexFramework,
        prepare: (input) => certification.prepare(input) as Promise<PreparedCodexDelegateExecution>,
        createRuntime: (scope, callbacks, agentProcess) =>
          certification.createRuntime(scope, callbacks, agentProcess),
        assertProviderAvailable: certification.assertProviderAvailable
      })
      await codex.assertAvailable()
      return Object.freeze({
        frameworkId,
        execution: codex.execution,
        assertAvailable: codex.assertAvailable
      })
    }

    const unsupported: never = frameworkId
    throw new Error(`Unsupported delegated-work framework: ${String(unsupported)}`)
  }
})

export { createProductionDelegatedFrameworks }
export type {
  PreparedProductionFrameworkScope,
  ProductionDelegatedFrameworks,
  ProductionDelegatedFrameworksOptions,
  ProductionFrameworkCertification
}
