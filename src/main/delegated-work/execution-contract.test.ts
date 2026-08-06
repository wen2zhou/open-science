import { describe, expect, it } from 'vitest'

import { createDeterministicDelegateExecution } from './deterministic-execution'
import type {
  DelegateExecution,
  DelegateExecutionEvent,
  DelegateExecutionInput
} from './execution-port'

type DelegateExecutionContractDriver = Readonly<{
  accept(attemptId: string): void
  emit(attemptId: string, event: DelegateExecutionEvent): void
  complete(attemptId: string, response: string): void
  fail(attemptId: string, error: Error): void
  deliveredMessages(attemptId: string): readonly string[]
}>

type DelegateExecutionContractHarness = Readonly<{
  execution: DelegateExecution
  driver: DelegateExecutionContractDriver
}>

const input = (attemptId: string): DelegateExecutionInput => ({
  frameId: `frame-${attemptId}`,
  attemptId,
  task: `task-${attemptId}`,
  inputs: [],
  continuation: false
})

const delegateExecutionContract = (create: () => DelegateExecutionContractHarness): void => {
  describe('delegate execution adapter contract', () => {
    it('exposes acceptance separately from terminal completion', async () => {
      const { execution, driver } = create()
      const reservation = await execution.reserve(1)
      const running = reservation.start(input('attempt-1'))
      let completed = false
      void running.completion.then(() => {
        completed = true
      })

      driver.accept('attempt-1')
      await expect(running.accepted).resolves.toBeUndefined()
      expect(completed).toBe(false)
      driver.complete('attempt-1', 'answer')
      await expect(running.completion).resolves.toEqual({ status: 'completed', response: 'answer' })
    })

    it('correlates events and message delivery to the running attempt', async () => {
      const { execution, driver } = create()
      const reservation = await execution.reserve(2)
      const first = reservation.start(input('attempt-1'))
      const second = reservation.start(input('attempt-2'))
      const firstEvents: DelegateExecutionEvent[] = []
      const secondEvents: DelegateExecutionEvent[] = []
      first.subscribe((event) => firstEvents.push(event))
      second.subscribe((event) => secondEvents.push(event))

      driver.emit('attempt-1', { kind: 'permission', awaiting: true })
      driver.emit('attempt-2', { kind: 'message', text: 'second only' })
      await first.sendMessage('first only')

      expect(firstEvents).toEqual([{ kind: 'permission', awaiting: true }])
      expect(secondEvents).toEqual([{ kind: 'message', text: 'second only' }])
      expect(driver.deliveredMessages('attempt-1')).toEqual(['first only'])
      expect(driver.deliveredMessages('attempt-2')).toEqual([])
      driver.accept('attempt-1')
      driver.accept('attempt-2')
      driver.complete('attempt-1', 'one')
      driver.complete('attempt-2', 'two')
      await Promise.all([first.completion, second.completion])
    })

    it('supports deterministic failure and cancellation terminalization', async () => {
      const { execution, driver } = create()
      const reservation = await execution.reserve(2)
      const failed = reservation.start(input('attempt-failed'))
      const cancelled = reservation.start(input('attempt-cancelled'))
      driver.accept('attempt-failed')
      driver.accept('attempt-cancelled')

      driver.fail('attempt-failed', new Error('provider failed'))
      await expect(failed.completion).rejects.toThrow('provider failed')
      await cancelled.cancel()
      await expect(cancelled.completion).resolves.toEqual({ status: 'cancelled' })
    })
  })
}

const createFakeHarness = (): DelegateExecutionContractHarness => {
  const execution = createDeterministicDelegateExecution()
  return {
    execution,
    driver: {
      accept: (attemptId) => execution.control(attemptId).accept(),
      emit: (attemptId, event) => execution.control(attemptId).emit(event),
      complete: (attemptId, response) => execution.control(attemptId).complete(response),
      fail: (attemptId, error) => execution.control(attemptId).fail(error),
      deliveredMessages: (attemptId) => execution.control(attemptId).deliveredMessages()
    }
  }
}

delegateExecutionContract(createFakeHarness)

export { delegateExecutionContract }
export type { DelegateExecutionContractDriver, DelegateExecutionContractHarness }
