export type WslSetupState =
  | 'checking'
  | 'not-installed'
  | 'restart-required'
  | 'distro-required'
  | 'first-launch-required'
  | 'dependency-required'
  | 'ready'
  | 'failed'

export type WslDistro = Readonly<{
  name: string
  version: 1 | 2
  isDefault: boolean
}>

export type WslSelection = Readonly<{
  distro: string
  user: string
}>

export type WslReadiness = Readonly<{
  wsl2?: boolean
  bash?: boolean
  bwrap?: boolean
  namespaces?: boolean
  localWorkspace?: boolean
}>

export type WslSetupSnapshot = Readonly<{
  state: WslSetupState
  distros: readonly WslDistro[]
  selection?: WslSelection
  readiness?: WslReadiness
  errorCode?: string
  operationReference: string
}>

export type SelectWslProfileRequest = Readonly<{
  distro: string
  user: string
}>
