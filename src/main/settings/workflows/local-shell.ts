import type {
  LocalShellRuntimePreference,
  SwitchToPowerShellResult,
  UseWsl2BashResult
} from '../../../shared/wsl-setup'

type LocalShellSettingsWorkflowStore = {
  getLocalShellRuntimePreference(): Promise<LocalShellRuntimePreference | undefined>
  switchLocalShellToPowerShell(): Promise<SwitchToPowerShellResult>
  useWsl2Bash(): Promise<UseWsl2BashResult>
  restoreLocalShellRuntimePreference(
    expected: LocalShellRuntimePreference,
    previous: LocalShellRuntimePreference | undefined
  ): Promise<boolean>
}

type LocalShellSettingsWorkflowEffects = {
  requestShellRuntimeRefresh: () => Promise<void>
}

// Owns the persistence-before-refresh boundary for Shell backend changes. Global generation
// invalidation stops new work from observing the old binding while existing admitted work drains;
// a failed invalidation conditionally restores the preference that was current before this action.
class LocalShellSettingsWorkflows {
  constructor(
    private readonly settings: LocalShellSettingsWorkflowStore,
    private readonly effects: LocalShellSettingsWorkflowEffects
  ) {}

  async switchToPowerShell(): Promise<SwitchToPowerShellResult> {
    return this.switchRuntime('powershell', () => this.settings.switchLocalShellToPowerShell())
  }

  async useWsl2Bash(): Promise<UseWsl2BashResult> {
    return this.switchRuntime('wsl2-bash', () => this.settings.useWsl2Bash())
  }

  private async switchRuntime<Result>(
    runtime: LocalShellRuntimePreference,
    persist: () => Promise<Result>
  ): Promise<Result> {
    const previous = await this.settings.getLocalShellRuntimePreference()
    const result = await persist()
    try {
      await this.effects.requestShellRuntimeRefresh()
      return result
    } catch (error) {
      try {
        await this.settings.restoreLocalShellRuntimePreference(runtime, previous)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Shell capability refresh failed and the saved preference could not be restored.'
        )
      }
      throw error
    }
  }
}

export { LocalShellSettingsWorkflows }
export type { LocalShellSettingsWorkflowEffects, LocalShellSettingsWorkflowStore }
