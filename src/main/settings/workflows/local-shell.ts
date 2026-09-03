import type { SwitchToPowerShellResult } from '../../../shared/wsl-setup'

type LocalShellSettingsWorkflowStore = {
  switchLocalShellToPowerShell(): Promise<SwitchToPowerShellResult>
}

type LocalShellSettingsWorkflowEffects = {
  requestShellRuntimeRefresh: () => void
}

// Owns the persistence-before-refresh boundary for Shell backend changes. Runtime refresh uses the
// existing deferred reconnect semantics, so admitted work finishes against its captured binding and
// only later Session capabilities observe the new preference.
class LocalShellSettingsWorkflows {
  constructor(
    private readonly settings: LocalShellSettingsWorkflowStore,
    private readonly effects: LocalShellSettingsWorkflowEffects
  ) {}

  async switchToPowerShell(): Promise<SwitchToPowerShellResult> {
    const result = await this.settings.switchLocalShellToPowerShell()
    this.effects.requestShellRuntimeRefresh()
    return result
  }
}

export { LocalShellSettingsWorkflows }
export type { LocalShellSettingsWorkflowEffects, LocalShellSettingsWorkflowStore }
