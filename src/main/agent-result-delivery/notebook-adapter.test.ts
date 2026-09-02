import { describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookRunResultDeliveryAdapter, notebookRunDeliveryContext } from './notebook-adapter'

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

describe('NotebookRunResultDeliveryAdapter', () => {
  it('delivers a waiting background Run after startup recovery terminalizes it', async () => {
    const repository = {
      listWaitingLocalRuns: vi.fn(async () => [
        {
          sourceKind: 'local-run' as const,
          runId: 'run-1',
          executionType: 'python' as const,
          terminalStatus: 'waiting-result' as const,
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'frame-1',
          title: 'print(42)',
          lane: 'Python',
          acceptedAt: 1
        }
      ])
    }
    const enqueue = vi.fn(async () => undefined)
    const adapter = new NotebookRunResultDeliveryAdapter({ repository, enqueue })

    await adapter.recoverWaiting(async (request) =>
      run({
        runId: request.runId,
        status: 'interrupted',
        interruptionReason: 'app-terminated'
      })
    )

    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        terminalStatus: 'interrupted',
        projectId: 'project-1',
        sessionId: 'session-1'
      })
    )
  })
})
