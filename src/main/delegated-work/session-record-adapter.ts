import { randomUUID } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { DelegatedWorkRecordCommands, SessionKey } from './session-records'
import type {
  AuthenticatedDelegateCaller,
  DelegatedWorkDurableRecords,
  DurableSnapshot
} from './durable-delegated-work'

type SessionRecordAdapterOptions = Readonly<{
  commands: DelegatedWorkRecordCommands
  readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
  frameworkId: Parameters<DelegatedWorkRecordCommands['startAttemptRuntime']>[1]['frameworkId']
  createId?: (kind: 'branch') => string
}>

const createSessionDelegatedWorkRecords = (
  options: SessionRecordAdapterOptions,
  key: SessionKey
): DelegatedWorkDurableRecords => {
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const load = async (): Promise<PersistedChatSession> => {
    const session = await options.readSession(key)
    if (!session) throw new Error('Delegated Work Session is not durable.')
    return session
  }
  const revision = async (): Promise<number> => (await load()).runtimeContext?.revision ?? 0

  return {
    async admitChild(input) {
      await options.commands.createChildren(key, {
        expectedRevision: await revision(),
        parentFrameId: input.caller.frameId,
        originMessageId: input.caller.originMessageId,
        children: [
          {
            frameId: input.frameId,
            branchId: createId('branch'),
            messageId: input.userMessageId,
            attemptId: input.attemptId,
            task: input.request.task,
            name: input.title,
            context: input.request.context,
            inputs: input.request.inputs,
            resolvedAgent: { kind: 'main' },
            startedAt: input.startedAt
          }
        ]
      })
    },
    async startRuntime(frameId, attemptId, runtimeSegmentId) {
      await options.commands.startAttemptRuntime(key, {
        expectedRevision: await revision(),
        frameId,
        attemptId,
        runtimeSegmentId,
        frameworkId: options.frameworkId,
        startedAt: Date.now()
      })
    },
    async terminalize(input) {
      if (input.status === 'completed') {
        const attempt = (await load()).runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === input.frameId)
          ?.attempts.find((candidate) => candidate.id === input.attemptId)
        await options.commands.applyAgentEvent(key, {
          expectedRevision: await revision(),
          frameId: input.frameId,
          attemptId: input.attemptId,
          event: {
            kind: 'message',
            runtimeSegmentId: attempt?.runtimeSegmentIds.at(-1) ?? '',
            message: {
              id: input.terminalMessage.id,
              role: 'agent',
              content: input.terminalMessage.content,
              status: 'complete',
              eventIds: [],
              createdAt: input.terminalMessage.createdAt,
              completedAt: input.terminalMessage.createdAt,
              updatedAt: input.terminalMessage.createdAt
            }
          }
        })
      }
      await options.commands.transitionAttempt(key, {
        expectedRevision: await revision(),
        frameId: input.frameId,
        attemptId: input.attemptId,
        status: input.status,
        endedAt: input.endedAt,
        ...(input.status === 'completed'
          ? { terminalMessageId: input.terminalMessage.id }
          : input.status === 'cancelled'
            ? { cancellationReason: input.cancellationReason }
            : { error: input.error })
      })
    },
    async snapshot(): Promise<DurableSnapshot> {
      const session = await load()
      const graph = materializeSessionConversationGraph(session).conversationGraph
      if (!graph) throw new Error('Delegated Work Session has no Conversation Graph.')
      const records = session.runtimeContext?.delegatedWork?.records ?? []
      const rootMessages = resolveActiveConversationMessages({
        ...graph,
        activeFrameId: graph.rootFrameId
      })
      return {
        session: key,
        rootFrameId: graph.rootFrameId,
        originMessageIds: rootMessages.map((message) => message.id),
        records: records.flatMap((record) => {
          const frame = graph.frames.find((candidate) => candidate.id === record.agentFrameId)
          const firstMessage = graph.messages.find(
            (message) => message.agentFrameId === record.agentFrameId && message.role === 'user'
          )
          if (!frame || !firstMessage) return []
          return [
            {
              frameId: frame.id,
              parentFrameId: frame.parentFrameId ?? '',
              originMessageId: frame.originMessageId ?? '',
              title: frame.delegateName ?? frame.agentName ?? frame.id,
              task: firstMessage.delegatedTask ?? firstMessage.content,
              context: firstMessage.delegatedContext,
              inputs: firstMessage.delegatedInputVersionIds ?? [],
              attempts: record.attempts.map((attempt) => ({
                ...attempt,
                resolvedAgent: { kind: 'main' as const },
                runtimeSegmentIds: [...attempt.runtimeSegmentIds]
              }))
            }
          ]
        }),
        messages: graph.messages
          .filter((message) => graph.frames.some((frame) => frame.id === message.agentFrameId))
          .map((message) => ({
            id: message.id,
            frameId: message.agentFrameId,
            role: message.role === 'agent' ? 'assistant' : 'user',
            content: message.content,
            createdAt: message.createdAt
          }))
      }
    }
  }
}

const assertAuthenticatedRootCaller = async (
  records: DelegatedWorkDurableRecords,
  caller: AuthenticatedDelegateCaller
): Promise<void> => {
  const snapshot = await records.snapshot()
  if (
    caller.role !== 'main' ||
    caller.frameId !== snapshot.rootFrameId ||
    !snapshot.originMessageIds.includes(caller.originMessageId)
  ) {
    throw new Error('Delegation caller is outside the authenticated active root conversation.')
  }
}

export { assertAuthenticatedRootCaller, createSessionDelegatedWorkRecords }
export type { SessionRecordAdapterOptions }
