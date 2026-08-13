import { describe, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const delegatedSession = (frameworkId: AgentFrameworkId): PersistedChatSession => ({
  ...session(frameworkId),
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root-frame',
    activeFrameId: 'child-frame',
    frames: [
      {
        id: 'root-frame',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'root-branch',
        createdAt: 1,
        completedAt: 2
      },
      {
        id: 'child-frame',
        parentFrameId: 'root-frame',
        originMessageId: 'root-prompt',
        originBindingState: 'validated',
        kind: 'delegate',
        status: 'running',
        activeBranchId: 'child-branch',
        createdAt: 2
      }
    ],
    branches: [
      {
        id: 'root-branch',
        agentFrameId: 'root-frame',
        headMessageId: 'root-prompt',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-branch',
        agentFrameId: 'child-frame',
        headMessageId: 'child-prompt',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    messages: [
      {
        id: 'root-prompt',
        role: 'user',
        content: 'Coordinate',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        agentFrameId: 'root-frame',
        introducedOnBranchId: 'root-branch',
        revisionRootMessageId: 'root-prompt'
      },
      {
        id: 'child-prompt',
        role: 'user',
        content: 'Investigate',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt'
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: []
  }
})

describe('production delegated framework runtime bridge', () => {
  it('prepares an admitted Attempt after its provider was deleted', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-framework-deleted-provider-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-framework-workspace-'))
    const resolveAdmittedSubagentBackend = vi.fn(async () => {
      throw new Error('configured provider is unavailable')
    })
    const issueDelegatedNotebookConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:1',
      token: 'attempt-token',
      release: () => undefined,
      revoke: async () => undefined
    }))
    const durable = delegatedSession('opencode')
    const admittedBackend = backend('opencode')
    const forkExecutionBackendSkillRuntime = vi.fn(async () => admittedBackend)
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: { settingsService: { resolveAdmittedSubagentBackend } } as never,
      notebookRpcServer: () => ({ issueDelegatedNotebookConnection }) as never,
      readSession: async () => durable
    })

    try {
      const selected = await frameworks.forSession(session('opencode'))
      const reservation = await selected.execution.reserve(1)
      const executionModel = {
        frameworkId: 'opencode' as const,
        providerId: 'deleted-provider',
        backendId: 'opencode:deleted-provider',
        modelRoute: 'opencode-openai' as const,
        model: 'admitted-model',
        reasoningEffort: 'high' as const
      }
      const running = selected.execution.run(
        {
          session: { projectId: 'project-1', sessionId: 'session-opencode' },
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          runtimeSegmentId: 'runtime-1',
          executionModel,
          executionBackend: admittedBackend,
          forkExecutionBackendSkillRuntime,
          task: 'Investigate',
          inputs: [],
          workspaceCwd,
          continuation: true
        },
        reservation.slotIds[0]
      )

      await expect(running.completion).rejects.not.toThrow('configured provider is unavailable')
      expect(forkExecutionBackendSkillRuntime).toHaveBeenCalledWith({ kind: 'main' })
      expect(resolveAdmittedSubagentBackend).not.toHaveBeenCalled()
      expect(issueDelegatedNotebookConnection).toHaveBeenCalledOnce()
    } finally {
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })

  it('resolves sibling ordinary Attempts with distinct Skill Runtime state and leases', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-framework-sibling-state-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-framework-workspace-'))
    const resolved: ResolvedAgentBackend[] = []
    const releases = [vi.fn(async () => undefined), vi.fn(async () => undefined)]
    const forkExecutionBackendSkillRuntime = vi.fn(async () => {
      const index = resolved.length
      const result: ResolvedAgentBackend = {
        ...backend('opencode'),
        env: { TMPDIR: `/attempt-${index + 1}/temporary` },
        skillRuntime: {
          generationRoot: '/projection/g1',
          skillsRoot: '/projection/g1/skills',
          discoveryRoot: `/projection/discovery/attempt-${index + 1}`,
          descriptors: [],
          environment: { TMPDIR: `/attempt-${index + 1}/temporary` }
        },
        skillRuntimeLease: { release: releases[index] }
      }
      resolved.push(result)
      return result
    })
    const durable = delegatedSession('opencode')
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 2,
      dataRoot,
      runtime: { settingsService: {} } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => ({
            endpoint: 'http://127.0.0.1:1',
            token: 'attempt-token',
            release: () => undefined,
            revoke: async () => undefined
          })
        }) as never,
      readSession: async () => durable
    })

    try {
      const selected = await frameworks.forSession(durable)
      const reservation = await selected.execution.reserve(2)
      const executionModel = {
        frameworkId: 'opencode' as const,
        providerId: 'provider-a',
        backendId: 'opencode:provider-a',
        modelRoute: 'opencode-openai' as const,
        model: 'admitted-model',
        reasoningEffort: 'high' as const
      }
      const attempts = reservation.slotIds.map((slotId, index) =>
        selected.execution.run(
          {
            session: { projectId: 'project-1', sessionId: 'session-opencode' },
            frameId: 'child-frame',
            attemptId: `attempt-${index + 1}`,
            runtimeSegmentId: `runtime-${index + 1}`,
            executionModel,
            executionBackend: backend('opencode'),
            forkExecutionBackendSkillRuntime,
            task: 'Investigate',
            inputs: [],
            workspaceCwd,
            continuation: true
          },
          slotId
        )
      )

      await vi.waitFor(() => expect(forkExecutionBackendSkillRuntime).toHaveBeenCalledTimes(2))
      expect(forkExecutionBackendSkillRuntime).toHaveBeenNthCalledWith(1, { kind: 'main' })
      expect(forkExecutionBackendSkillRuntime).toHaveBeenNthCalledWith(2, { kind: 'main' })
      expect(resolved.map((item) => item.skillRuntime?.environment.TMPDIR)).toEqual([
        '/attempt-1/temporary',
        '/attempt-2/temporary'
      ])
      await Promise.all(attempts.map((attempt) => attempt.cancel()))
      await Promise.all(attempts.map((attempt) => attempt.completion.catch(() => undefined)))
      expect(releases[0]).toHaveBeenCalledOnce()
      expect(releases[1]).toHaveBeenCalledOnce()
    } finally {
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })

  it('forks a Specialist Attempt with its exact current Skill scope', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-framework-specialist-scope-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-framework-workspace-'))
    const release = vi.fn(async () => undefined)
    const forkExecutionBackendSkillRuntime = vi.fn(async () => ({
      ...backend('opencode'),
      providerTransportLease: { setTarget: () => true, release }
    }))
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: {
        settingsService: {
          listSpecialistSkillCatalog: async () => [
            { id: 'specialist-package', frameworkName: 'specialist-package' },
            { id: 'unrelated-package', frameworkName: 'unrelated-package' }
          ],
          provisionedConnectorSkillNames: async () => ['mcp-pubmed', 'mcp-zotero']
        },
        profileService: {
          resolveRunnableById: async () => ({
            id: 'specialist-1',
            enabled: true,
            capabilityMode: 'selected',
            fullAccess: {
              excludedSkillIds: [],
              excludedConnectorIds: [],
              connectorTools: []
            },
            selectedCapabilities: {
              skillIds: ['specialist-package'],
              connectorIds: ['pubmed'],
              connectorTools: []
            }
          })
        }
      } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => ({
            endpoint: 'http://127.0.0.1:1',
            token: 'attempt-token',
            release: () => undefined,
            revoke: async () => undefined
          })
        }) as never,
      readSession: async () => delegatedSession('opencode')
    })

    try {
      const selected = await frameworks.forSession(delegatedSession('opencode'))
      const reservation = await selected.execution.reserve(1)
      const executionModel = {
        frameworkId: 'opencode' as const,
        providerId: 'provider-a',
        backendId: 'opencode:provider-a',
        modelRoute: 'opencode-openai' as const,
        model: 'admitted-model',
        reasoningEffort: 'high' as const
      }
      const running = selected.execution.run(
        {
          session: { projectId: 'project-1', sessionId: 'session-opencode' },
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          runtimeSegmentId: 'runtime-1',
          executionModel,
          executionBackend: backend('opencode'),
          forkExecutionBackendSkillRuntime,
          task: 'Investigate',
          inputs: [],
          workspaceCwd,
          profile: 'specialist-1',
          continuation: true
        },
        reservation.slotIds[0]
      )

      await vi.waitFor(() => {
        expect(forkExecutionBackendSkillRuntime).toHaveBeenCalledWith({
          kind: 'exact',
          allowedSkillIds: ['specialist-package', 'mcp-pubmed']
        })
      })
      await running.cancel()
      await running.completion.catch(() => undefined)
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })

  it('certifies framework availability without consulting the process Active model', async () => {
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
      const selectionsBeforeComposition = selected.length
      const certified = await frameworks.forSession(session(frameworkId))
      expect(certified.frameworkId).toBe(frameworkId)
      expect(selected).toHaveLength(selectionsBeforeComposition)
      await expect(certified.assertAvailable()).resolves.toBeUndefined()
    }

    expect(selected).toEqual([])
    expect(release).not.toHaveBeenCalled()
  })

  it('keeps Session certification non-secret and defers exact model resolution to Attempt preparation', async () => {
    const release = vi.fn(async () => undefined)
    const resolveAgentBackend = vi.fn(async () => ({
      ...backend('opencode'),
      env: {
        ...backend('opencode').env,
        OPENAI_API_KEY: 'attempt-only-secret'
      },
      providerTransportLease: { setTarget: () => true, release }
    }))
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot: '/data',
      runtime: { settingsService: { resolveAgentBackend } } as never,
      notebookRpcServer: () => {
        throw new Error('runtime must not start during pre-admission certification')
      },
      readSession: async () => undefined
    })

    const certified = await frameworks.forSession(session('opencode'))

    expect(resolveAgentBackend).not.toHaveBeenCalled()
    expect(JSON.stringify(certified)).not.toContain('attempt-only-secret')

    await certified.assertAvailable()

    expect(resolveAgentBackend).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(JSON.stringify(certified)).not.toContain('attempt-only-secret')
  })

  it('keeps the admitted backend snapshot when Settings change before an Attempt', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-framework-fresh-attempt-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-framework-workspace-'))
    const release = vi.fn(async () => {
      throw new Error('temporary Skill cleanup failure')
    })
    let currentConfig = safeOpenCodeConfig
    const admittedBackend: ResolvedAgentBackend = {
      ...backend('opencode'),
      env: {
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_CONFIG_CONTENT: safeOpenCodeConfig,
        OPENAI_API_KEY: 'old-secret'
      },
      skillRuntimeLease: { release }
    }
    const forkExecutionBackendSkillRuntime = vi.fn(async () => admittedBackend)
    const durable: PersistedChatSession = {
      ...session('opencode'),
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'root-frame',
        activeFrameId: 'child-frame',
        frames: [
          {
            id: 'root-frame',
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: 'root-branch',
            createdAt: 1,
            completedAt: 2
          },
          {
            id: 'child-frame',
            parentFrameId: 'root-frame',
            originMessageId: 'root-prompt',
            originBindingState: 'validated',
            kind: 'delegate',
            status: 'running',
            activeBranchId: 'child-branch',
            createdAt: 2
          }
        ],
        branches: [
          {
            id: 'root-branch',
            agentFrameId: 'root-frame',
            headMessageId: 'root-prompt',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'child-branch',
            agentFrameId: 'child-frame',
            headMessageId: 'child-prompt',
            createdAt: 2,
            updatedAt: 2
          }
        ],
        messages: [
          {
            id: 'root-prompt',
            role: 'user',
            content: 'Coordinate',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1,
            agentFrameId: 'root-frame',
            introducedOnBranchId: 'root-branch',
            revisionRootMessageId: 'root-prompt'
          },
          {
            id: 'child-prompt',
            role: 'user',
            content: 'Investigate',
            status: 'complete',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2,
            agentFrameId: 'child-frame',
            introducedOnBranchId: 'child-branch',
            revisionRootMessageId: 'child-prompt'
          }
        ],
        activities: [],
        activityGroups: [],
        runtimeSegments: []
      },
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  status: 'running',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: ['runtime-1'],
                  startedAt: 2
                }
              ]
            }
          ]
        }
      }
    }
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: {
        settingsService: {
          resolveAdmittedSubagentBackend: vi.fn(async () => {
            throw new Error('current Settings must not be re-resolved')
          })
        }
      } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => {
            throw new Error('attempt stopped after backend preparation')
          }
        }) as never,
      readSession: async () => durable
    })

    try {
      const selected = await frameworks.forSession(durable)
      await selected.assertAvailable()
      currentConfig = JSON.stringify({ permission: { task: 'allow' }, agent: {} })
      const reservation = await selected.execution.reserve(1)
      const running = selected.execution.run(
        {
          session: { projectId: durable.projectId, sessionId: durable.id },
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          runtimeSegmentId: 'runtime-1',
          executionModel: {
            frameworkId: 'opencode',
            providerId: 'provider-a',
            backendId: 'opencode:provider-a',
            modelRoute: 'opencode-openai',
            model: 'model-a',
            reasoningEffort: 'default'
          },
          executionBackend: admittedBackend,
          forkExecutionBackendSkillRuntime,
          task: 'Investigate',
          inputs: [],
          workspaceCwd,
          continuation: false
        },
        reservation.slotIds[0]
      )

      await expect(running.completion).rejects.toThrow('attempt stopped after backend preparation')
      expect(forkExecutionBackendSkillRuntime).toHaveBeenCalledWith({ kind: 'main' })
      expect(admittedBackend.env.OPENCODE_CONFIG_CONTENT).toBe(safeOpenCodeConfig)
      expect(currentConfig).not.toBe(admittedBackend.env.OPENCODE_CONFIG_CONTENT)
      expect(release).toHaveBeenCalledOnce()
      await expect(
        lstat(join(dataRoot, 'delegation', durable.projectId, durable.id, 'runtime', 'attempt-1'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })
})
