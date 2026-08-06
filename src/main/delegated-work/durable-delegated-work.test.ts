import { describe, expect, it } from 'vitest'

import { createDeterministicDelegateExecution } from './deterministic-execution'
import {
  createDurableDelegatedWork,
  createInMemoryDelegatedWorkRecords,
  type AuthenticatedDelegateCaller
} from './durable-delegated-work'

const caller: AuthenticatedDelegateCaller = {
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: 'root-frame',
  role: 'main',
  originMessageId: 'origin-message',
  toolInvocationId: 'tool-call-1'
}

describe('durable delegated work', () => {
  it('blocks by default and projects the result from the durable terminal Message', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const pending = work.delegate(caller, { task: 'Trace the source', name: 'Source trace' })

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toEqual({
        runningCount: 1,
        children: [
          {
            frameId: expect.any(String),
            title: 'Source trace',
            status: 'running'
          }
        ]
      })
    execution.controls()[0].accept()
    execution.controls()[0].complete('The durable answer')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          response: 'The durable answer',
          terminalMessageId: expect.any(String),
          artifactsCreated: []
        }
      ]
    })
    const durable = await records.snapshot()
    expect(durable.records[0].attempts[0]).not.toHaveProperty('response')
    expect(durable.messages.find((message) => message.role === 'assistant')?.content).toBe(
      'The durable answer'
    )
  })

  it('returns durable cancelled and error results from the default blocking call', async () => {
    const cancelledExecution = createDeterministicDelegateExecution()
    const cancelledRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const cancelledWork = createDurableDelegatedWork({
      execution: cancelledExecution,
      records: cancelledRecords
    })
    const cancelledPending = cancelledWork.delegate(caller, { task: 'Cancelable work' })
    await expect.poll(() => cancelledExecution.controls()).toHaveLength(1)
    cancelledExecution.controls()[0].accept()
    cancelledExecution.controls()[0].cancel()

    await expect(cancelledPending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'cancelled',
          cancellationReason: 'main_agent_stop',
          artifactsCreated: []
        }
      ]
    })

    const failedExecution = createDeterministicDelegateExecution()
    failedExecution.plan({ status: 'failed', error: new Error('provider startup failed') })
    const failedRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const failedWork = createDurableDelegatedWork({
      execution: failedExecution,
      records: failedRecords
    })

    await expect(
      failedWork.delegate(
        { ...caller, toolInvocationId: 'failed-tool-call' },
        { task: 'Fragile work' }
      )
    ).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'provider startup failed' },
          artifactsCreated: []
        }
      ]
    })
  })

  it('validates authenticated admission before reserving or creating durable state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: async (identity) => identity.startsWith('upload-version:')
    })

    await expect(
      work.delegate(
        { ...caller, originMessageId: 'forged-origin', toolInvocationId: 'forged-call' },
        { task: 'private' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'bad-input-call' },
        { task: 'inspect', inputs: ['workspace/current.csv'] },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'profile-call' },
        { task: 'inspect', profile: '' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    for (const [toolInvocationId, request] of [
      ['blank-task-call', { task: '   ' }],
      ['blank-name-call', { task: 'inspect', name: '   ' }],
      ['blank-context-call', { task: 'inspect', context: '   ' }]
    ] as const) {
      await expect(
        work.delegate({ ...caller, toolInvocationId }, request, { wait: false })
      ).rejects.toMatchObject({ code: 'admission_rejection' })
    }

    expect(execution.controls()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
  })

  it('rejects unavailable delegated-work capability or framework before reserving durable work', async () => {
    for (const availabilityError of [
      new Error('delegated-work capability is unavailable'),
      new Error('framework cannot isolate delegated execution')
    ]) {
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        assertAvailable: async () => {
          throw availabilityError
        }
      })

      await expect(
        work.delegate(caller, { task: 'Must not be admitted' }, { wait: false })
      ).rejects.toMatchObject({ code: 'unsupported_framework', message: availabilityError.message })
      expect(execution.reservationCounts()).toEqual([])
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('deduplicates the same authenticated delivery and exposes read-only child conversation detail', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const first = await work.delegate(caller, { task: 'One child' }, { wait: false })
    const duplicate = await work.delegate(caller, { task: 'Ignored duplicate' }, { wait: false })

    expect(duplicate).toEqual(first)
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect((await records.snapshot()).records).toHaveLength(1)
    const frameId = first.children[0].frameId
    const detail = await work.readAgentFrame(caller.session, frameId)
    expect(detail).toEqual({
      frameId,
      title: 'One child',
      status: 'running',
      messages: [{ role: 'user', content: 'One child' }]
    })
    expect(Object.isFrozen(detail)).toBe(true)
    expect(Object.isFrozen(detail?.messages)).toBe(true)
  })

  it('returns an admitted receipt before workspace startup and durably projects startup failure', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let rejectWorkspace!: (error: Error) => void
    const workspaceReady = new Promise<{ cwd: string }>((_resolve, reject) => {
      rejectWorkspace = reject
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: { prepare: async () => workspaceReady }
    })

    const receipt = await work.delegate(caller, { task: 'Prepare inputs' }, { wait: false })
    expect(receipt).toMatchObject({
      kind: 'receipts',
      children: [{ status: 'running' }]
    })
    rejectWorkspace(new Error('immutable input staging failed'))

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 0,
        children: [
          {
            frameId: receipt.children[0].frameId,
            status: 'error'
          }
        ]
      })
    expect(execution.controls()).toEqual([])
  })
})
