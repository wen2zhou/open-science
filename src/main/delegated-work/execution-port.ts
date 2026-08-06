type DelegateExecutionErrorCode = 'capacity' | 'unsupported_framework'

class DelegateExecutionError extends Error {
  constructor(
    readonly code: DelegateExecutionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DelegateExecutionError'
  }
}

type DelegateExecutionEvent =
  Readonly<{ kind: 'message'; text: string }> | Readonly<{ kind: 'permission'; awaiting: boolean }>

type DelegateExecutionOutcome =
  Readonly<{ status: 'completed'; response: string }> | Readonly<{ status: 'cancelled' }>

type DelegateExecutionInput = Readonly<{
  frameId: string
  attemptId: string
  task: string
  context?: string
  inputs: readonly string[]
  profile?: string
  continuation: boolean
}>

type RunningDelegateExecution = Readonly<{
  accepted: Promise<void>
  completion: Promise<DelegateExecutionOutcome>
  subscribe(listener: (event: DelegateExecutionEvent) => void): () => void
  sendMessage(message: string): Promise<void>
  cancel(): Promise<void>
}>

type DelegateCapacityReservation = Readonly<{
  start(input: DelegateExecutionInput): RunningDelegateExecution
  release(frameId: string): Promise<void>
  releaseAll(): Promise<void>
}>

type DelegateExecution = Readonly<{
  reserve(count: number): Promise<DelegateCapacityReservation>
}>

export { DelegateExecutionError }
export type {
  DelegateCapacityReservation,
  DelegateExecution,
  DelegateExecutionErrorCode,
  DelegateExecutionEvent,
  DelegateExecutionInput,
  DelegateExecutionOutcome,
  RunningDelegateExecution
}
