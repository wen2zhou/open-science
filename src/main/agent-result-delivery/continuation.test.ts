import { describe, expect, it } from 'vitest'

import { hasSavedAgentResultContinuation } from './continuation'

const request = {
  continuationMessageId: 'continuation-1',
  deliveryIds: ['local-run:run-1']
}
const prompt = {
  id: 'continuation-1',
  role: 'user' as const,
  status: 'complete',
  attribution: {
    kind: 'application',
    feature: 'background-results',
    purpose: 'agent-result-delivery',
    deliveryKey: 'agent-result-delivery:continuation-1',
    deliveryIds: ['local-run:run-1']
  }
}
const reply = {
  id: 'reply-1',
  role: 'agent' as const,
  status: 'complete',
  responseToMessageId: 'continuation-1'
}

describe('hasSavedAgentResultContinuation', () => {
  it('requires both the exact durable result context and its completed Agent reply', () => {
    expect(hasSavedAgentResultContinuation([prompt, reply], request)).toBe(true)
    expect(hasSavedAgentResultContinuation([reply], request)).toBe(false)
    expect(hasSavedAgentResultContinuation([prompt], request)).toBe(false)
    expect(
      hasSavedAgentResultContinuation(
        [{ ...prompt, attribution: { ...prompt.attribution, deliveryIds: ['other'] } }, reply],
        request
      )
    ).toBe(false)
  })
})
