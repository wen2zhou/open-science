import type { ActiveSession, ClientConnection, McpServer } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import { ReviewerSessionOwner } from './reviewer-session-owner'

const reviewerServer: McpServer = {
  type: 'http',
  name: 'open-science-reviewer',
  url: 'http://127.0.0.1:1234/mcp',
  headers: []
}

const createHarness = (
  framework: typeof claudeCodeFramework,
  sessionOptions?: Record<string, unknown>
): {
  buildSession: ReturnType<typeof vi.fn>
  create: () => ReturnType<ReviewerSessionOwner['create']>
  dispose: () => void
  session: ActiveSession
} => {
  const session = {
    sessionId: `reviewer-${framework.id}`,
    dispose: vi.fn(),
    ...(framework.id === 'codex'
      ? {
          modes: {
            currentModeId: 'read-only',
            availableModes: [{ id: 'read-only', name: 'Read only' }]
          }
        }
      : {})
  } as unknown as ActiveSession
  const buildSession = vi.fn(() => ({ start: vi.fn(async () => session) }))
  const connection = {
    agent: { buildSession, request: vi.fn() }
  } as unknown as ClientConnection
  const owner = new ReviewerSessionOwner({
    addStartupBlocker: vi.fn(),
    assertCurrentConnection: vi.fn(),
    clearPermissionCorrelations: vi.fn(),
    currentSessionSetup: () => ({ framework, sessionOptions }),
    currentStartupGeneration: () => 1,
    isPrimarySessionIdClaimed: () => false,
    onActiveSessionReleased: vi.fn(),
    registerBridgeSession: vi.fn(),
    removeStartupBlocker: vi.fn(),
    unregisterBridgeSession: () => true
  })

  return {
    buildSession,
    create: () =>
      owner.create(
        { cwd: '/workspace', mcpServers: [reviewerServer] },
        { ensureConnected: async () => connection }
      ),
    dispose: () => void owner.dispose(session),
    session
  }
}

describe('ReviewerSessionOwner Skill discovery isolation', () => {
  it('clears inherited Claude Skills, plugins, and filesystem roots', async () => {
    const harness = createHarness(claudeCodeFramework, {
      skills: ['literature-review'],
      plugins: [{ type: 'local', path: '/runtime/skills/generations/generation-1' }],
      additionalDirectories: ['/runtime/skills/generations/generation-1'],
      settingSources: ['user']
    })

    await harness.create()

    expect(harness.buildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalDirectories: [],
        _meta: expect.objectContaining({
          claudeCode: expect.objectContaining({
            options: expect.objectContaining({
              tools: [],
              skills: [],
              plugins: [],
              additionalDirectories: []
            })
          })
        })
      })
    )
    expect(JSON.stringify(harness.buildSession.mock.calls[0]?.[0])).not.toContain(
      '/runtime/skills/generations/generation-1'
    )
    harness.dispose()
  })

  it.each([
    ['opencode', opencodeFramework],
    ['codex', codexFramework]
  ] as const)(
    'does not authorize additional Skill roots for %s reviewers',
    async (_id, framework) => {
      const harness = createHarness(framework)

      await harness.create()

      expect(harness.buildSession).toHaveBeenCalledWith(
        expect.objectContaining({ additionalDirectories: [] })
      )
      harness.dispose()
    }
  )
})
