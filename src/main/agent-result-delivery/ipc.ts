import type {
  AgentResultDeliverySessionRequest,
  AgentResultDeliveryProjectRequest,
  DismissAgentResultDeliveryRequest,
  ProjectBackgroundActivity,
  ProjectBackgroundActivityItem,
  SessionAgentResultActivity
} from '../../shared/agent-result-delivery'
import type { NotebookBackgroundRunResult } from '../../shared/notebook'
import type { JobSummary } from '../../shared/compute'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { AgentResultDeliveryRepository } from './repository'

type AgentResultDeliveryIpcRepository = Pick<
  AgentResultDeliveryRepository,
  'listAwaitingAgent' | 'dismiss' | 'listProjectVisible' | 'projectRevision'
>

type AgentResultDeliveryIpcOptions = Readonly<{
  resolveLocalRun?: (request: {
    projectId: string
    sessionId: string
    runId: string
    agentFrameId?: string
  }) => Promise<NotebookBackgroundRunResult | undefined>
  listActiveComputeJobs?: () => Promise<readonly JobSummary[]>
}>

const registerAgentResultDeliveryIpcHandlers = (
  repository: AgentResultDeliveryIpcRepository,
  options: AgentResultDeliveryIpcOptions = {}
): void => {
  ipcMainHandle(
    'agent-result-delivery:session-activity',
    async (
      _event,
      request: AgentResultDeliverySessionRequest
    ): Promise<SessionAgentResultActivity> => ({
      active: [],
      awaitingAgent: await repository.listAwaitingAgent(request.sessionId)
    })
  )
  ipcMainHandle(
    'agent-result-delivery:dismiss',
    (_event, request: DismissAgentResultDeliveryRequest) =>
      repository.dismiss(request.sessionId, request.deliveryId)
  )
  ipcMainHandle(
    'agent-result-delivery:project-activity',
    async (
      _event,
      request: AgentResultDeliveryProjectRequest
    ): Promise<ProjectBackgroundActivity> => {
      const [deliveries, durableRevision] = await Promise.all([
        repository.listProjectVisible(request.projectId, 201),
        repository.projectRevision(request.projectId)
      ])
      const computeJobs = new Map(
        ((await options.listActiveComputeJobs?.().catch(() => [])) ?? [])
          .filter((job) => job.project_id === request.projectId)
          .map((job) => [job.job_id, job] as const)
      )
      const items = await Promise.all(
        deliveries.slice(0, 200).map(async (delivery): Promise<ProjectBackgroundActivityItem> => {
          const context = delivery.context
          const waiting = context.terminalStatus === 'waiting-result'
          if (waiting && 'runId' in context) {
            const result = await options
              .resolveLocalRun?.({
                projectId: context.projectId,
                sessionId: context.sessionId,
                runId: context.runId,
                ...(context.agentFrameId ? { agentFrameId: context.agentFrameId } : {})
              })
              .catch(() => undefined)
            const status = result?.run.status ?? 'result-unavailable'
            return {
              id: delivery.id,
              sourceKind: 'local-run',
              sourceId: context.runId,
              executionType: context.executionType,
              projectId: context.projectId,
              sessionId: context.sessionId,
              title: context.title,
              lane: context.lane,
              status,
              active: status === 'queued' || status === 'running',
              needsAttention: status === 'result-unavailable',
              updatedAt: Math.max(
                delivery.updatedAt,
                result?.run.endedAt ?? result?.run.startedAt ?? 0
              )
            }
          }
          if (waiting && 'jobId' in context) {
            const job = computeJobs.get(context.jobId)
            const status = job
              ? job.cancellation_status === 'cancelling'
                ? 'cancelling'
                : job.status
              : 'result-unavailable'
            return {
              id: delivery.id,
              sourceKind: 'compute-job',
              sourceId: context.jobId,
              executionType: 'compute-job',
              projectId: context.projectId,
              sessionId: context.sessionId,
              title: job?.intent ?? context.title ?? context.jobId,
              lane: context.computeHost.displayName,
              status,
              active:
                status === 'queued' ||
                status === 'submitted' ||
                status === 'running' ||
                status === 'cancelling',
              needsAttention: status === 'result-unavailable',
              updatedAt: Math.max(
                delivery.updatedAt,
                job?.finished_at ?? job?.started_at ?? job?.created_at ?? 0
              )
            }
          }
          const computeContext = context.sourceKind === 'compute-job'
          const needsAttention = delivery.state === 'needs-attention'
          return {
            id: delivery.id,
            sourceKind: computeContext ? 'compute-job' : 'local-run',
            sourceId: computeContext ? context.jobId : context.runId,
            executionType: context.executionType,
            projectId: context.projectId,
            sessionId: context.sessionId,
            title: computeContext
              ? (context.title ?? context.jobId)
              : (context.title ?? context.runId),
            lane: computeContext
              ? context.computeHost.displayName
              : (context.lane ??
                (context.executionType === 'repl'
                  ? 'project-control'
                  : context.executionType === 'shell'
                    ? 'shell'
                    : context.executionType === 'r'
                      ? 'R'
                      : 'Python')),
            status: needsAttention ? 'needs-attention' : 'pending-delivery',
            active: false,
            needsAttention,
            outcomeStatus: context.terminalStatus,
            updatedAt: delivery.updatedAt
          }
        })
      )
      return {
        revision: Math.max(
          durableRevision,
          items.reduce((revision, item) => Math.max(revision, item.updatedAt), 0)
        ),
        items,
        truncated: deliveries.length > 200
      }
    }
  )
}

export { registerAgentResultDeliveryIpcHandlers }
