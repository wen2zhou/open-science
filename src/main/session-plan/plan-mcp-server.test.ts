import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { PlanCommandError } from '../../shared/session-plan/contract'
import { callPlanRpc, createPlanMcpServer } from './plan-mcp-server'

describe('Session Plan MCP server', () => {
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

    updateStepStatus.mockRejectedValueOnce(
      new PlanCommandError('dependency-not-satisfied', 'A previous step is unfinished.')
    )
    const rejected = await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'in_progress' }
    })
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'dependency-not-satisfied',
          message: 'A previous step is unfinished.'
        }
      }
    })
    await client.close()
    await server.close()
  })

  it('reconstructs structured Plan errors returned by the local RPC boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'dependency-not-satisfied',
              message: 'A previous step is unfinished.'
            }
          }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    try {
      await expect(
        callPlanRpc(
          {
            endpoint: 'http://127.0.0.1:1234',
            token: 'token',
            projectId: 'project-1',
            sessionId: 'session-1'
          },
          'updateStepStatus',
          { title: 'Analyze the data', status: 'in_progress' }
        )
      ).rejects.toMatchObject({
        code: 'dependency-not-satisfied',
        message: 'A previous step is unfinished.'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
