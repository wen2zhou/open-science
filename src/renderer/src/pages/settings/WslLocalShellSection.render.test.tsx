// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WslLocalShellSection } from './WslLocalShellSection'

let container: HTMLDivElement
let root: Root
let probe: ReturnType<typeof vi.fn>
let select: ReturnType<typeof vi.fn>
let install: ReturnType<typeof vi.fn>
let installRecommended: ReturnType<typeof vi.fn>
let openTerminal: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {})
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  probe = vi.fn().mockResolvedValue({
    state: 'distro-required',
    distros: [
      { name: 'Legacy', version: 1, isDefault: false },
      { name: 'Ubuntu-24.04', version: 2, isDefault: true }
    ],
    operationReference: 'deadbeef'
  })
  select = vi.fn().mockResolvedValue({
    state: 'ready',
    distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
    readiness: { wsl2: true, bash: true, bwrap: true, namespaces: true, localWorkspace: true },
    operationReference: '1234abcd'
  })
  install = vi.fn().mockResolvedValue({
    outcome: 'uac-cancelled',
    operationReference: 'feedface',
    snapshot: {
      state: 'not-installed',
      distros: [],
      errorCode: 'wsl_install_uac_cancelled',
      operationReference: 'feedface'
    }
  })
  installRecommended = vi.fn().mockResolvedValue({
    state: 'first-launch-required',
    distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
    errorCode: 'wsl_first_launch_required',
    operationReference: 'feedface'
  })
  openTerminal = vi.fn().mockResolvedValue({
    state: 'first-launch-required',
    distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
    selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
    errorCode: 'wsl_first_launch_required',
    operationReference: 'feedface'
  })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      probeWslSetup: probe,
      selectWslProfile: select,
      installWslPlatform: install,
      installRecommendedWslDistro: installRecommended,
      openWslTerminal: openTerminal
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('WslLocalShellSection', () => {
  it('requires a user click to install and never replays after UAC cancellation', async () => {
    probe.mockResolvedValue({
      state: 'not-installed',
      distros: [],
      errorCode: 'wsl_not_installed',
      operationReference: 'deadbeef'
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(install).not.toHaveBeenCalled()
    const installButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install WSL2')
    )
    await act(async () => installButton?.click())
    await flush()

    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('installation was cancelled')
    expect(container.textContent).toContain('wsl_install_uac_cancelled · feedface')
    expect(container.textContent).toContain('keep using PowerShell')
  })

  it('starts a fresh probe when Settings is reopened instead of retaining install success', async () => {
    probe
      .mockResolvedValueOnce({
        state: 'not-installed',
        distros: [],
        errorCode: 'wsl_not_installed',
        operationReference: 'before01'
      })
      .mockResolvedValueOnce({
        state: 'not-installed',
        distros: [],
        errorCode: 'wsl_not_installed',
        operationReference: 'after002'
      })
    install.mockResolvedValue({
      outcome: 'completed',
      operationReference: 'install4',
      snapshot: {
        state: 'distro-required',
        distros: [],
        errorCode: 'wsl_distro_missing',
        operationReference: 'install4'
      }
    })

    await act(async () => root.render(<WslLocalShellSection />))
    await flush()
    const installButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install WSL2')
    )
    await act(async () => installButton?.click())
    await flush()
    expect(container.textContent).toContain('platform installation completed')

    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(probe).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('platform installation completed')
    expect(container.textContent).toContain('wsl_not_installed · after002')
  })

  it('selects an existing WSL2 distro and exact user, then shows every readiness result', async () => {
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    const trigger = container.querySelector('[data-slot="select-trigger"]')
    expect(trigger?.className).toContain('h-8')
    expect(container.querySelector('select')).toBeNull()

    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'scientist'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Save and check')
    )
    await act(async () => save?.click())
    await flush()

    expect(select).toHaveBeenCalledWith({ distro: 'Ubuntu-24.04', user: 'scientist' })
    expect(container.textContent).toContain('ready for sandboxed WSL2 Bash')
    expect(container.textContent).toContain('Local Windows workspace')
    expect(container.textContent).not.toContain('1234abcd')
  })

  it('shows stable error code and operation reference without backend output', async () => {
    probe.mockResolvedValue({
      state: 'failed',
      distros: [],
      errorCode: 'wsl_workspace_not_ntfs',
      readiness: { wsl2: true, localWorkspace: false },
      operationReference: 'a1b2c3d4'
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(container.textContent).toContain('wsl_workspace_not_ntfs · a1b2c3d4')
    expect(container.textContent).toContain(
      'Move the Open Science data folder to a local NTFS drive'
    )
    expect(container.textContent).toContain('Not checked')
  })

  it('uses named Settings status tokens for passed, failed, and unchecked readiness icons', async () => {
    probe.mockResolvedValue({
      state: 'dependency-required',
      distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }],
      selection: { distro: 'Ubuntu-24.04', user: 'scientist' },
      readiness: { wsl2: true, bash: true, bwrap: true, namespaces: false },
      errorCode: 'wsl_namespace_unavailable',
      operationReference: 'a1b2c3d4'
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    const readiness = container.querySelector('[aria-label="Readiness checks"]')
    expect(readiness?.querySelector('svg.text-status-success-foreground')).not.toBeNull()
    expect(readiness?.querySelector('svg.text-status-failure-foreground')).not.toBeNull()
    expect(readiness?.querySelector('svg.text-status-info-foreground')).not.toBeNull()
    expect(readiness?.querySelector('svg.text-primary')).toBeNull()
    expect(readiness?.querySelector('svg.text-destructive')).toBeNull()
    expect(readiness?.querySelector('svg.text-muted-foreground')).toBeNull()
  })

  it('requires an explicit click to install the recommended distro, then opens first launch interactively', async () => {
    probe.mockResolvedValue({
      state: 'distro-required',
      distros: [],
      errorCode: 'wsl_distro_missing',
      operationReference: 'deadbeef'
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    const install = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install Ubuntu-22.04')
    )
    expect(install).toBeDefined()
    expect(installRecommended).not.toHaveBeenCalled()
    await act(async () => install?.click())
    await flush()

    expect(installRecommended).toHaveBeenCalledOnce()
    const launch = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open distribution terminal')
    )
    await act(async () => launch?.click())
    await flush()
    expect(openTerminal).toHaveBeenCalledWith({ distro: 'Ubuntu-22.04' })
  })

  it('offers a copyable bubblewrap command and opens the selected user terminal without running it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    probe.mockResolvedValue({
      state: 'dependency-required',
      distros: [{ name: 'Ubuntu-22.04', version: 2, isDefault: true }],
      selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
      readiness: { wsl2: true, home: true, bash: true, bwrap: false },
      errorCode: 'wsl_bwrap_missing',
      suggestedCommand: 'sudo apt-get update && sudo apt-get install bubblewrap',
      operationReference: 'decafbad'
    })
    await act(async () => root.render(<WslLocalShellSection />))
    await flush()

    expect(container.textContent).toContain('Open Science will not run sudo or a package manager')
    expect(container.textContent).toContain(
      'sudo apt-get update && sudo apt-get install bubblewrap'
    )
    const copy = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Copy command')
    )
    await act(async () => copy?.click())
    expect(writeText).toHaveBeenCalledWith('sudo apt-get update && sudo apt-get install bubblewrap')

    const launch = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open distribution terminal')
    )
    await act(async () => launch?.click())
    await flush()
    expect(openTerminal).toHaveBeenCalledWith({ distro: 'Ubuntu-22.04', user: 'scientist' })
  })
})
