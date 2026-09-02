import { isAgentResultDeliveryAttribution } from '../../shared/session-persistence'

type PersistedDeliveryMessage = Readonly<{
  id: string
  role: 'user' | 'agent'
  status: string
  responseToMessageId?: string
  attribution?: unknown
}>

const hasSavedAgentResultContinuation = (
  messages: readonly PersistedDeliveryMessage[],
  request: Readonly<{
    continuationMessageId: string
    deliveryIds: readonly string[]
  }>
): boolean => {
  const prompt = messages.find(
    (message) =>
      message.role === 'user' &&
      message.id === request.continuationMessageId &&
      isAgentResultDeliveryAttribution(message.attribution)
  )
  if (
    !prompt ||
    !isAgentResultDeliveryAttribution(prompt.attribution) ||
    prompt.attribution.deliveryIds.length !== request.deliveryIds.length ||
    prompt.attribution.deliveryIds.some(
      (deliveryId, index) => deliveryId !== request.deliveryIds[index]
    )
  ) {
    return false
  }
  return messages.some(
    (message) =>
      message.role === 'agent' &&
      message.responseToMessageId === request.continuationMessageId &&
      message.status === 'complete'
  )
}

export { hasSavedAgentResultContinuation }
