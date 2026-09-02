import type { NotebookRunStatus } from './notebook'

export type AgentResultDeliveryState =
  'waiting-result' | 'pending' | 'claimed' | 'consumed' | 'needs-attention' | 'dismissed'

export type AgentResultExecutionType = 'python' | 'r' | 'repl' | 'shell'

export type AgentResultDeliveryContext = Readonly<{
  runId: string
  executionType: AgentResultExecutionType
  terminalStatus: Exclude<NotebookRunStatus, 'queued' | 'running'>
  resultSummary: string
  errorGuidance?: string
  projectId: string
  sessionId: string
  agentFrameId?: string
  provenance?: Readonly<{
    messageBranchId?: string
    runtimeSegmentId?: string
    promptMessageId?: string
    executionInvocationId?: string
  }>
}>

export type AgentResultDelivery = Readonly<{
  id: string
  state: AgentResultDeliveryState
  context: AgentResultDeliveryContext
  attemptCount: number
  claimToken?: string
  claimExpiresAt?: number
  continuationMessageId?: string
  createdAt: number
  updatedAt: number
  consumedAt?: number
  dismissedAt?: number
}>

export type SessionAgentResultActivity = Readonly<{
  active: readonly []
  awaitingAgent: readonly AgentResultDelivery[]
}>

export type AgentResultDeliverySessionRequest = Readonly<{ sessionId: string }>
export type DismissAgentResultDeliveryRequest = AgentResultDeliverySessionRequest &
  Readonly<{ deliveryId: string }>
