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
      delegatedWorkService: { delegate }
    })
    const connection = await server.issueControlConnection('session-1', 'project-1')

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
    const connection = await server.issueControlConnection('session-1', 'project-1')
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
})
