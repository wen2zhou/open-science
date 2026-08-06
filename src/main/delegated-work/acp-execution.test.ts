import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionResponse, AcpRuntimeEvent } from '../../shared/acp'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionCallbacks,
  type AcpDelegateRuntime,
  type PreparedDelegateExecution
} from './acp-execution'
import { delegateExecutionContract } from './execution-contract.test'
import type { DelegateExecutionInput } from './execution-port'

type Deferred<Value> = Readonly<{
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}>

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

type RuntimeControl = Readonly<{
  callbacks: AcpDelegateExecutionCallbacks
  providerSessionId: string
  prompts: string[]
  responses: AcpPermissionResponse[]
  complete(response?: PromptResponse): void
  fail(error: Error): void
}>

const makeInput = (attemptId: string): DelegateExecutionInput => ({
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: `frame-${attemptId}`,
  attemptId,
  runtimeSegmentId: `segment-${attemptId}`,
  task: `task-${attemptId}`,
  inputs: [],
  continuation: false
})

const makeHarness = (
  capacity = 4,
  scopePaths: Readonly<{
    runtimeHome?(input: DelegateExecutionInput): string
    workspace?(input: DelegateExecutionInput): string
    createSessionError?(executionId: string): Error | undefined
  }> = {}
): Readonly<{
  execution: ReturnType<typeof createAcpDelegateExecution>
  controls: Map<string, RuntimeControl>
  prepared: PreparedDelegateExecution[]
  cleanup: string[]
}> => {
  const controls = new Map<string, RuntimeControl>()
  const prepared: PreparedDelegateExecution[] = []
  const cleanup: string[] = []
  const execution = createAcpDelegateExecution({
    capacity,
    prepare: async (input) => {
      const scope: PreparedDelegateExecution = {
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: `segment-${input.attemptId}`
        },
        workspace: { cwd: scopePaths.workspace?.(input) ?? `/workspace/${input.frameId}` },
        runtimeHome: scopePaths.runtimeHome?.(input) ?? `/runtime/${input.attemptId}`,
        frameworkId: 'certified-test',
        capability: {
          revoke: async () => {
            cleanup.push(`revoke:${input.attemptId}`)
          }
        },
        disposeResources: async () => {
          cleanup.push(`resources:${input.attemptId}`)
        }
      }
      prepared.push(scope)
      return scope
    },
    assertFrameworkNativeDelegationDisabled: async () => undefined,
    createRuntime: (scope, callbacks): AcpDelegateRuntime => {
      const prompt = deferred<PromptResponse>()
      const prompts: string[] = []
      const responses: AcpPermissionResponse[] = []
      const providerSessionId = `provider-${scope.executionId}`
      const control: RuntimeControl = {
        callbacks,
        providerSessionId,
        prompts,
        responses,
        complete: (response = { stopReason: 'end_turn' }) => prompt.resolve(response),
        fail: (error) => prompt.reject(error)
      }
      controls.set(scope.executionId, control)
      return {
        createSession: async () => {
          const error = scopePaths.createSessionError?.(scope.executionId)
          if (error) throw error
          return { sessionId: providerSessionId }
        },
        sendAppContinuation: ({ text }) => {
          prompts.push(text)
          callbacks.onProviderPromptAccepted(providerSessionId)
          return prompt.promise
        },
        cancelPrompt: async () => {
          prompt.resolve({ stopReason: 'cancelled' })
        },
        respondToPermission: async (response) => {
          responses.push(response)
        },
        deleteSession: async () => {
          cleanup.push(`delete:${scope.executionId}`)
        },
        shutdownForQuit: async () => {
          cleanup.push(`shutdown:${scope.executionId}`)
          return { reaped: true }
        }
      }
    }
  })
  return { execution, controls, prepared, cleanup }
}

delegateExecutionContract(() => {
  const harness = makeHarness()
  const controlFor = async (attemptId: string): Promise<RuntimeControl> => {
    await vi.waitFor(() => expect(harness.controls.has(attemptId)).toBe(true))
    return harness.controls.get(attemptId)!
  }
  return {
    execution: harness.execution,
    driver: {
      accept: async (attemptId) => {
        const control = await controlFor(attemptId)
        control.callbacks.onProviderPromptAccepted(control.providerSessionId)
      },
      emit: async (attemptId, event) => {
        const control = await controlFor(attemptId)
        if (event.kind === 'message') {
          control.callbacks.onEvent({
            id: `event-${attemptId}`,
            timestamp: 1,
            kind: 'message',
            level: 'info',
            sessionId: control.providerSessionId,
            role: 'assistant',
            text: event.text
          })
        } else if (event.awaiting) {
          control.callbacks.onPermissionRequest({
            requestId: event.requestId,
            sessionId: control.providerSessionId,
            toolCallId: `tool-${attemptId}`,
            title: event.title,
            options: [...event.options]
          })
        }
      },
      complete: async (attemptId, response) => {
        const control = await controlFor(attemptId)
        control.callbacks.onEvent({
          id: `terminal-${attemptId}`,
          timestamp: 2,
          kind: 'message',
          level: 'info',
          sessionId: control.providerSessionId,
          role: 'assistant',
          text: response
        })
        control.complete()
      },
      fail: async (attemptId, error) => (await controlFor(attemptId)).fail(error),
      deliveredMessages: (attemptId) =>
        (harness.controls.get(attemptId)?.prompts ?? []).filter(
          (prompt) => prompt !== `task-${attemptId}`
        ),
      permissionResponses: (attemptId) => harness.controls.get(attemptId)?.responses ?? []
    }
  }
})

describe('ACP delegate execution production adapter', () => {
  it('settles cancellation requested while preparation is still in flight', async () => {
    const prepare = deferred<PreparedDelegateExecution>()
    const createRuntime = vi.fn()
    const execution = createAcpDelegateExecution({
      capacity: 1,
      prepare: () => prepare.promise,
      assertFrameworkNativeDelegationDisabled: async () => undefined,
      createRuntime
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('preparing'), reservation.slotIds[0])
    const cancelled = running.cancel()

    prepare.resolve({
      executionId: 'preparing',
      provenance: {
        projectId: 'project-1',
        sessionId: 'session-1',
        agentFrameId: 'frame-preparing',
        runtimeSegmentId: 'segment-preparing'
      },
      workspace: { cwd: '/workspace/frame-preparing' },
      runtimeHome: '/runtime/preparing',
      frameworkId: 'certified-test',
      capability: { revoke: async () => undefined }
    })

    await cancelled
    await expect(running.accepted).resolves.toBeUndefined()
    await expect(running.completion).resolves.toEqual({ status: 'cancelled' })
    expect(createRuntime).not.toHaveBeenCalled()
    await expect(execution.reserve(1)).resolves.toHaveProperty('slotIds')
  })

  it('reserves an entire batch atomically and releases terminal slots', async () => {
    const { execution, controls } = makeHarness(2)
    const reservation = await execution.reserve(2)
    expect(reservation.slotIds).toHaveLength(2)
    await expect(execution.reserve(1)).rejects.toMatchObject({
      code: 'capacity'
    })

    const first = execution.run(makeInput('one'), reservation.slotIds[0])
    const second = execution.run(makeInput('two'), reservation.slotIds[1])
    await Promise.all([first.accepted, second.accepted])
    controls.get('one')?.complete()
    controls.get('two')?.complete()
    await Promise.all([first.completion, second.completion])

    await expect(execution.reserve(2)).resolves.toHaveProperty('slotIds')
  })

  it('does not let failed duplicate scope cleanup release a running sibling scope', async () => {
    const { execution, controls } = makeHarness(3, {
      runtimeHome: () => '/runtime/shared'
    })
    const reservation = await execution.reserve(2)
    const first = execution.run(makeInput('scope-owner'), reservation.slotIds[0])
    const duplicate = execution.run(makeInput('scope-duplicate'), reservation.slotIds[1])
    await first.accepted
    await expect(duplicate.completion).rejects.toThrow('runtime home is already active')

    const nextReservation = await execution.reserve(1)
    const stillDuplicate = execution.run(makeInput('scope-third'), nextReservation.slotIds[0])
    await expect(stillDuplicate.completion).rejects.toThrow('runtime home is already active')

    controls.get('scope-owner')!.complete()
    await expect(first.completion).resolves.toMatchObject({ status: 'completed' })
    const afterRelease = await execution.reserve(1)
    expect(afterRelease.slotIds).toHaveLength(1)
  })

  it('routes graph provenance, workspace, runtime home, events, permission, and cancel by Attempt', async () => {
    const { execution, controls, prepared } = makeHarness(2)
    const reservation = await execution.reserve(2)
    const first = execution.run(makeInput('one'), reservation.slotIds[0])
    const second = execution.run(makeInput('two'), reservation.slotIds[1])
    const firstEvents: string[] = []
    const secondEvents: string[] = []
    first.subscribe((event) => firstEvents.push(JSON.stringify(event)))
    second.subscribe((event) => secondEvents.push(JSON.stringify(event)))
    await Promise.all([first.accepted, second.accepted])

    controls.get('one')?.callbacks.onEvent({
      id: 'first-message',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      sessionId: 'provider-one',
      role: 'assistant',
      text: 'first only'
    })
    controls.get('two')?.callbacks.onPermissionRequest({
      requestId: 'permission-two',
      sessionId: 'provider-two',
      toolCallId: 'tool-two',
      title: 'second only',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    await second.respondToPermission({ requestId: 'permission-two', optionId: 'allow' })
    await first.cancel()

    expect(prepared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: 'one',
          runtimeHome: '/runtime/one',
          workspace: { cwd: '/workspace/frame-one' },
          provenance: expect.objectContaining({
            sessionId: 'session-1',
            agentFrameId: 'frame-one',
            runtimeSegmentId: 'segment-one'
          })
        }),
        expect.objectContaining({ executionId: 'two', runtimeHome: '/runtime/two' })
      ])
    )
    expect(firstEvents.join('\n')).toContain('first only')
    expect(firstEvents.join('\n')).not.toContain('second only')
    expect(secondEvents.join('\n')).toContain('permission-two')
    expect(controls.get('two')?.responses).toEqual([
      { requestId: 'permission-two', optionId: 'allow' }
    ])
    expect(controls.get('two')?.prompts).toEqual(['task-two'])
    controls.get('two')?.complete()
    await second.completion
  })

  it('revokes writes before cleanup and drops late provider events', async () => {
    const { execution, controls, cleanup } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('cleanup'), reservation.slotIds[0])
    const events: string[] = []
    running.subscribe((event) => events.push(JSON.stringify(event)))
    await running.accepted
    controls.get('cleanup')?.complete()
    await running.completion

    controls.get('cleanup')?.callbacks.onEvent({
      id: 'late',
      timestamp: 2,
      kind: 'message',
      level: 'info',
      sessionId: 'provider-cleanup',
      role: 'assistant',
      text: 'too late'
    })

    expect(events.join('\n')).not.toContain('too late')
    expect(cleanup).toEqual([
      'revoke:cleanup',
      'delete:cleanup',
      'shutdown:cleanup',
      'resources:cleanup'
    ])
  })

  it('fails closed before runtime creation when framework certification fails', async () => {
    const createRuntime = vi.fn()
    const execution = createAcpDelegateExecution({
      capacity: 1,
      prepare: async (input) => ({
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: 'segment-unsafe'
        },
        workspace: { cwd: '/workspace/unsafe' },
        runtimeHome: '/runtime/unsafe',
        frameworkId: 'unsafe',
        capability: { revoke: async () => undefined }
      }),
      assertFrameworkNativeDelegationDisabled: async () => {
        throw new Error('native delegation remains enabled')
      },
      createRuntime
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('unsafe'), reservation.slotIds[0])

    await expect(running.completion).rejects.toMatchObject({
      code: 'unsupported_framework'
    })
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('contains provider startup failure to its child and keeps the sibling runtime alive', async () => {
    const { execution, controls } = makeHarness(2, {
      createSessionError: (executionId) =>
        executionId === 'bad-startup' ? new Error('provider startup failed') : undefined
    })
    const reservation = await execution.reserve(2)
    const failed = execution.run(makeInput('bad-startup'), reservation.slotIds[0])
    const sibling = execution.run(makeInput('good-startup'), reservation.slotIds[1])

    await expect(failed.completion).rejects.toThrow('provider startup failed')
    await expect(sibling.accepted).resolves.toBeUndefined()
    controls.get('good-startup')!.complete()
    await expect(sibling.completion).resolves.toMatchObject({ status: 'completed' })
  })

  it('contains provider execution failure to its child and keeps the sibling runtime alive', async () => {
    const { execution, controls } = makeHarness(2)
    const reservation = await execution.reserve(2)
    const badInput = makeInput('bad')
    const goodInput = makeInput('good')
    const original = execution.run(badInput, reservation.slotIds[0])
    const sibling = execution.run(goodInput, reservation.slotIds[1])
    await vi.waitFor(() => expect(controls.has('bad')).toBe(true))
    await vi.waitFor(() => expect(controls.has('good')).toBe(true))
    controls.get('bad')!.fail(new Error('provider startup failed'))

    await expect(original.completion).rejects.toThrow('provider startup failed')
    let siblingDone = false
    void sibling.completion.then(() => {
      siblingDone = true
    })
    await Promise.resolve()
    expect(siblingDone).toBe(false)
    controls.get('good')?.complete()
    await expect(sibling.completion).resolves.toMatchObject({ status: 'completed' })
  })
})

const _eventTypeCheck: AcpRuntimeEvent | undefined = undefined
void _eventTypeCheck
