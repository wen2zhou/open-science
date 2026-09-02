// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentResultDelivery } from '../../../../shared/agent-result-delivery'
import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import { SessionBackgroundActivity } from './SessionBackgroundActivity'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notebook: NotebookSessionReference = {
  projectId: 'project-1',
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/notebook',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  runJsonPath: '/notebook/run.json'
}

const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  agentFrameId: 'frame-1',
  executionMode: 'background',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'donor_level_qc()',
  status: 'running',
  startedAt: Date.now() - 5_000,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: [],
  environment: 'Python 3.12',
  ...overrides
})

const delivery = (overrides: Partial<AgentResultDelivery> = {}): AgentResultDelivery => ({
  id: 'delivery-1',
  state: 'pending',
  attemptCount: 0,
  createdAt: Date.now() - 1_000,
  updatedAt: Date.now() - 1_000,
  context: {
    runId: 'run-1',
    executionType: 'python',
    terminalStatus: 'completed',
    resultSummary: 'QC completed',
    projectId: 'project-1',
    sessionId: 'session-1',
    agentFrameId: 'frame-1'
  },
  ...overrides
})

const emptyDeliveryApi = (): {
  getSessionActivity: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
} => ({
  getSessionActivity: vi.fn().mockResolvedValue({ active: [], awaitingAgent: [] }),
  dismiss: vi.fn().mockResolvedValue(true)
})

describe('Session background activity ledger', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows only background Runs and exposes Open plus active-only Cancel', async () => {
    const cancelBackgroundRun = vi.fn().mockResolvedValue(undefined)
    const onChanged = vi.fn(() => () => undefined)
    vi.stubGlobal('window', {
      ...window,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      api: {
        agentResultDelivery: emptyDeliveryApi(),
        notebook: {
          state: vi.fn().mockResolvedValue({
            runs: [run(), run({ runId: 'foreground', executionMode: 'foreground' })]
          }),
          onChanged,
          cancelBackgroundRun
        }
      }
    })
    const open = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SessionBackgroundActivity notebook={notebook} onOpenNotebook={open} />)
    })
    await vi.waitFor(() => expect(container.textContent).toContain('donor_level_qc()'))
    expect(container.textContent).not.toContain('foreground')

    const buttons = [...container.querySelectorAll('button')]
    act(() => buttons.find((button) => button.textContent === 'Open')?.click())
    expect(open).toHaveBeenCalledWith(notebook, 'run-1')
    act(() => buttons.find((button) => button.textContent === 'Cancel')?.click())
    expect(cancelBackgroundRun).toHaveBeenCalledWith({
      ...notebook,
      runId: 'run-1',
      agentFrameId: 'frame-1'
    })
    expect(container.textContent).toContain('Cancelling')
  })

  it('shows a JavaScript REPL Run with its persistent lane and active controls', async () => {
    const cancelBackgroundRun = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      ...window,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      api: {
        agentResultDelivery: emptyDeliveryApi(),
        notebook: {
          state: vi.fn().mockResolvedValue({
            runs: [
              run({
                runId: 'repl-run-1',
                kernelKind: 'repl',
                script: 'await host.llm("summarize")',
                environment: undefined
              })
            ]
          }),
          onChanged: vi.fn(() => () => undefined),
          cancelBackgroundRun
        }
      }
    })
    const open = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SessionBackgroundActivity notebook={notebook} onOpenNotebook={open} />)
    })
    await vi.waitFor(() => expect(container.textContent).toContain('JavaScript REPL'))
    expect(container.textContent).toContain('Persistent REPL')
    expect(container.textContent).toContain('Running')
    expect(container.textContent).toMatch(/0m \d{2}s/u)
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Open',
      'Cancel'
    ])
  })

  it('shows Shell Commands with bounded slot state in the dense Session ledger', async () => {
    vi.stubGlobal('window', {
      ...window,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      api: {
        agentResultDelivery: emptyDeliveryApi(),
        notebook: {
          state: vi.fn().mockResolvedValue({
            runs: [
              run({
                runId: 'shell-running',
                kernelKind: 'bash',
                script: 'long-command',
                shellConcurrency: { limit: 2, slot: 1 }
              }),
              run({
                runId: 'shell-queued',
                kernelKind: 'bash',
                script: 'next-command',
                status: 'queued',
                shellConcurrency: { limit: 2 }
              })
            ]
          }),
          onChanged: vi.fn(() => () => undefined),
          cancelBackgroundRun: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SessionBackgroundActivity notebook={notebook} onOpenNotebook={vi.fn()} />)
    })
    await vi.waitFor(() => expect(container.textContent).toContain('long-command'))

    expect(container.textContent).toContain('Shell Command')
    expect(container.textContent).toContain('Shell slot 1 of 2')
    expect(container.textContent).toContain('Waiting for shell slot')
    expect(container.textContent).not.toContain('Compute Job')
  })

  it('groups terminal results awaiting Agent delivery and dismisses only the ledger row', async () => {
    const dismiss = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', {
      ...window,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      api: {
        agentResultDelivery: {
          getSessionActivity: vi.fn().mockResolvedValue({
            active: [],
            awaitingAgent: [delivery({ state: 'needs-attention' })]
          }),
          dismiss
        },
        notebook: {
          state: vi.fn().mockResolvedValue({
            runs: [run({ status: 'completed', endedAt: Date.now() })]
          }),
          onChanged: vi.fn(() => () => undefined),
          cancelBackgroundRun: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SessionBackgroundActivity notebook={notebook} onOpenNotebook={vi.fn()} />)
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Awaiting Agent'))

    expect(container.textContent).toContain('Needs Agent')
    expect(container.textContent).not.toContain('Retry')
    const dismissButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Dismiss'
    )
    await act(async () => dismissButton?.click())

    expect(dismiss).toHaveBeenCalledWith({ sessionId: 'session-1', deliveryId: 'delivery-1' })
    expect(container.textContent).not.toContain('donor_level_qc()')
  })

  it('omits terminal Runs once no delivery remains awaiting the Agent', async () => {
    vi.stubGlobal('window', {
      ...window,
      setInterval: window.setInterval.bind(window),
      clearInterval: window.clearInterval.bind(window),
      api: {
        agentResultDelivery: emptyDeliveryApi(),
        notebook: {
          state: vi.fn().mockResolvedValue({
            runs: [run({ status: 'completed', endedAt: Date.now() })]
          }),
          onChanged: vi.fn(() => () => undefined),
          cancelBackgroundRun: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<SessionBackgroundActivity notebook={notebook} onOpenNotebook={vi.fn()} />)
    })

    await vi.waitFor(() => expect(container.textContent).toBe(''))
  })
})
