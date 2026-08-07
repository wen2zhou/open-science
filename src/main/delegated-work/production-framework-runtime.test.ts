import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import {
  claudeCodeFramework,
  codexFramework,
  opencodeFramework,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createProductionDelegatedFrameworkRuntime } from './production-framework-runtime'

const safeOpenCodeConfig = JSON.stringify({
  permission: { task: 'deny' },
  agent: {
    general: { disable: true },
    explore: { disable: true },
    scout: { disable: true }
  }
})

const session = (frameworkId: AgentFrameworkId): PersistedChatSession => ({
  id: `session-${frameworkId}`,
  projectId: 'project-1',
  title: frameworkId,
  cwd: '/root',
  status: 'idle',
  agentFrameworkId: frameworkId,
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 1
})

const backend = (frameworkId: AgentFrameworkId): ResolvedAgentBackend => {
  if (frameworkId === 'claude-code') {
    return {
      framework: claudeCodeFramework,
      executablePath: '/claude-agent-acp.js',
      env: {}
    }
  }
  if (frameworkId === 'opencode') {
    return {
      framework: opencodeFramework,
      executablePath: '/opencode',
      env: {
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_CONFIG_CONTENT: safeOpenCodeConfig
      }
    }
  }
  return {
    framework: codexFramework,
    executablePath: '/codex-acp.js',
    env: {
      CODEX_CONFIG: JSON.stringify({
        features: { multi_agent: false, multi_agent_v2: false }
      })
    }
  }
}

describe('production delegated framework runtime bridge', () => {
  it('certifies each durable framework through its exact resolved production backend', async () => {
    const selected: AgentFrameworkId[] = []
    const release = vi.fn(async () => undefined)
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 3,
      dataRoot: '/data',
      runtime: {
        settingsService: {
          async resolveAgentBackend({ frameworkId }: { frameworkId: AgentFrameworkId }) {
            selected.push(frameworkId)
            return {
              ...backend(frameworkId),
              providerTransportLease: { setTarget: () => true, release }
            }
          }
        }
      } as never,
      notebookRpcServer: () => {
        throw new Error('runtime must not start during pre-admission certification')
      },
      readSession: async () => undefined
    })

    for (const frameworkId of ['claude-code', 'opencode', 'codex'] as const) {
      const certified = await frameworks.forSession(session(frameworkId))
      expect(certified.frameworkId).toBe(frameworkId)
      await expect(certified.assertAvailable()).resolves.toBeUndefined()
    }

    expect(selected).toEqual(['claude-code', 'opencode', 'codex'])
    expect(release).toHaveBeenCalledTimes(3)
  })
})
