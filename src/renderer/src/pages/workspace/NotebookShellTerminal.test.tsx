// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'
import { NotebookShellTerminal } from './NotebookShellTerminal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
const request = { projectId: 'project', sessionId: 'session', workspaceCwd: '/workspace' }
beforeEach(() => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
describe('Notebook human Shell input', () => {
  it('executes through the app and stops through the existing Notebook shutdown owner', async () => {
    let finish!: () => void
    const executeShell = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const shutdown = vi.fn(async () => {
      finish()
      return { sessionId: 'session', status: 'shutdown' }
    })
    Object.assign(window, { api: { notebook: { executeShell, shutdown } } })
    const onChanged = vi.fn(async () => undefined)
    await act(async () =>
      root.render(
        <NotebookShellTerminal
          request={request}
          disabled={false}
          active={false}
          onChanged={onChanged}
        />
      )
    )
    const input = container.querySelector('textarea')!
    await act(async () => {
      fireEvent.change(input, { target: { value: '/bin/sleep 600' } })
    })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(executeShell).toHaveBeenCalledExactlyOnceWith({
      ...request,
      command: '/bin/sleep 600',
      timeoutMs: 600_000
    })
    expect(input.disabled).toBe(true)
    const stop = container.querySelector('button')!
    expect(stop.textContent).toBe('Stop Notebook')
    await act(async () => fireEvent.click(stop))
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(request)
    expect(input.disabled).toBe(false)
    expect(onChanged).toHaveBeenCalled()
  })
  it('offers Stop after remounting with an authoritative active Shell run', async () => {
    const shutdown = vi.fn().mockResolvedValue({ status: 'shutdown' })
    Object.assign(window, { api: { notebook: { shutdown } } })
    await act(async () =>
      root.render(
        <NotebookShellTerminal
          request={request}
          disabled={true}
          active={true}
          onChanged={vi.fn()}
        />
      )
    )
    expect(container.querySelector('button')!.textContent).toBe('Stop Notebook')
    await act(async () => fireEvent.click(container.querySelector('button')!))
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(request)
  })
  it('keeps rejected input editable and refuses writes during runtime recovery', async () => {
    const executeShell = vi.fn().mockRejectedValue(new Error('Admission failed'))
    Object.assign(window, { api: { notebook: { executeShell } } })
    await act(async () =>
      root.render(
        <NotebookShellTerminal
          request={request}
          disabled={false}
          active={false}
          onChanged={vi.fn()}
        />
      )
    )
    const input = container.querySelector('textarea')!
    await act(async () => fireEvent.change(input, { target: { value: 'pwd' } }))
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(input.value).toBe('pwd')
    expect(container.textContent).toContain('Admission failed')
    await act(async () => useDesktopRuntimeRecoveryStore.setState({ phase: 'reconnecting' }))
    expect(input.disabled).toBe(true)
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(executeShell).toHaveBeenCalledOnce()
  })
})
