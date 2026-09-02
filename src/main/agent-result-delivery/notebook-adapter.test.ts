import { describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { notebookRunDeliveryContext } from './notebook-adapter'

const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-1',
  executionMode: 'background',
  cellId: 'cell-1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(42)',
  status: 'completed',
  startedAt: 1,
  endedAt: 2,
  text: { stdout: '42\n', stderr: '', traceback: '', plain: ['42'] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'segment-1',
  promptMessageId: 'prompt-1',
  ...overrides
})

describe('notebookRunDeliveryContext', () => {
  it.each([
    ['python', 'completed', 'python'],
    ['r', 'failed', 'r'],
    ['repl', 'timeout', 'repl'],
    ['bash', 'interrupted', 'shell'],
    ['bash', 'cancelled', 'shell']
  ] as const)('maps %s %s terminal outcomes to %s delivery facts', (kernelKind, status, type) => {
    expect(
      notebookRunDeliveryContext(
        { projectId: 'project-1', sessionId: 'session-1' },
        run({ kernelKind, status })
      )
    ).toMatchObject({
      runId: 'run-1',
      executionType: type,
      terminalStatus: status,
      projectId: 'project-1',
      sessionId: 'session-1',
      provenance: {
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1'
      }
    })
  })

  it('rejects foreground and nonterminal Runs at the adapter boundary', () => {
    expect(
      notebookRunDeliveryContext(
        { projectId: 'project-1', sessionId: 'session-1' },
        run({ executionMode: 'foreground' })
      )
    ).toBeUndefined()
    expect(
      notebookRunDeliveryContext(
        { projectId: 'project-1', sessionId: 'session-1' },
        run({ status: 'running' })
      )
    ).toBeUndefined()
  })
})
