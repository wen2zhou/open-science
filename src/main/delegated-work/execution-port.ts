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
  | Readonly<{ kind: 'message'; text: string }>
  | Readonly<{
      kind: 'permission'
      awaiting: true
      requestId: string
      title: string
      options: readonly Readonly<{ optionId: string; name: string; kind: string }>[]
    }>
  | Readonly<{ kind: 'permission'; awaiting: false; requestId: string }>

type DelegatePermissionResponse = Readonly<{
  requestId: string
  optionId?: string
  cancelled?: boolean
}>

type DelegateExecutionOutcome =
  Readonly<{ status: 'completed'; response: string }> | Readonly<{ status: 'cancelled' }>

type DelegateExecutionInput = Readonly<{
  session: Readonly<{ projectId: string; sessionId: string }>
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
  respondToPermission(response: DelegatePermissionResponse): Promise<void>
  cancel(): Promise<void>
}>

type DelegateCapacityReservation = Readonly<{
  slotIds: readonly string[]
  release(slotId: string): Promise<void>
  releaseAll(): Promise<void>
}>

type DelegateExecution = Readonly<{
  reserve(count: number): Promise<DelegateCapacityReservation>
  run(input: DelegateExecutionInput, slotId: string): RunningDelegateExecution
}>

export { DelegateExecutionError }
export type {
  DelegateCapacityReservation,
  DelegateExecution,
  DelegateExecutionErrorCode,
  DelegateExecutionEvent,
  DelegateExecutionInput,
  DelegateExecutionOutcome,
  DelegatePermissionResponse,
  RunningDelegateExecution
}
