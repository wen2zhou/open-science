import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { PlanCommandError } from '../../shared/session-plan/contract'
import { callPlanRpc, createPlanMcpServer } from './plan-mcp-server'

describe('Session Plan MCP server', () => {
  it('rehydrates structured Plan errors returned by the local RPC adapter', async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'A newer Plan is active.', errorCode: 'stale-plan' }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', fetch)

    try {
      await expect(
        callPlanRpc(
          {
            endpoint: 'http://127.0.0.1:1234/plan',
            token: 'plan-token',
            projectId: 'project-1',
            sessionId: 'session-1'
          },
          'updateStepStatus',
          { title: 'Analyze the data', status: 'completed' }
        )
      ).rejects.toMatchObject({
        name: 'PlanCommandError',
        code: 'stale-plan',
        message: 'A newer Plan is active.'
      })
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/plan',
        expect.objectContaining({
          method: 'POST',
          headers: {
            authorization: 'Bearer plan-token',
            'content-type': 'application/json'
          }
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exposes server-bound generation, approval, and exact-title status commands', async () => {
    const generate = vi.fn().mockResolvedValue({
      projection: { artifactVersionId: 'version-1', lifecycle: 'approved' }
    })
    const approve = vi.fn().mockResolvedValue({
      projection: { artifactVersionId: 'version-1', lifecycle: 'approved' }
    })
    const updateStepStatus = vi.fn().mockResolvedValue({ lifecycle: 'completed' })
    const server = createPlanMcpServer({ generate, approve, updateStepStatus })
    const client = new Client({ name: 'plan-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'generate_plan',
      'update_step_status'
    ])
    await client.callTool({
      name: 'generate_plan',
      arguments: {
        task_summary: 'Analyze one dataset',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      }
    })
    await client.callTool({ name: 'generate_plan', arguments: { approve: true } })
    await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'completed' }
    })

    expect(generate).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledOnce()
    expect(updateStepStatus).toHaveBeenCalledWith({
      title: 'Analyze the data',
      status: 'completed',
      expectedArtifactVersionId: 'version-1'
    })
    const forged = await client.callTool({
      name: 'generate_plan',
      arguments: { approve: true, session_id: 'forged' }
    })
    expect(forged).toMatchObject({ isError: true })
    await client.close()
    await server.close()
  })

  it('returns tagged-union and domain failures as structured MCP errors', async () => {
    const server = createPlanMcpServer({
      generate: vi.fn(),
      approve: vi.fn(),
      updateStepStatus: vi.fn(async () => {
        throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
      })
    })
    const client = new Client({ name: 'plan-errors', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const mixed = await client.callTool({
      name: 'generate_plan',
      arguments: { approve: true, task_summary: 'Do both shapes' }
    })
    expect(mixed).toMatchObject({ isError: true })
    expect(JSON.parse((mixed as { content: Array<{ text: string }> }).content[0].text)).toEqual({
      error: {
        code: 'invalid-plan',
        message: 'Approval cannot be combined with Plan content.'
      }
    })

    const stale = await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'completed' }
    })
    expect(stale).toMatchObject({ isError: true })
    expect(JSON.parse((stale as { content: Array<{ text: string }> }).content[0].text)).toEqual({
      error: { code: 'stale-plan', message: 'A newer Plan is active.' }
    })

    await client.close()
    await server.close()
  })
})
