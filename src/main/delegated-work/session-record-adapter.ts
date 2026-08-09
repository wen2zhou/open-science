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
  onRecordsChanged?: () => void
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
          const result = await operation(await revision())
          try {
            options.onRecordsChanged?.()
          } catch {
            // The mutation is already durable. Projection notification failures must not make the
            // caller observe a false write failure or retry the committed operation.
          }
          return result
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
            startedAt: child.startedAt,
            callerSource: {
              rootMessageId: input.caller.originMessageId,
              toolInvocationId: input.caller.toolInvocationId
            },
            initiatingTurnMessageId: input.caller.originMessageId
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
          startedAt: input.startedAt,
          callerSource: input.callerSource,
          initiatingTurnMessageId: input.initiatingTurnMessageId
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
          startedAt: attempt?.startedAt ?? Date.now()
        })
      )
      const session = await load()
      const graph = materializeSessionConversationGraph(session).conversationGraph
      const frame = graph?.frames.find((candidate) => candidate.id === frameId)
      const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)
      const promptMessage = graph?.messages.find(
        (message) => message.id === branch?.headMessageId && message.role === 'user'
      )
      if (!graph || !frame || !branch || !promptMessage) {
        throw new Error('Delegated runtime has no current Frame, Branch, or prompt Message.')
      }
      return {
        rootFrameId: graph.rootFrameId,
        messageBranchId: branch.id,
        promptMessageId: promptMessage.id,
        runtimeSegmentId
      }
    },
    async stageTerminalMessage(frameId, attemptId, message) {
      const attempt = (await load()).runtimeContext?.delegatedWork?.records
        .find((record) => record.agentFrameId === frameId)
        ?.attempts.find((candidate) => candidate.id === attemptId)
      await mutate((expectedRevision) =>
        options.commands.applyAgentEvent(key, {
          expectedRevision,
          frameId,
          attemptId,
          event: {
            kind: 'message',
            runtimeSegmentId: attempt?.runtimeSegmentIds.at(-1) ?? '',
            message: {
              id: message.id,
              role: 'agent',
              content: message.content,
              responseToMessageId: message.responseToMessageId,
              status: message.status ?? 'complete',
              eventIds: [...(message.eventIds ?? [])],
              images: message.images?.map((image) => ({ ...image })),
              turnUsage: message.turnUsage ? { ...message.turnUsage } : undefined,
              turnUsageUnavailable: message.turnUsageUnavailable,
              createdAt: message.createdAt,
              completedAt: message.completedAt ?? message.updatedAt ?? message.createdAt,
              updatedAt: message.updatedAt ?? message.createdAt
            }
          }
        })
      )
    },
    async stageTerminalActivities(
      frameId,
      attemptId,
      runtimeSegmentId,
      activities,
      activityGroups
    ) {
      for (const activity of activities) {
        if (!activity.promptMessageId) continue
        await mutate((expectedRevision) =>
          options.commands.applyAgentEvent(key, {
            expectedRevision,
            frameId,
            attemptId,
            event: {
              kind: 'activity',
              runtimeSegmentId,
              promptMessageId: activity.promptMessageId!,
              activity
            }
          })
        )
      }
      for (const activityGroup of activityGroups) {
        if (!activityGroup.promptMessageId) continue
        await mutate((expectedRevision) =>
          options.commands.applyAgentEvent(key, {
            expectedRevision,
            frameId,
            attemptId,
            event: {
              kind: 'activity-group',
              promptMessageId: activityGroup.promptMessageId!,
              activityGroup
            }
          })
        )
      }
    },
    async terminalize(input) {
      if (input.status === 'completed') {
        const session = await load()
        const messageExists = session.conversationGraph?.messages.some(
          (message) => message.id === input.terminalMessage.id
        )
        const attempt = session.runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === input.frameId)
          ?.attempts.find((candidate) => candidate.id === input.attemptId)
        if (!messageExists) {
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
                  responseToMessageId: input.terminalMessage.responseToMessageId,
                  status: input.terminalMessage.status ?? 'complete',
                  eventIds: [...(input.terminalMessage.eventIds ?? [])],
                  images: input.terminalMessage.images?.map((image) => ({ ...image })),
                  turnUsage: input.terminalMessage.turnUsage
                    ? { ...input.terminalMessage.turnUsage }
                    : undefined,
                  turnUsageUnavailable: input.terminalMessage.turnUsageUnavailable,
                  createdAt: input.terminalMessage.createdAt,
                  completedAt:
                    input.terminalMessage.completedAt ??
                    input.terminalMessage.updatedAt ??
                    input.terminalMessage.createdAt,
                  updatedAt: input.terminalMessage.updatedAt ?? input.terminalMessage.createdAt
                }
              }
            })
          )
        }
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
    async appendPendingMessage(frameId, attemptId, message) {
      await mutate((expectedRevision) =>
        options.commands.appendPendingMessage(key, {
          expectedRevision,
          frameId,
          attemptId,
          message
        })
      )
    },
    async markMessageDelivered(frameId, attemptId, messageId, deliveredAt) {
      await mutate((expectedRevision) =>
        options.commands.markMessageDelivered(key, {
          expectedRevision,
          frameId,
          attemptId,
          messageId,
          deliveredAt
        })
      )
    },
    async startPendingTurn(
      frameId,
      attemptId,
      pendingMessageId,
      promptMessageId,
      runtimeSegmentId
    ) {
      const pending = (await load()).runtimeContext?.delegatedWork?.records
        .find((record) => record.agentFrameId === frameId)
        ?.pendingMessages.find(({ id }) => id === pendingMessageId)
      await mutate((expectedRevision) =>
        options.commands.startPendingMessageTurn(key, {
          expectedRevision,
          frameId,
          attemptId,
          pendingMessageId,
          promptMessageId,
          runtimeSegmentId,
          frameworkId: options.frameworkId,
          startedAt: pending?.createdAt ?? Date.now()
        })
      )
      const session = await load()
      const graph = materializeSessionConversationGraph(session).conversationGraph
      const frame = graph?.frames.find(({ id }) => id === frameId)
      const branch = graph?.branches.find(({ id }) => id === frame?.activeBranchId)
      if (!graph || !frame || !branch) throw new Error('Pending child Turn is not durable.')
      return {
        rootFrameId: graph.rootFrameId,
        messageBranchId: branch.id,
        promptMessageId,
        runtimeSegmentId
      }
    },
    async completeTurn(frameId, attemptId, runtimeSegmentId, endedAt) {
      await mutate((expectedRevision) =>
        options.commands.completeChildTurn(key, {
          expectedRevision,
          frameId,
          attemptId,
          runtimeSegmentId,
          endedAt
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
              originBindingState:
                frame.originBindingState === 'validated' ? 'validated' : 'legacy-unavailable',
              title: frame.delegateName ?? frame.agentName ?? frame.id,
              task: firstMessage.delegatedTask ?? firstMessage.content,
              context: firstMessage.delegatedContext,
              inputs: firstMessage.delegatedInputVersionIds ?? [],
              messageBranchId: frame.activeBranchId,
              attempts: record.attempts.map((attempt) => ({
                ...attempt,
                resolvedAgent: structuredClone(attempt.resolvedAgent),
                runtimeSegmentIds: [...attempt.runtimeSegmentIds]
              })),
              pendingMessages: record.pendingMessages.map((message) => ({ ...message }))
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
            responseToMessageId: message.responseToMessageId,
            runtimeSegmentId: message.runtimeSegmentId,
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
