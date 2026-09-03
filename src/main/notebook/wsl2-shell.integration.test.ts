import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { isWsl2BashDevelopmentEnabled } from '@aipoch/notebook-network-sandbox'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { runShellCommand } from './shell-process'

const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER
const enabled =
  process.platform === 'win32' && Boolean(distro && user) && isWsl2BashDevelopmentEnabled()

describe.runIf(enabled)('Notebook WSL2 Bash execution', () => {
  let root = ''
  let workspace = ''
  let runtimeRoot = ''
  let handoff = ''
  let sandbox: NotebookNetworkSandboxOwner
  const info = vi.fn()

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-wsl-shell-'))
    workspace = join(root, 'Workspace 路径')
    runtimeRoot = join(root, 'runtime')
    handoff = join(root, 'handoff')
    await Promise.all(
      [workspace, runtimeRoot, handoff].map((path) => mkdir(path, { recursive: true }))
    )
    sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: vi.fn(),
      requestDecision: vi.fn().mockResolvedValue('deny'),
      platform: 'win32',
      logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() }
    })
  })

  afterAll(async () => {
    await sandbox?.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('returns bounded output and the real exit code through the existing process sandbox', async () => {
    const result = await runShellCommand({
      command:
        `printf '你好 stdout\\n'; printf 'guest stderr\\n' >&2; ` +
        `head -c 2200000 /dev/zero | tr '\\0' x; exit 19`,
      cwd: workspace,
      handoffDir: handoff,
      runtimeRoot,
      notebookSessionRoot: root,
      executionReference: 'real-wsl-execution',
      sessionId: 'session-1',
      projectId: 'project-1',
      platform: 'win32',
      runtimeBinding: {
        kind: 'wsl2-bash',
        profileId: 'real-profile',
        distro: distro!,
        user: user!
      },
      processSandbox: sandbox,
      terminateTree: async () => ({ reaped: true })
    })

    expect(result.exitCode).toBe(19)
    expect(result.stdout.startsWith('你好 stdout\n')).toBe(true)
    expect(result.stderr).toBe('guest stderr\n')
    expect(result.truncated).toBe(true)
    expect(
      info.mock.calls.filter(([message]) => message === 'sandbox cleanup completed')
    ).toHaveLength(1)
    const diagnosticText = JSON.stringify(info.mock.calls)
    expect(diagnosticText).not.toContain(workspace)
    expect(diagnosticText).not.toContain(distro)
    expect(diagnosticText).not.toContain(user)
    expect(diagnosticText).not.toContain('你好 stdout')
    expect(diagnosticText).toContain('real-wsl-execution')
  })

  it.each([
    { reason: 'timeout' as const, timeoutMs: 200 },
    { reason: 'cancel' as const, timeoutMs: 5_000 }
  ])(
    'propagates $reason to exact guest cleanup within a bounded time',
    async ({ reason, timeoutMs }) => {
      const controller = new AbortController()
      if (reason === 'cancel') setTimeout(() => controller.abort(), 200)
      const startedAt = Date.now()

      const result = await runShellCommand({
        command: `trap '' TERM; while :; do sleep 1; done`,
        cwd: workspace,
        handoffDir: handoff,
        runtimeRoot,
        notebookSessionRoot: root,
        executionReference: `real-wsl-${reason}`,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        timeoutMs,
        signal: controller.signal,
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'real-profile',
          distro: distro!,
          user: user!
        },
        processSandbox: sandbox,
        terminateTree: async () => ({ reaped: true })
      })

      expect(Date.now() - startedAt).toBeLessThan(8_000)
      expect(result.exitCode).toBeNull()
      expect(result.errorCode).toBeUndefined()
      expect(result.cancelled).toBe(reason === 'cancel' ? true : undefined)
      expect(result.stderr).toContain(reason === 'cancel' ? 'cancelled' : 'timed out')
    },
    15_000
  )
})
