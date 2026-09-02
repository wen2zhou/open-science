import type {
  AgentResultDeliverySessionRequest,
  DismissAgentResultDeliveryRequest,
  SessionAgentResultActivity
} from '../../shared/agent-result-delivery'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { AgentResultDeliveryRepository } from './repository'

type AgentResultDeliveryIpcRepository = Pick<
  AgentResultDeliveryRepository,
  'listAwaitingAgent' | 'dismiss'
>

const registerAgentResultDeliveryIpcHandlers = (
  repository: AgentResultDeliveryIpcRepository
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
}

export { registerAgentResultDeliveryIpcHandlers }
