import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type {
  DelegatedWorkDurableRecords,
  DurableMessage,
  DurablePendingMessage,
  DurableSnapshot
} from './durable-delegated-work'

type SessionKey = DurableSnapshot['session']
type DurableChild = DurableSnapshot['records'][number]
type DurableAttempt = DurableChild['attempts'][number]

const createInMemoryDelegatedWorkRecords = (input: {
  session: SessionKey
  rootFrameId: string
  originMessageId: string
}): DelegatedWorkDurableRecords => {
  const state: {
    session: SessionKey
    rootFrameId: string
    originMessageIds: string[]
    records: DurableChild[]
    messages: DurableMessage[]
  } = {
    session: { ...input.session },
    rootFrameId: input.rootFrameId,
    originMessageIds: [input.originMessageId],
    records: [],
    messages: []
  }
  const findRunning = (frameId: string, attemptId: string): DurableAttempt => {
    const child = state.records.find((candidate) => candidate.frameId === frameId)
    const attempt = child && currentAttempt(child)
    if (!attempt || attempt.id !== attemptId || attempt.status !== 'running') {
      throw new Error('Delegated Attempt is not current and running.')
    }
    return attempt
  }
  return {
    async admitChildren(admission) {
      if (
        !sameSession(state.session, admission.caller.session) ||
        admission.caller.frameId !== state.rootFrameId ||
        !state.originMessageIds.includes(admission.caller.originMessageId)
      ) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'delegation caller or origin Message is outside the active root conversation'
        )
      }
      if (admission.children.length === 0) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation requires one or more children'
        )
      }
      const frameIds = admission.children.map((child) => child.frameId)
      const attemptIds = admission.children.map((child) => child.attemptId)
      const messageIds = admission.children.map((child) => child.userMessageId)
      if (
        new Set(frameIds).size !== frameIds.length ||
        new Set(attemptIds).size !== attemptIds.length ||
        new Set(messageIds).size !== messageIds.length ||
        state.records.some((child) => frameIds.includes(child.frameId)) ||
        state.records.some((child) =>
          child.attempts.some((attempt) => attemptIds.includes(attempt.id))
        ) ||
        state.messages.some((message) => messageIds.includes(message.id))
      ) {
        throw new Error('Duplicate delegated-work identity.')
      }
      state.records.push(
        ...admission.children.map((child) => ({
          frameId: child.frameId,
          parentFrameId: admission.caller.frameId,
          originMessageId: admission.caller.originMessageId,
          originBindingState: 'validated' as const,
          title: child.title,
          task: child.request.task,
          context: child.request.context,
          inputs: [...(child.request.inputs ?? [])],
          messageBranchId: `branch-${child.frameId}`,
          attempts: [
            {
              id: child.attemptId,
              status: 'running' as const,
              resolvedAgent: structuredClone(child.resolvedAgent),
              runtimeSegmentIds: [],
              startedAt: child.startedAt
            }
          ],
          pendingMessages: []
        }))
      )
      state.messages.push(
        ...admission.children.map((child) => ({
          id: child.userMessageId,
          frameId: child.frameId,
          role: 'user' as const,
          content: child.request.context
            ? `${child.request.task}\n\nContext:\n${child.request.context}`
            : child.request.task,
          createdAt: child.startedAt
        }))
      )
    },
    async continueChild(input) {
      const child = state.records.find((candidate) => candidate.frameId === input.frameId)
      const previous = child && currentAttempt(child)
      if (
        !child ||
        !previous ||
        previous.id !== input.previousAttemptId ||
        previous.status === 'running'
      ) {
        throw new DurableDelegatedWorkError(
          'conflict',
          `child ${input.frameId} is not at the expected terminal Attempt`
        )
      }
      if (
        state.records.some((record) =>
          record.attempts.some((attempt) => attempt.id === input.attemptId)
        ) ||
        state.messages.some((message) => message.id === input.userMessageId)
      ) {
        throw new Error('Duplicate continuation identity.')
      }
      child.attempts.push({
        id: input.attemptId,
        status: 'running',
        resolvedAgent: structuredClone(input.resolvedAgent),
        runtimeSegmentIds: [],
        startedAt: input.startedAt
      })
      state.messages.push({
        id: input.userMessageId,
        frameId: input.frameId,
        role: 'user',
        content: input.message,
        createdAt: input.startedAt
      })
    },
    async startRuntime(frameId, attemptId, runtimeSegmentId) {
      findRunning(frameId, attemptId).runtimeSegmentIds.push(runtimeSegmentId)
      const child = state.records.find((candidate) => candidate.frameId === frameId)!
      const promptMessage = [...state.messages]
        .reverse()
        .find((message) => message.frameId === frameId && message.role === 'user')
      if (!promptMessage) throw new Error('Delegated Attempt has no prompt Message.')
      promptMessage.runtimeSegmentId = runtimeSegmentId
      return {
        rootFrameId: state.rootFrameId,
        messageBranchId: child.messageBranchId,
        promptMessageId: promptMessage.id,
        runtimeSegmentId
      }
    },
    async stageTerminalMessage(frameId, attemptId, message) {
      findRunning(frameId, attemptId)
      if (message.frameId !== frameId || message.role !== 'assistant') {
        throw new Error('Terminal Message does not belong to the delegated Attempt.')
      }
      const existing = state.messages.find((candidate) => candidate.id === message.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(message)) {
        throw new Error('Terminal Message identity is already in use.')
      }
      if (!existing) state.messages.push({ ...message })
    },
    async terminalize(terminal) {
      const attempt = findRunning(terminal.frameId, terminal.attemptId)
      attempt.status = terminal.status
      attempt.endedAt = terminal.endedAt
      if (terminal.status === 'completed') {
        if (!state.messages.some((message) => message.id === terminal.terminalMessage.id)) {
          state.messages.push({ ...terminal.terminalMessage })
        }
        attempt.terminalMessageId = terminal.terminalMessage.id
      } else if (terminal.status === 'cancelled') {
        attempt.cancellationReason = terminal.cancellationReason
      } else {
        attempt.error = { ...terminal.error }
      }
    },
    async appendPendingMessage(frameId, attemptId, message: DurablePendingMessage) {
      const child = state.records.find((candidate) => candidate.frameId === frameId)
      const attempt = child && currentAttempt(child)
      if (!child || !attempt || attempt.id !== attemptId || attempt.status !== 'running') {
        throw new DurableDelegatedWorkError(
          'conflict',
          'Pending Message Attempt is not current and running.'
        )
      }
      if (
        state.records.some((record) => record.pendingMessages.some(({ id }) => id === message.id))
      ) {
        throw new Error(`Pending Message already exists: ${message.id}`)
      }
      child.pendingMessages.push(structuredClone(message))
    },
    async markMessageDelivered(frameId, attemptId, messageId, deliveredAt) {
      const child = state.records.find((candidate) => candidate.frameId === frameId)
      const attempt = child && currentAttempt(child)
      if (!child || !attempt || attempt.id !== attemptId || attempt.status !== 'running') {
        throw new DurableDelegatedWorkError(
          'conflict',
          'Pending Message Attempt is not current and running.'
        )
      }
      const index = child.pendingMessages.findIndex(({ id }) => id === messageId)
      const message = child.pendingMessages[index]
      if (!message) throw new Error(`Pending Message not found: ${messageId}`)
      if (message.deliveredAt !== undefined) return
      child.pendingMessages[index] = { ...message, deliveredAt }
    },
    async startPendingTurn(
      frameId,
      attemptId,
      pendingMessageId,
      promptMessageId,
      runtimeSegmentId
    ) {
      findRunning(frameId, attemptId).runtimeSegmentIds.push(runtimeSegmentId)
      const child = state.records.find((candidate) => candidate.frameId === frameId)!
      const pending = child.pendingMessages.find(({ id }) => id === pendingMessageId)
      if (!pending?.callerSource) {
        throw new Error('Pending child Turn has no authenticated Main caller source.')
      }
      state.messages.push({
        id: promptMessageId,
        frameId,
        role: 'user',
        content: pending.text,
        createdAt: pending.createdAt
      })
      return {
        rootFrameId: state.rootFrameId,
        messageBranchId: child.messageBranchId,
        promptMessageId,
        runtimeSegmentId
      }
    },
    async completeTurn(frameId, attemptId, runtimeSegmentId) {
      const attempt = findRunning(frameId, attemptId)
      if (!attempt.runtimeSegmentIds.includes(runtimeSegmentId)) {
        throw new Error('Child Turn Runtime Segment is outside the Attempt.')
      }
    },
    snapshot: async () => structuredClone(state)
  }
}

export { createInMemoryDelegatedWorkRecords }
