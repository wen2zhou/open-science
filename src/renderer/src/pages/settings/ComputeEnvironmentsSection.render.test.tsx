// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeEnvironment } from '../../../../shared/compute-environment'
import { ComputeEnvironmentsSection } from './ComputeEnvironmentsSection'

let container: HTMLDivElement
let root: Root

type ComputeApi = {
  environmentsList: ReturnType<typeof vi.fn>
  environmentCreate: ReturnType<typeof vi.fn>
  environmentUpdate: ReturnType<typeof vi.fn>
  environmentDelete: ReturnType<typeof vi.fn>
  environmentRecordValidation: ReturnType<typeof vi.fn>
}

const stubWindowApi = (api: Partial<ComputeApi>): void => {
  ;(globalThis as unknown as { window: { api: { compute: ComputeApi } } }).window = {
    api: {
      compute: {
        environmentsList: api.environmentsList ?? vi.fn().mockResolvedValue([]),
        environmentCreate: api.environmentCreate ?? vi.fn().mockResolvedValue({}),
        environmentUpdate: api.environmentUpdate ?? vi.fn().mockResolvedValue({}),
        environmentDelete: api.environmentDelete ?? vi.fn().mockResolvedValue(undefined),
        environmentRecordValidation:
          api.environmentRecordValidation ?? vi.fn().mockResolvedValue(undefined)
      }
    }
  } as never
}

const env = (overrides: Partial<ComputeEnvironment> = {}): ComputeEnvironment => ({
  id: 'env-1',
  providerId: 'ssh:biowulf',
  name: 'ml',
  visibility: 'provider',
  specHash: 'h'.repeat(64),
  spec: { runtime: 'conda', packages: ['numpy'], variables: {}, weights: [], smokeChecks: [] },
  resolution: { kind: 'conda', envName: 'ml', activation: 'conda activate ml' },
  status: 'ready',
  buildJobId: undefined,
  validation: {
    specHash: 'h'.repeat(64),
    command: 'python -c "import numpy"',
    exitCode: 0,
    validatedAt: '2026-07-27T00:00:00.000Z',
    result: 'ready'
  },
  validatedAt: Date.parse('2026-07-27T00:00:00.000Z'),
  detailsDoc: '',
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stubWindowApi({})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ComputeEnvironmentsSection', () => {
  it('lists environments with name, status badge, and resolution summary', async () => {
    const list = vi.fn().mockResolvedValue([
      env({ name: 'ml', status: 'ready' }),
      env({
        id: 'env-2',
        name: 'gpu',
        status: 'stale',
        resolution: { kind: 'module', modules: ['cuda/12.2'] }
      })
    ])
    stubWindowApi({ environmentsList: list })

    await act(async () => {
      root.render(<ComputeEnvironmentsSection providerId="ssh:biowulf" />)
    })

    expect(list).toHaveBeenCalledWith('ssh:biowulf')
    expect(container.textContent).toContain('ml')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('gpu')
    expect(container.textContent).toContain('Stale')
    expect(container.textContent).toContain('module:cuda/12.2')
  })

  it('renders the empty state when no environments are registered', async () => {
    stubWindowApi({ environmentsList: vi.fn().mockResolvedValue([]) })
    await act(async () => {
      root.render(<ComputeEnvironmentsSection providerId="ssh:biowulf" />)
    })
    expect(container.textContent).toContain('No environments registered yet.')
  })

  it('opens the register dialog when the register button is clicked', async () => {
    stubWindowApi({ environmentsList: vi.fn().mockResolvedValue([]) })
    await act(async () => {
      root.render(<ComputeEnvironmentsSection providerId="ssh:biowulf" />)
    })
    const registerBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Register environment')
    )!
    await act(async () => {
      registerBtn.click()
    })
    expect(container.textContent).toContain('Register environment')
    expect(container.textContent).toContain('Portable spec (JSON)')
    expect(container.textContent).toContain('Resolution (JSON)')
  })

  it('creates an environment through the IPC handler when the dialog is saved', async () => {
    const create = vi.fn().mockResolvedValue(env())
    const list = vi.fn().mockResolvedValue([])
    stubWindowApi({ environmentCreate: create, environmentsList: list })
    await act(async () => {
      root.render(<ComputeEnvironmentsSection providerId="ssh:biowulf" />)
    })
    const registerBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Register environment')
    )!
    await act(async () => {
      registerBtn.click()
    })
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save'
    )!
    await act(async () => {
      saveBtn.click()
    })
    expect(create).toHaveBeenCalledTimes(1)
    const call = create.mock.calls[0]!
    expect(call[0]).toBe('ssh:biowulf')
    expect(call[1].spec.runtime).toBe('conda')
    expect(call[1].resolution.kind).toBe('conda')
  })

  it('deletes an environment through the IPC handler', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    const list = vi.fn().mockResolvedValue([env({ id: 'env-x', name: 'ml' })])
    stubWindowApi({ environmentDelete: del, environmentsList: list })
    await act(async () => {
      root.render(<ComputeEnvironmentsSection providerId="ssh:biowulf" />)
    })
    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Delete')
    )!
    await act(async () => {
      deleteBtn.click()
    })
    expect(del).toHaveBeenCalledWith('env-x')
  })
})
