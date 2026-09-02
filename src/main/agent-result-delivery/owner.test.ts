import { describe, expect, it, vi } from 'vitest'

import type { AgentResultDelivery } from '../../shared/agent-result-delivery'
import { AgentResultDeliveryOwner } from './owner'

const delivery = (runId: string): AgentResultDelivery => ({
  id: `local-run:${runId}`,
  state: 'claimed',
  context: {
    runId,
    executionType: 'python',
    terminalStatus: 'completed',
    resultSummary: `${runId} result`,
    projectId: 'project-1',
    sessionId: 'session-1',
    agentFrameId: 'frame-1'
  },
  attemptCount: 1,
  claimToken: 'claim-1',
  claimExpiresAt: 2_000,
  createdAt: 1,
  updatedAt: 1
})

const harness = (
  overrides: Record<string, unknown> = {}
): {
  owner: AgentResultDeliveryOwner
  repository: Record<string, ReturnType<typeof vi.fn>>
  sendContinuation: ReturnType<typeof vi.fn>
  isContinuationSaved: ReturnType<typeof vi.fn>
} => {
  const { repository: repositoryOverrides, ...ownerOverrides } = overrides
  const repository = {
    recordTerminalOutcome: vi.fn(async () => delivery('run-1')),
    recoverExpiredClaims: vi.fn(async () => 0),
    listPendingSessionIds: vi.fn(async () => []),
    claimPending: vi.fn(async () => [delivery('run-1'), delivery('run-2')]),
    markConsumed: vi.fn(async () => 2),
    releaseClaim: vi.fn(async () => 2),
    ...((repositoryOverrides as object | undefined) ?? {})
  }
  const sendContinuation = vi.fn(async () => ({
    stopReason: 'end_turn',
    continuationMessageId: 'continuation-1'
  }))
  const isContinuationSaved = vi.fn(async () => true)
  const owner = new AgentResultDeliveryOwner({
    repository,
    sendContinuation,
    isContinuationSaved,
    canStartSessionTurn: async () => true,
    createId: () => 'claim-1',
    now: () => 1_000,
    ...ownerOverrides
  })
  return { owner, repository, sendContinuation, isContinuationSaved }
}

describe('AgentResultDeliveryOwner', () => {
  it('batches pending outcomes from one Session into one app continuation', async () => {
    const { owner, repository, sendContinuation } = harness()

    await expect(owner.drainSession('session-1')).resolves.toBe('consumed')

    expect(sendContinuation).toHaveBeenCalledOnce()
    expect(sendContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/run-1[\s\S]*run-2/u) })
    )
    expect(repository.markConsumed).toHaveBeenCalledWith(
      ['local-run:run-1', 'local-run:run-2'],
      'claim-1',
      'continuation-1',
      1_000
    )
  })

  it('does not consume when the Agent Turn merely starts or ends without a saved result', async () => {
    const { owner, repository } = harness({ isContinuationSaved: async () => false })

    await expect(owner.drainSession('session-1')).resolves.toBe('needs-attention')

    expect(repository.markConsumed).not.toHaveBeenCalled()
    expect(repository.releaseClaim).toHaveBeenCalledWith(
      ['local-run:run-1', 'local-run:run-2'],
      'claim-1',
      'needs-attention'
    )
  })

  it('releases any residual claim when consumption loses a concurrent compare-and-set', async () => {
    const { owner, repository } = harness({
      repository: { markConsumed: vi.fn(async () => 1) }
    })

    await expect(owner.drainSession('session-1')).resolves.toBe('needs-attention')

    expect(repository.releaseClaim).toHaveBeenCalledWith(
      ['local-run:run-1', 'local-run:run-2'],
      'claim-1',
      'needs-attention'
    )
  })

  it('leaves outcomes pending while another Session Turn owns the branch', async () => {
    const { owner, repository, sendContinuation } = harness({
      canStartSessionTurn: async () => false
    })

    await expect(owner.drainSession('session-1')).resolves.toBe('queued')

    expect(repository.claimPending).not.toHaveBeenCalled()
    expect(sendContinuation).not.toHaveBeenCalled()
  })
})
