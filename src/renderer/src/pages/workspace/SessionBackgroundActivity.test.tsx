// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
    expect(open).toHaveBeenCalledWith(notebook)
    act(() => buttons.find((button) => button.textContent === 'Cancel')?.click())
    expect(cancelBackgroundRun).toHaveBeenCalledWith({ ...notebook, runId: 'run-1' })
    expect(container.textContent).toContain('Cancelling')
  })
})
