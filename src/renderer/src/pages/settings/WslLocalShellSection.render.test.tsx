// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WslLocalShellSection } from './WslLocalShellSection'

let container: HTMLDivElement
let root: Root
let probe: ReturnType<typeof vi.fn>
let select: ReturnType<typeof vi.fn>

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
  ;(window as unknown as { api: unknown }).api = {
    settings: { probeWslSetup: probe, selectWslProfile: select }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('WslLocalShellSection', () => {
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
})
