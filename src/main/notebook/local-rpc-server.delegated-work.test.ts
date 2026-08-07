import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDeterministicDelegateExecution } from '../delegated-work/deterministic-execution'
import {
  createDurableDelegatedWork,
  createInMemoryDelegatedWorkRecords
} from '../delegated-work/durable-delegated-work'
import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('authenticated delegatedWorkCall route', () => {
  it('describes delegate availability from the authenticated control binding without an active invocation', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate: vi.fn() }
    })
    const main = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const child = await server.issueControlConnection('session-1', 'project-1', 'child-frame', {
      role: 'delegate',
      attemptId: 'attempt-1'
    })

    const ask = async (endpoint: string, token: string, callerRole: string): Promise<unknown> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method: 'hostSdkHelp',
          params: { query: 'delegate', caller_role: callerRole }
        })
      })
      expect(response.status).toBe(200)
      return response.json()
    }

    await expect(ask(main.endpoint, main.token, 'delegate')).resolves.toMatchObject({
      result: { kind: 'operation', availability: { status: 'available' } }
    })
    await expect(ask(child.endpoint, child.token, 'main')).resolves.toMatchObject({
      result: {
        kind: 'operation',
        availability: {
          status: 'unavailable',
          reason: 'Nested delegation is unsupported for Delegate agents.'
        }
      }
    })

    main.release()
    child.release()
  })

  it('forwards a request array through the authenticated host seam without reordering it', async () => {
    const delegate = vi.fn(async () => ({
      kind: 'receipts' as const,
      children: [
        { frameId: 'frame-first', attemptId: 'attempt-first', status: 'running' as const },
        { frameId: 'frame-second', attemptId: 'attempt-second', status: 'running' as const }
      ]
    }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1', 'root-frame')
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          request: [{ task: 'First' }, { task: 'Second' }],
          options: { wait: false }
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: {
        kind: 'receipts',
        children: [
          { frameId: 'frame-first', attemptId: 'attempt-first', status: 'running' },
          { frameId: 'frame-second', attemptId: 'attempt-second', status: 'running' }
        ]
      }
    })
    expect(delegate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { projectId: 'project-1', sessionId: 'session-1' },
        frameId: 'root-frame'
      }),
      [{ task: 'First' }, { task: 'Second' }],
      { wait: false }
    )
    endInvocation()
    connection.release()
  })

  it('derives delegation authority from the active control capability and ignores forged owner fields', async () => {
    const session = { projectId: 'trusted-project', sessionId: 'trusted-session' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'trusted-root-frame',
      originMessageId: 'trusted-origin-message'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })

    const responsePending = fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          project_id: 'forged-project',
          session_id: 'forged-session',
          frame_id: 'forged-frame',
          origin_message_id: 'forged-origin',
          tool_invocation_id: 'forged-tool',
          request: { task: 'Trace the source' }
        }
      })
    })

    await expect.poll(() => execution.controls()).toHaveLength(1)
    await expect(work.sessionSummary(session)).resolves.toMatchObject({
      runningCount: 1,
      children: [{ title: 'Trace the source', status: 'running' }]
    })
    const frameId = (await work.sessionSummary(session)).children[0].frameId
    await expect(work.readAgentFrame(session, frameId)).resolves.toMatchObject({
      status: 'running',
      messages: [{ role: 'user', content: 'Trace the source' }]
    })
    execution.controls()[0].accept()
    execution.controls()[0].complete('done')
    const response = await responsePending

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: { kind: 'results', children: [{ response: 'done' }] }
    })
    await expect(work.readAgentFrame(session, frameId)).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Trace the source' },
        { role: 'assistant', content: 'done' }
      ]
    })

    endInvocation()
    connection.release()
  })

  it('rejects delegation when no authenticated control invocation is active', async () => {
    const delegate = vi.fn()
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: { delegate, children: vi.fn(), collect: vi.fn() }
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: { request: { task: 'Unauthorized' } }
      })
    })

    expect(response.status).toBe(403)
    expect(delegate).not.toHaveBeenCalled()
    connection.release()
  })

  it('exposes authenticated child stop without trusting request owner fields', async () => {
    const session = { projectId: 'trusted-project', sessionId: 'trusted-session' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'trusted-root-frame',
      originMessageId: 'trusted-origin-message'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })
    const receipt = await work.delegate(
      {
        session,
        frameId: 'trusted-root-frame',
        role: 'main',
        originMessageId: 'trusted-origin-message',
        toolInvocationId: 'direct-admission'
      },
      { task: 'Stop through host' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          operation: 'stop_children',
          frame_ids: [receipt.children[0].frameId],
          project_id: 'forged-project',
          frame_id: 'forged-frame'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: [{ frameId: receipt.children[0].frameId, status: 'cancelled' }]
    })
    endInvocation()
    connection.release()
  })

  it('fails closed before reservation and durable mutation when the framework is unavailable', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      assertAvailable: async () => {
        throw new Error('delegated execution is not certified for this framework')
      }
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'session-1',
      'project-1',
      'root-frame-session-1'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-call-1',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: { request: { task: 'Must remain unavailable' } }
      })
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'delegated execution is not certified for this framework'
    })
    expect(execution.reservationCounts()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
    endInvocation()
    connection.release()
  })

  it('authenticates detached children and collect operations through the active control capability', async () => {
    const session = { projectId: 'trusted-project', sessionId: 'trusted-session' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'trusted-root-frame',
      originMessageId: 'trusted-origin-message'
    })
    const work = createDurableDelegatedWork({ execution, records })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'trusted-root-frame'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool-call',
      originatingUserMessageId: 'trusted-origin-message'
    })
    const call = async (params: Record<string, unknown>): Promise<unknown> => {
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'delegatedWorkCall', params })
      })
      expect(response.status).toBe(200)
      return (await response.json()).result
    }

    const receipt = (await call({
      op: 'delegate',
      request: { task: 'Detached source check', name: 'Source check' },
      options: { wait: false }
    })) as { children: Array<{ frameId: string; attemptId: string }> }
    const frameId = receipt.children[0].frameId
    await expect(
      call({
        op: 'children',
        frame_ids: [frameId],
        project_id: 'forged-project',
        session_id: 'forged-session',
        frame_id: 'forged-parent'
      })
    ).resolves.toEqual([
      {
        frameId,
        attemptId: receipt.children[0].attemptId,
        title: 'Source check',
        status: 'running'
      }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Durable RPC answer')

    await expect(call({ op: 'collect', frame_ids: [frameId] })).resolves.toMatchObject([
      { frameId, status: 'completed', response: 'Durable RPC answer', artifactsCreated: [] }
    ])
    endInvocation()
    connection.release()
  })

  it('routes an authenticated send_message to terminal-child continuation', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      {
        session,
        frameId: 'root-frame-session-1',
        role: 'main',
        originMessageId: 'origin-message-1',
        toolInvocationId: 'dispatch-call'
      },
      { task: 'Initial task' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Initial answer')
    await expect.poll(async () => (await work.sessionSummary(session)).runningCount).toBe(0)
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      'root-frame-session-1'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-2',
      controlInvocationGeneration: 2,
      toolInvocationId: 'continuation-call',
      originatingUserMessageId: 'origin-message-1'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: dispatched.children[0].frameId,
          message: 'Continue through the host'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        kind: 'continued',
        child: { frameId: dispatched.children[0].frameId, status: 'running' }
      }
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input).toMatchObject({
      frameId: dispatched.children[0].frameId,
      task: 'Continue through the host',
      continuation: true
    })
    endInvocation()
    connection.release()
  })

  it('routes a Delegate question to its authenticated parent and ignores forged caller fields', async () => {
    const session = { projectId: 'project-1', sessionId: 'session-1' }
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: 'root-frame-session-1',
      originMessageId: 'origin-message-1'
    })
    const deliveries: unknown[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      deliverToParent: async (delivery) => {
        deliveries.push(delivery)
      }
    })
    const dispatched = await work.delegate(
      {
        session,
        frameId: 'root-frame-session-1',
        role: 'main',
        originMessageId: 'origin-message-1',
        toolInvocationId: 'dispatch-call'
      },
      { task: 'Initial task' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const child = dispatched.children[0]
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: work
    })
    const connection = await server.issueControlConnection(
      session.sessionId,
      session.projectId,
      child.frameId,
      { role: 'delegate', attemptId: child.attemptId }
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'child-turn',
      controlInvocationGeneration: 1,
      toolInvocationId: 'child-question',
      originatingUserMessageId: 'forged-origin-is-ignored-for-parent-routing'
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          op: 'send_message',
          target: 'parent',
          message: 'Which cohort?',
          kind: 'question',
          project_id: 'forged-project',
          session_id: 'forged-session',
          frame_id: 'forged-frame',
          attempt_id: 'forged-attempt',
          caller_role: 'main'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: { kind: 'queued', targetFrameId: 'root-frame-session-1' }
    })
    expect(deliveries).toEqual([
      expect.objectContaining({
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: 'root-frame-session-1',
        text: 'Which cohort?',
        kind: 'question'
      })
    ])
    endInvocation()
    connection.release()
  })
})
