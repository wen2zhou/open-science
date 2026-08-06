import { randomUUID } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { SessionRuntimeContextRevisionConflictError } from '../session-persistence/coordinator'
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
  let mutationTail: Promise<void> = Promise.resolve()
  const mutate = <Result>(
    operation: (expectedRevision: number) => Promise<Result>
  ): Promise<Result> => {
    const pending = mutationTail.then(async () => {
      for (let retries = 0; ; retries += 1) {
        try {
          return await operation(await revision())
        } catch (error) {
          if (!(error instanceof SessionRuntimeContextRevisionConflictError) || retries >= 2) {
            throw error
          }
        }
      }
    })
    mutationTail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  return {
    async admitChildren(input) {
      await mutate((expectedRevision) =>
        options.commands.createChildren(key, {
          expectedRevision,
          parentFrameId: input.caller.frameId,
          originMessageId: input.caller.originMessageId,
          children: input.children.map((child) => ({
            frameId: child.frameId,
            branchId: createId('branch'),
            messageId: child.userMessageId,
            attemptId: child.attemptId,
            task: child.request.task,
            name: child.title,
            context: child.request.context,
            inputs: child.request.inputs,
            resolvedAgent: child.resolvedAgent,
            startedAt: child.startedAt
          }))
        })
      )
    },
    async continueChild(input) {
      await mutate((expectedRevision) =>
        options.commands.startContinuationAttempt(key, {
          expectedRevision,
          frameId: input.frameId,
          previousAttemptId: input.previousAttemptId,
          attemptId: input.attemptId,
          messageId: input.userMessageId,
          message: input.message,
          resolvedAgent: input.resolvedAgent,
          startedAt: input.startedAt
        })
      )
    },
    async startRuntime(frameId, attemptId, runtimeSegmentId) {
      const attempt = (await load()).runtimeContext?.delegatedWork?.records
        .find((record) => record.agentFrameId === frameId)
        ?.attempts.find((candidate) => candidate.id === attemptId)
      await mutate((expectedRevision) =>
        options.commands.startAttemptRuntime(key, {
          expectedRevision,
          frameId,
          attemptId,
          runtimeSegmentId,
          frameworkId: options.frameworkId,
          ...(attempt?.resolvedAgent.kind === 'specialist'
            ? { agentName: attempt.resolvedAgent.displayName }
            : {}),
          startedAt: Date.now()
        })
      )
    },
    async terminalize(input) {
      if (input.status === 'completed') {
        const attempt = (await load()).runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === input.frameId)
          ?.attempts.find((candidate) => candidate.id === input.attemptId)
        await mutate((expectedRevision) =>
          options.commands.applyAgentEvent(key, {
            expectedRevision,
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
        )
      }
      await mutate((expectedRevision) =>
        options.commands.transitionAttempt(key, {
          expectedRevision,
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
      )
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
                resolvedAgent: structuredClone(attempt.resolvedAgent),
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
