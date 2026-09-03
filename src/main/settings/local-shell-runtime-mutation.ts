import type { LocalShellRuntimePreference } from '../../shared/wsl-setup'

type LocalShellRuntimeMutation = Readonly<{
  revision: number
  runtime: LocalShellRuntimePreference
  previous: LocalShellRuntimePreference | undefined
}>

export type { LocalShellRuntimeMutation }
