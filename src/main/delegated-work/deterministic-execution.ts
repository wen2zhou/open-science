import {
  DelegateExecutionError,
  type DelegateCapacityReservation,
  type DelegateExecution,
  type DelegateExecutionErrorCode,
  type DelegateExecutionEvent,
  type DelegateExecutionInput,
  type DelegateExecutionOutcome,
  type RunningDelegateExecution
} from './execution-port'

type Deferred<Value> = Readonly<{
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}>

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

type ExecutionControl = Readonly<{
  input: DelegateExecutionInput
  accept(): void
  rejectAcceptance(error?: Error): void
  emit(event: DelegateExecutionEvent): void
  complete(response: string): void
  fail(error?: Error): void
  cancel(): void
  deliveredMessages(): readonly string[]
}>

type PlannedExecution =
  | Readonly<{ status: 'completed'; response: string; events?: readonly DelegateExecutionEvent[] }>
  | Readonly<{ status: 'failed'; error?: Error }>

type DeterministicDelegateExecution = DelegateExecution &
  Readonly<{
    plan(plan: PlannedExecution): void
    rejectNextReservation(code: DelegateExecutionErrorCode, message?: string): void
    controls(): readonly ExecutionControl[]
    control(attemptId: string): ExecutionControl
    releasedFrames(): readonly string[]
    reservationCounts(): readonly number[]
  }>

const createDeterministicDelegateExecution = (): DeterministicDelegateExecution => {
  const running: ExecutionControl[] = []
  const plans: PlannedExecution[] = []
  const released: string[] = []
  const reservationCounts: number[] = []
  let reservationFailure: DelegateExecutionError | undefined

  return {
    plan(plan) {
      plans.push(plan)
    },
    rejectNextReservation(code, message = code) {
      reservationFailure = new DelegateExecutionError(code, message)
    },
    controls: () => running,
    control(attemptId) {
      const control = running.find((candidate) => candidate.input.attemptId === attemptId)
      if (!control) throw new Error(`unknown deterministic execution: ${attemptId}`)
      return control
    },
    releasedFrames: () => released,
    reservationCounts: () => reservationCounts,
    async reserve(count): Promise<DelegateCapacityReservation> {
      reservationCounts.push(count)
      if (reservationFailure) {
        const error = reservationFailure
        reservationFailure = undefined
        throw error
      }
      let releasedAll = false
      return {
        start(input): RunningDelegateExecution {
          const acceptance = deferred<void>()
          const completion = deferred<DelegateExecutionOutcome>()
          const listeners = new Set<(event: DelegateExecutionEvent) => void>()
          const messages: string[] = []
          let terminal = false
          const control: ExecutionControl = {
            input,
            accept: () => acceptance.resolve(),
            rejectAcceptance: (error = new Error('acceptance failed')) => acceptance.reject(error),
            emit: (event) => {
              for (const listener of listeners) listener(event)
            },
            complete: (response) => {
              if (terminal) return
              terminal = true
              completion.resolve({ status: 'completed', response })
            },
            fail: (error = new Error('execution failed')) => {
              if (terminal) return
              terminal = true
              completion.reject(error)
            },
            cancel: () => {
              if (terminal) return
              terminal = true
              completion.resolve({ status: 'cancelled' })
            },
            deliveredMessages: () => messages
          }
          running.push(control)
          const planned = plans.shift()
          if (planned) {
            queueMicrotask(() => {
              control.accept()
              if (planned.status === 'completed') {
                for (const event of planned.events ?? []) control.emit(event)
                control.complete(planned.response)
              } else {
                control.fail(planned.error)
              }
            })
          }
          return {
            accepted: acceptance.promise,
            completion: completion.promise,
            subscribe(listener) {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            async sendMessage(message) {
              messages.push(message)
            },
            async cancel() {
              control.cancel()
            }
          }
        },
        async release(frameId) {
          released.push(frameId)
        },
        async releaseAll() {
          if (releasedAll) return
          releasedAll = true
        }
      }
    }
  }
}

export { createDeterministicDelegateExecution }
export type { DeterministicDelegateExecution, ExecutionControl, PlannedExecution }
