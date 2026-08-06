import { describe, expect, it, vi } from 'vitest'

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

type SpecialistFixture = {
  id: string
  name: string
  displayName: string
  enabled: boolean
  setupPending: boolean
  revision: number
}

const specialist = (overrides: Partial<SpecialistFixture> = {}): SpecialistFixture => ({
  id: 'specialist-stable-id',
  name: 'EVIDENCE_ANALYST',
  displayName: 'Evidence Analyst',
  enabled: true,
  setupPending: false,
  revision: 7,
  ...overrides
})

describe('durable delegated work', () => {
  it('defaults an omitted profile to Main Agent without consulting a Specialist resolver', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async () => specialist())
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(caller, { task: 'Use the default agent' }, { wait: false })

    expect(resolveSpecialist).not.toHaveBeenCalled()
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual({
      kind: 'main'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).not.toHaveProperty('profile')
    await expect(
      work.readAgentFrame(caller.session, outcome.children[0].frameId)
    ).resolves.toMatchObject({ resolvedAgent: { kind: 'main' } })
  })

  it('resolves an explicit stable Specialist identity and preserves its dispatch snapshot', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const profile = specialist()
    const resolveSpecialist = vi.fn(async () => profile)
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(
      caller,
      { task: 'Audit the evidence', profile: 'specialist-stable-id' },
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledWith('specialist-stable-id')
    profile.displayName = 'Renamed after dispatch'
    profile.revision = 8
    const expectedSnapshot = {
      kind: 'specialist',
      profileId: 'specialist-stable-id',
      revision: 7,
      displayName: 'Evidence Analyst'
    }
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual(
      expectedSnapshot
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input.profile).toBe('specialist-stable-id')
    await expect(
      work.readAgentFrame(caller.session, outcome.children[0].frameId)
    ).resolves.toMatchObject({ resolvedAgent: expectedSnapshot })
    execution.controls()[0].accept()
    execution.controls()[0].complete('Specialist result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, outcome.children[0].frameId))
      .toMatchObject({ status: 'completed', resolvedAgent: expectedSnapshot })
  })

  it('rejects unknown, disabled, and setup-incomplete Specialists before reservation or mutation', async () => {
    for (const [profileId, resolved] of [
      ['unknown-id', undefined],
      ['disabled-id', specialist({ id: 'disabled-id', enabled: false })],
      ['setup-incomplete-id', specialist({ id: 'setup-incomplete-id', setupPending: true })]
    ] as const) {
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        resolveSpecialist: async () => resolved
      })

      await expect(
        work.delegate(
          { ...caller, toolInvocationId: `tool-call-${profileId}` },
          { task: 'Must not run', profile: profileId },
          { wait: false }
        )
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      expect(execution.reservationCounts()).toEqual([])
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('keeps Specialist history stable when the live profile is renamed, disabled, or deleted', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile: ReturnType<typeof specialist> | undefined = specialist()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => liveProfile
    })
    const first = await work.delegate(
      caller,
      { task: 'Preserve this history', profile: 'specialist-stable-id' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Historical result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, first.children[0].frameId))
      .toMatchObject({ status: 'completed' })

    liveProfile = specialist({ displayName: 'Renamed Specialist', revision: 8 })
    const afterRename = await work.delegate(
      { ...caller, toolInvocationId: 'renamed-redispatch' },
      { task: 'Resolve the renamed profile', profile: 'specialist-stable-id' },
      { wait: false }
    )
    expect((await records.snapshot()).records[1].attempts[0].resolvedAgent).toEqual({
      kind: 'specialist',
      profileId: 'specialist-stable-id',
      revision: 8,
      displayName: 'Renamed Specialist'
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.controls()[1].accept()
    execution.controls()[1].complete('Renamed result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, afterRename.children[0].frameId))
      .toMatchObject({ status: 'completed' })

    liveProfile = specialist({ displayName: 'Renamed Specialist', revision: 8, enabled: false })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'disabled-redispatch' },
        { task: 'Rejected after disable', profile: 'specialist-stable-id' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    liveProfile = undefined
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'deleted-redispatch' },
        { task: 'Rejected after delete', profile: 'specialist-stable-id' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })

    await expect(
      work.readAgentFrame(caller.session, first.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'completed',
      resolvedAgent: {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      }
    })
    expect((await records.snapshot()).records).toHaveLength(2)
    expect(execution.reservationCounts()).toEqual([1, 1])
  })

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
    expect(execution.reservationCounts()).toEqual([])
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
      resolvedAgent: { kind: 'main' },
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
