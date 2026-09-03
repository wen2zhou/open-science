import { describe, expect, it, vi } from 'vitest'

import { LocalShellSettingsWorkflows } from './local-shell'

describe('LocalShellSettingsWorkflows', () => {
  it('persists PowerShell before refreshing future Session capabilities', async () => {
    const actions: string[] = []
    const result = {
      runtimeBinding: { kind: 'powershell' as const, version: '5.1' as const },
      appliesTo: 'subsequent-executions' as const,
      wslProfilePreserved: true
    }
    const settings = {
      switchLocalShellToPowerShell: vi.fn(async () => {
        actions.push('persist')
        return result
      })
    }
    const requestShellRuntimeRefresh = vi.fn(() => actions.push('refresh'))
    const workflows = new LocalShellSettingsWorkflows(settings, {
      requestShellRuntimeRefresh
    })

    await expect(workflows.switchToPowerShell()).resolves.toBe(result)

    expect(actions).toEqual(['persist', 'refresh'])
    expect(requestShellRuntimeRefresh).toHaveBeenCalledOnce()
  })

  it('does not refresh capabilities when the preference cannot be saved', async () => {
    const failure = new Error('disk full')
    const requestShellRuntimeRefresh = vi.fn()
    const workflows = new LocalShellSettingsWorkflows(
      {
        switchLocalShellToPowerShell: vi.fn(async () => {
          throw failure
        })
      },
      { requestShellRuntimeRefresh }
    )

    await expect(workflows.switchToPowerShell()).rejects.toBe(failure)
    expect(requestShellRuntimeRefresh).not.toHaveBeenCalled()
  })
})
