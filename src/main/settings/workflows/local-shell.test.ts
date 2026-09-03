import { describe, expect, it, vi } from 'vitest'

import { LocalShellSettingsWorkflows } from './local-shell'

describe('LocalShellSettingsWorkflows', () => {
  it('persists PowerShell and waits for every live Session capability to refresh', async () => {
    const actions: string[] = []
    let finishRefresh!: () => void
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const result = {
      runtimeBinding: { kind: 'powershell' as const, version: '5.1' as const },
      appliesTo: 'subsequent-executions' as const,
      wslProfilePreserved: true
    }
    const settings = {
      getLocalShellRuntimePreference: vi.fn(async () => 'wsl2-bash' as const),
      switchLocalShellToPowerShell: vi.fn(async () => {
        actions.push('persist')
        return result
      }),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn()
    }
    const requestShellRuntimeRefresh = vi.fn(async () => {
      actions.push('refresh')
      await refresh
    })
    const workflows = new LocalShellSettingsWorkflows(settings, {
      requestShellRuntimeRefresh
    })

    let settled = false
    const switching = workflows.switchToPowerShell().finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(requestShellRuntimeRefresh).toHaveBeenCalledOnce())

    expect(actions).toEqual(['persist', 'refresh'])
    expect(settled).toBe(false)

    finishRefresh()
    await expect(switching).resolves.toBe(result)
  })

  it('does not refresh capabilities when the preference cannot be saved', async () => {
    const failure = new Error('disk full')
    const requestShellRuntimeRefresh = vi.fn()
    const workflows = new LocalShellSettingsWorkflows(
      {
        getLocalShellRuntimePreference: vi.fn(async () => 'wsl2-bash' as const),
        switchLocalShellToPowerShell: vi.fn(async () => {
          throw failure
        }),
        useWsl2Bash: vi.fn(),
        restoreLocalShellRuntimePreference: vi.fn()
      },
      { requestShellRuntimeRefresh: async () => requestShellRuntimeRefresh() }
    )

    await expect(workflows.switchToPowerShell()).rejects.toBe(failure)
    expect(requestShellRuntimeRefresh).not.toHaveBeenCalled()
  })

  it('enables only the service-validated WSL2 profile and refreshes subsequent capabilities', async () => {
    const result = {
      runtime: 'wsl2-bash' as const,
      selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
      appliesTo: 'subsequent-executions' as const
    }
    const settings = {
      getLocalShellRuntimePreference: vi.fn(async () => 'powershell' as const),
      switchLocalShellToPowerShell: vi.fn(),
      useWsl2Bash: vi.fn(async () => result),
      restoreLocalShellRuntimePreference: vi.fn()
    }
    const requestShellRuntimeRefresh = vi.fn(async () => undefined)
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

    await expect(workflows.useWsl2Bash()).resolves.toBe(result)

    expect(settings.useWsl2Bash).toHaveBeenCalledOnce()
    expect(requestShellRuntimeRefresh).toHaveBeenCalledOnce()
  })

  it('rolls back the persisted preference when capability refresh fails', async () => {
    const refreshFailure = new Error('refresh failed')
    const settings = {
      getLocalShellRuntimePreference: vi.fn(async () => 'wsl2-bash' as const),
      switchLocalShellToPowerShell: vi.fn(async () => ({
        runtimeBinding: { kind: 'powershell' as const, version: '5.1' as const },
        appliesTo: 'subsequent-executions' as const,
        wslProfilePreserved: true
      })),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn(async () => true)
    }
    const workflows = new LocalShellSettingsWorkflows(settings, {
      requestShellRuntimeRefresh: vi.fn(async () => {
        throw refreshFailure
      })
    })

    await expect(workflows.switchToPowerShell()).rejects.toBe(refreshFailure)
    expect(settings.restoreLocalShellRuntimePreference).toHaveBeenCalledWith(
      'powershell',
      'wsl2-bash'
    )
  })
})
