import { beforeEach, describe, expect, it } from 'vitest'

import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../../shared/conversation-graph'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../../shared/session-persistence'
import {
  acknowledgeSessionConversationCommands,
  captureSessionConversationIntents,
  pendingSessionConversationCommands,
  resetSessionConversationIntentsForTests
} from './session-conversation-intents'

const prompt = (id: string, content: string, timestamp: number): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: timestamp,
  updatedAt: timestamp
})

const fixture = (): PersistedChatSession => {
  const first = prompt('prompt-1', 'First', 1)
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    permissionProfile: 'ask',
    messages: [first],
    conversationGraph: createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [first],
      createdAt: 1,
      updatedAt: 1
    }),
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Session conversation intents', () => {
  beforeEach(resetSessionConversationIntentsForTests)

  it('captures append and run admission while keeping stable identities until acknowledgement', () => {
    const before = fixture()
    const message = prompt('prompt-2', 'Second', 2)
    const conversationGraph = synchronizeActiveConversationMessages(
      before.conversationGraph!,
      [...before.messages, message],
      2
    )
    const after: PersistedChatSession = {
      ...before,
      messages: [...before.messages, message],
      conversationGraph,
      activeRun: { promptMessageId: message.id, startedAt: 3 },
      status: 'running',
      updatedAt: 3
    }
    captureSessionConversationIntents(before, after)
    const pending = pendingSessionConversationCommands(before.id)
    expect(pending.map(({ kind }) => kind)).toEqual(['append-user', 'start-run'])
    expect(pendingSessionConversationCommands(before.id)).toEqual(pending)

    acknowledgeSessionConversationCommands({
      ...after,
      runtimeConversationCommandIds: [pending[0].id]
    })
    expect(pendingSessionConversationCommands(before.id)).toEqual([pending[1]])
  })

  it('captures a fork before its branch selection', () => {
    const before = fixture()
    const root = before.conversationGraph!.frames[0]
    const branchId = 'edited-branch'
    const conversationGraph = activateConversationBranch(
      forkEditedConversationMessage(before.conversationGraph!, 'prompt-1', branchId, 2),
      branchId
    )
    const after = { ...before, conversationGraph, updatedAt: 2 }
    captureSessionConversationIntents(before, after)
    const commands = pendingSessionConversationCommands(before.id)
    expect(commands.map(({ kind }) => kind)).toEqual(['fork-message', 'select-branch'])
    expect(commands[1]).toMatchObject({ previousBranchId: root.activeBranchId, branchId })
  })

  it('opens a new runtime segment before appending a message that uses it', () => {
    const before = fixture()
    const graph = structuredClone(before.conversationGraph!)
    const segment = {
      id: 'segment-2',
      agentFrameId: graph.rootFrameId,
      frameworkId: 'opencode' as const,
      startedAt: 2
    }
    graph.runtimeSegments.push(segment)
    const message = {
      ...prompt('prompt-2', 'Second', 3),
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: graph.branches[0].id,
      parentMessageId: 'prompt-1',
      runtimeSegmentId: segment.id
    }
    graph.messages.push(message)
    graph.branches[0].headMessageId = message.id

    captureSessionConversationIntents(before, {
      ...before,
      messages: [...before.messages, message],
      conversationGraph: graph,
      updatedAt: 3
    })

    expect(pendingSessionConversationCommands(before.id).map(({ kind }) => kind)).toEqual([
      'open-segment',
      'append-user'
    ])
  })

  it('does not infer intents from passive runtime changes or legacy sessions', () => {
    const before = fixture()
    const after = { ...before, status: 'running' as const, updatedAt: 2 }
    captureSessionConversationIntents(before, after)
    captureSessionConversationIntents(
      { ...before, runtimeTranscriptOwner: undefined },
      { ...after, runtimeTranscriptOwner: undefined }
    )
    expect(pendingSessionConversationCommands(before.id)).toEqual([])
  })
})
