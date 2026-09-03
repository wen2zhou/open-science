export type NotebookSandboxTarget =
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'wsl2'
      profileId: string
      distro: string
      user: string
    }>

export type NotebookSandboxCleanupReason = 'exit' | 'cancel' | 'timeout' | 'spawn-failed'

export type NotebookSandboxCleanupResult = Readonly<{
  processesTerminated: boolean
  networkClosed: boolean
  temporaryResourcesRemoved: boolean
}>

export type NotebookSandboxProcessOutcome = Readonly<{
  processesTerminated: boolean
}>

export type NotebookSandboxInvocation = Readonly<{
  target?: NotebookSandboxTarget
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  pathEnvironment?: NodeJS.ProcessEnv
  cwd: string
  commandText: string
  executionReference?: string
  sessionId: string
  projectId: string
  runtime: 'python' | 'r' | 'repl' | 'bash'
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  filesystem: Readonly<{
    readOnlyRoots: readonly string[]
    readWriteRoots: readonly string[]
    deniedReadRoots: readonly string[]
    deniedWriteRoots: readonly string[]
  }>
  signal?: AbortSignal
}>

export type NotebookSandboxedSpawn = Readonly<{
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  beginExecution?: () => () => void
  annotateStderr: (stderr: string) => string
  cleanup: (
    reason: NotebookSandboxCleanupReason,
    processOutcome: NotebookSandboxProcessOutcome
  ) => Promise<NotebookSandboxCleanupResult>
}>

export type NotebookNetworkAccessDecisionRequest = Readonly<{
  sessionId: string
  projectId: string
  hostname: string
  reason: string
  runtime?: NotebookSandboxInvocation['runtime']
  command?: string
  signal?: AbortSignal
}>

export type NotebookNetworkAccessDecisionResult = Readonly<{
  hostname: string
  status: 'alreadyAllowed' | 'allowedOnce' | 'alwaysAllowed' | 'denied' | 'blocked' | 'unavailable'
}>

export interface NotebookProcessSandbox {
  wrap(invocation: NotebookSandboxInvocation): Promise<NotebookSandboxedSpawn>
  requestNetworkAccess?(
    request: NotebookNetworkAccessDecisionRequest
  ): Promise<NotebookNetworkAccessDecisionResult>
}
