import { describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { buildAgentResultContinuationPrompt, hasSavedAgentResultContinuation } from './continuation'

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

  it('matches a durable delivery batch as a set rather than depending on row order', () => {
    const second = 'local-run:run-2'
    expect(
      hasSavedAgentResultContinuation(
        [
          {
            ...prompt,
            attribution: {
              ...prompt.attribution,
              deliveryIds: [second, ...prompt.attribution.deliveryIds]
            }
          },
          reply
        ],
        { ...request, deliveryIds: [...request.deliveryIds, second] }
      )
    ).toBe(true)
  })
})

describe('buildAgentResultContinuationPrompt', () => {
  it('preserves the durable active ancestry and Runtime Segment for a background result turn', () => {
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'original-prompt',
        role: 'user',
        content: 'Run the analysis in the background.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'original-reply',
        role: 'agent',
        content: 'The background Run was submitted.',
        status: 'complete',
        responseToMessageId: 'original-prompt',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Background analysis',
      cwd: '/workspace',
      status: 'idle',
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages,
        frameworkId: 'opencode',
        providerId: 'provider-1',
        model: 'model-1',
        createdAt: 1,
        updatedAt: 2
      }),
      createdAt: 1,
      updatedAt: 2
    }

    const prompt = buildAgentResultContinuationPrompt(session, {
      sessionId: 'session-1',
      text: 'Background execution outcomes are now available.',
      continuationMessageId: 'delivery-prompt'
    })

    expect(prompt.provenanceContext).toEqual({
      promptMessageId: 'delivery-prompt',
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'root-frame-session-1',
      messageBranchId: 'message-branch-session-1',
      messageBranchAncestry: ['message-branch-session-1'],
      messageAncestry: ['original-prompt', 'original-reply', 'delivery-prompt'],
      runtimeSegmentId: 'runtime-segment-session-1'
    })
  })
})
