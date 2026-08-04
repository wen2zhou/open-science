import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  PlanCommandError,
  type GeneratePlanContent,
  type PlanCommandErrorCode
} from '../../shared/session-plan/contract'
import type { SessionPlanStepStatus } from '../../shared/session-persistence'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { PLAN_MCP_SERVER_ARG } from '../mcp-server-args'

const PLAN_MCP_SERVER_NAME = 'open-science-plan'

const stepSchema = z.object({ title: z.string().min(1), description: z.string().min(1) }).strict()
const delegationSchema = z
  .object({ name: z.string().min(1), steps: z.array(stepSchema).min(1) })
  .strict()
const phaseSchema = z
  .object({ name: z.string().min(1), delegations: z.array(delegationSchema).min(1) })
  .strict()

const generatePlanToolSchema = {
  session_id: z.never().optional(),
  plan_id: z.never().optional(),
  artifact_id: z.never().optional(),
  artifact_version_id: z.never().optional(),
  approve: z.literal(true).optional(),
  task_summary: z.string().min(1).optional(),
  phases: z.array(phaseSchema).min(1).optional(),
  desired_outputs: z.array(z.string().min(1)).optional(),
  feasibility: z
    .object({
      confidence: z.enum(['high', 'medium', 'low']),
      rationale: z.string().min(1)
    })
    .strict()
    .optional()
}

const updateStepStatusToolSchema = {
  title: z.string().min(1),
  status: z.enum(['in_progress', 'completed', 'blocked', 'skipped']),
  notes: z.string().min(1).optional()
}

type PlanMcpHandler = Readonly<{
  generate: (content: GeneratePlanContent) => Promise<unknown>
  approve: () => Promise<unknown>
  updateStepStatus: (input: {
    title: string
    status: SessionPlanStepStatus
    notes?: string
    expectedArtifactVersionId?: string
  }) => Promise<unknown>
}>

type PlanMcpEnvironment = LocalRpcTransport &
  Readonly<{
    token: string
    projectId: string
    sessionId: string
  }>

type PlanMcpServerConfigRequest = PlanMcpEnvironment &
  Readonly<{ command: string; entryPath: string }>

type PlanMcpToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}

const toolResult = (result: unknown): PlanMcpToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
})

const toolError = (
  code: PlanCommandErrorCode | 'plan-command-failed',
  message: string
): PlanMcpToolResult => ({
  ...toolResult({ error: { code, message } }),
  isError: true
})

const runPlanTool = async (work: () => Promise<unknown>): Promise<PlanMcpToolResult> => {
  try {
    return toolResult(await work())
  } catch (error) {
    if (error instanceof PlanCommandError) return toolError(error.code, error.message)
    const message = error instanceof Error ? error.message : 'Session Plan command failed.'
    return toolError('plan-command-failed', message)
  }
}

const projectionVersionId = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  const projection = (result as { projection?: unknown }).projection
  if (typeof projection !== 'object' || projection === null) return undefined
  const versionId = (projection as { artifactVersionId?: unknown }).artifactVersionId
  return typeof versionId === 'string' ? versionId : undefined
}

const createPlanMcpServer = (handler: PlanMcpHandler): ModelContextProtocolServer => {
  let executionArtifactVersionId: string | undefined
  const server = new ModelContextProtocolServer({
    name: PLAN_MCP_SERVER_NAME,
    version: '1.0.0'
  })
  server.registerTool(
    'generate_plan',
    {
      title: 'Generate or approve Session Plan',
      description: 'Create an immutable execution Plan, or approve the active Plan.',
      inputSchema: generatePlanToolSchema
    },
    async ({ approve, task_summary, phases, desired_outputs, feasibility }) =>
      runPlanTool(async () => {
        const hasContent =
          task_summary !== undefined ||
          phases !== undefined ||
          desired_outputs !== undefined ||
          feasibility !== undefined
        if (approve === true) {
          if (hasContent) {
            throw new PlanCommandError(
              'invalid-plan',
              'Approval cannot be combined with Plan content.'
            )
          }
          const result = await handler.approve()
          executionArtifactVersionId = projectionVersionId(result) ?? executionArtifactVersionId
          return result
        }
        if (!task_summary || !phases || !desired_outputs || !feasibility) {
          throw new PlanCommandError('invalid-plan', 'A complete Plan document is required.')
        }
        const result = await handler.generate({
          task_summary,
          phases,
          desired_outputs,
          feasibility
        })
        executionArtifactVersionId = projectionVersionId(result) ?? executionArtifactVersionId
        return result
      })
  )
  server.registerTool(
    'update_step_status',
    {
      title: 'Update Plan step status',
      description: 'Update one exact step title on the server-bound active Plan.',
      inputSchema: updateStepStatusToolSchema
    },
    async (input) =>
      runPlanTool(() =>
        handler.updateStepStatus({
          ...input,
          expectedArtifactVersionId: executionArtifactVersionId
        })
      )
  )
  return server
}

const callPlanRpc = async (
  environment: PlanMcpEnvironment,
  operation: 'generate' | 'approve' | 'updateStepStatus',
  input?: unknown
): Promise<unknown> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'planCall',
        params: {
          projectId: environment.projectId,
          sessionId: environment.sessionId,
          operation,
          input
        }
      })
    },
    'Session Plan RPC'
  )
  const payload = (await response.json()) as {
    result?: unknown
    error?: string
    errorCode?: PlanCommandErrorCode
  }
  if (!response.ok || payload.error) {
    const message = payload.error ?? `Session Plan RPC failed with status ${response.status}`
    if (payload.errorCode) throw new PlanCommandError(payload.errorCode, message)
    throw new Error(message)
  }
  return payload.result
}

const executionVersionByEnvironment = new WeakMap<PlanMcpEnvironment, string>()

const createPlanMcpServerForEnvironment = (
  environment: PlanMcpEnvironment
): ModelContextProtocolServer =>
  createPlanMcpServer({
    generate: async (content) => {
      const result = await callPlanRpc(environment, 'generate', content)
      const versionId = projectionVersionId(result)
      if (versionId) executionVersionByEnvironment.set(environment, versionId)
      return result
    },
    approve: async () => {
      const result = await callPlanRpc(environment, 'approve')
      const versionId = projectionVersionId(result)
      if (versionId) executionVersionByEnvironment.set(environment, versionId)
      return result
    },
    updateStepStatus: (input) =>
      callPlanRpc(environment, 'updateStepStatus', {
        ...input,
        expectedArtifactVersionId:
          input.expectedArtifactVersionId ?? executionVersionByEnvironment.get(environment)
      })
  })

const createPlanMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  projectId,
  sessionId
}: PlanMcpServerConfigRequest): McpServerStdio => ({
  name: PLAN_MCP_SERVER_NAME,
  command,
  args: [entryPath, PLAN_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'OPEN_SCIENCE_PLAN_RPC_ENDPOINT', value: endpoint },
    ...(socketPath ? [{ name: 'OPEN_SCIENCE_PLAN_RPC_SOCKET_PATH', value: socketPath }] : []),
    { name: 'OPEN_SCIENCE_PLAN_RPC_TOKEN', value: token },
    { name: 'OPEN_SCIENCE_PLAN_PROJECT_ID', value: projectId },
    { name: 'OPEN_SCIENCE_PLAN_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing Session Plan MCP environment variable: ${name}`)
  return value
}

const runPlanMcpServer = async (): Promise<void> => {
  const server = createPlanMcpServerForEnvironment({
    endpoint: requireEnvironment('OPEN_SCIENCE_PLAN_RPC_ENDPOINT'),
    socketPath: process.env.OPEN_SCIENCE_PLAN_RPC_SOCKET_PATH,
    token: requireEnvironment('OPEN_SCIENCE_PLAN_RPC_TOKEN'),
    projectId: requireEnvironment('OPEN_SCIENCE_PLAN_PROJECT_ID'),
    sessionId: requireEnvironment('OPEN_SCIENCE_PLAN_SESSION_ID')
  })
  await server.connect(new StdioServerTransport())
}

export {
  PLAN_MCP_SERVER_NAME,
  callPlanRpc,
  createPlanMcpServer,
  createPlanMcpServerConfig,
  createPlanMcpServerForEnvironment,
  generatePlanToolSchema,
  runPlanMcpServer,
  updateStepStatusToolSchema
}
export type { PlanMcpEnvironment, PlanMcpHandler, PlanMcpServerConfigRequest }
