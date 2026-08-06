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

  it('admits an array atomically and starts every accepted child in request order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const prepared: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare(_session, frameId) {
          prepared.push(frameId)
          return new Promise(() => undefined)
        }
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })

    const outcome = await work.delegate(
      caller,
      [
        { task: 'First investigation', name: 'Explicit title' },
        { task: 'Second investigation' },
        { task: 'Second investigation' }
      ],
      { wait: false }
    )

    expect(execution.reservationCounts()).toEqual([3])
    expect(outcome).toEqual({
      kind: 'receipts',
      children: [
        { frameId: 'frame-1', attemptId: 'attempt-1', status: 'running' },
        { frameId: 'frame-2', attemptId: 'attempt-2', status: 'running' },
        { frameId: 'frame-3', attemptId: 'attempt-3', status: 'running' }
      ]
    })
    expect(prepared).toEqual(['frame-1', 'frame-2', 'frame-3'])
    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 3,
      children: [
        { frameId: 'frame-1', title: 'Explicit title', status: 'running' },
        { frameId: 'frame-2', title: 'Second investigation', status: 'running' },
        { frameId: 'frame-3', title: 'Second investigation (2)', status: 'running' }
      ]
    })
  })

  it('resolves every explicit Specialist in a batch before reserving and preserves each agent snapshot', async () => {
    const rejectedExecution = createDeterministicDelegateExecution()
    const rejectedRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const rejectedWork = createDurableDelegatedWork({
      execution: rejectedExecution,
      records: rejectedRecords,
      resolveSpecialist: async () => undefined
    })

    await expect(
      rejectedWork.delegate(
        caller,
        [{ task: 'Main child' }, { task: 'Unavailable child', profile: 'missing-profile' }],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(rejectedExecution.reservationCounts()).toEqual([])
    expect((await rejectedRecords.snapshot()).records).toEqual([])

    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async (profileId: string) => specialist({ id: profileId }))
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    await work.delegate(
      { ...caller, toolInvocationId: 'mixed-agent-batch' },
      [{ task: 'Default Main child' }, { task: 'Specialist child', profile: 'specialist-id' }],
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledTimes(1)
    expect(resolveSpecialist).toHaveBeenCalledWith('specialist-id')
    expect(execution.reservationCounts()).toEqual([2])
    expect(
      (await records.snapshot()).records.map((child) => child.attempts[0].resolvedAgent)
    ).toEqual([
      { kind: 'main' },
      {
        kind: 'specialist',
        profileId: 'specialist-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls().map((control) => control.input.profile)).toEqual([
      undefined,
      'specialist-id'
    ])
  })

  it('rejects an invalid or over-capacity array without any durable child state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: (identity) => identity.startsWith('upload-version:')
    })

    await expect(
      work.delegate(
        caller,
        [{ task: 'valid' }, { task: 'invalid', inputs: ['mutable/path.csv'] }],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate({ ...caller, toolInvocationId: 'empty-array' }, [], { wait: false })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.reservationCounts()).toEqual([])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })

    execution.rejectNextReservation('capacity', 'batch capacity unavailable')
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'capacity-array' },
        [{ task: 'one' }, { task: 'two' }],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'capacity', message: 'batch capacity unavailable' })
    expect(execution.reservationCounts()).toEqual([2])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })
  })

  it('leaves no partial durable batch when atomic admission rejects after reservation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `duplicate-${kind}`
    })

    await expect(
      work.delegate(caller, [{ task: 'one' }, { task: 'two' }], { wait: false })
    ).rejects.toThrow('Duplicate delegated-work identity')
    expect(execution.reservationCounts()).toEqual([2])
    expect(execution.controls()).toEqual([])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })
  })

  it('isolates sibling terminal outcomes and returns wait results in request order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const pending = work.delegate(caller, [
      { task: 'complete last' },
      { task: 'fail first' },
      { task: 'cancel second' }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(3)
    for (const control of execution.controls()) control.accept()
    execution.controls()[1].fail(new Error('provider startup failed'))
    execution.controls()[2].cancel()

    await expect
      .poll(() => work.children(caller))
      .toEqual([
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'complete last',
          status: 'running'
        },
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'fail first',
          status: 'error'
        },
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'cancel second',
          status: 'cancelled'
        }
      ])
    execution.controls()[0].complete('surviving evidence')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        { status: 'completed', response: 'surviving evidence' },
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'provider startup failed' }
        },
        { status: 'cancelled', cancellationReason: 'main_agent_stop' }
      ]
    })
  })

  it('terminalizes one child finalization failure without cancelling its sibling', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let failFirstCompletion = true
    const records: typeof durableRecords = {
      ...durableRecords,
      async terminalize(input) {
        if (failFirstCompletion && input.frameId === 'frame-1' && input.status === 'completed') {
          failFirstCompletion = false
          throw new Error('terminal assistant Message write failed')
        }
        await durableRecords.terminalize(input)
      }
    }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0 }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = work.delegate(caller, [{ task: 'fragile finalization' }, { task: 'sibling' }])
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.controls()[0].complete('lost response')
    execution.controls()[1].complete('preserved response')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          frameId: 'frame-1',
          status: 'error',
          error: {
            code: 'execution_failure',
            message: 'terminal assistant Message write failed'
          }
        },
        { frameId: 'frame-2', status: 'completed', response: 'preserved response' }
      ]
    })
  })

  it('keeps children in admission order and collects selected children in caller order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `${kind}-${nextId++}`
    })

    const dispatched = await work.delegate(caller, [{ task: 'alpha' }, { task: 'beta' }], {
      wait: false
    })
    const [alpha, beta] = dispatched.children
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.control(alpha.attemptId).accept()
    execution.control(beta.attemptId).accept()
    execution.control(beta.attemptId).complete('B')

    const collecting = work.collect(caller, [beta.frameId, alpha.frameId])
    await expect
      .poll(() => work.children(caller))
      .toMatchObject([
        { frameId: alpha.frameId, status: 'running' },
        { frameId: beta.frameId, status: 'completed' }
      ])
    execution.control(alpha.attemptId).complete('A')

    await expect(collecting).resolves.toMatchObject([
      { frameId: beta.frameId, response: 'B' },
      { frameId: alpha.frameId, response: 'A' }
    ])
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

  it('isolates a child workspace startup failure while its accepted sibling continues', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const workspaceSettlers: Array<{
      resolve(value: { cwd: string }): void
      reject(error: Error): void
    }> = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        prepare: async () =>
          new Promise<{ cwd: string }>((resolve, reject) => {
            workspaceSettlers.push({ resolve, reject })
          })
      }
    })

    const receipt = await work.delegate(
      caller,
      [{ task: 'Prepare inputs' }, { task: 'Fragile staging' }],
      { wait: false }
    )
    expect(receipt).toMatchObject({
      kind: 'receipts',
      children: [{ status: 'running' }, { status: 'running' }]
    })
    expect(workspaceSettlers).toHaveLength(2)
    workspaceSettlers[1].reject(new Error('immutable input staging failed'))
    workspaceSettlers[0].resolve({ cwd: '/workspace/first' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 1,
        children: [
          {
            frameId: receipt.children[0].frameId,
            status: 'running'
          },
          {
            frameId: receipt.children[1].frameId,
            status: 'error'
          }
        ]
      })
    execution.controls()[0].complete('sibling completed')
    await expect(work.collect(caller, [receipt.children[0].frameId])).resolves.toMatchObject([
      { status: 'completed', response: 'sibling completed' }
    ])
  })
})
