// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { ComputeApprovalDialog } from './ComputeApprovalDialog'

let container: HTMLDivElement
let root: Root

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === label
  )

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    respondApproval: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const commandRequest: ComputeApprovalRequest = {
  id: 'approval-1',
  provider_id: 'ssh:cluster',
  provider_name: 'Research cluster',
  shape: 'direct_ssh',
  intent: 'Inspect the remote environment',
  command_preview: 'python ...',
  command_full: 'python --version && pip list'
}

describe('ComputeApprovalDialog — command card', () => {
  it('renders nothing without a pending approval', () => {
    act(() => root.render(<ComputeApprovalDialog />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('uses shared dialog chrome while preserving the approval content', () => {
    useComputeStore.setState({ pendingApprovals: [commandRequest] })
    act(() => root.render(<ComputeApprovalDialog />))

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('z-[60]')
    expect(document.body.textContent).toContain('Research cluster')
    expect(document.body.textContent).toContain('python ...')
  })

  it('shows the full command without changing approval state', () => {
    useComputeStore.setState({ pendingApprovals: [commandRequest] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton('Show full command')?.click())

    expect(document.body.textContent).toContain('python --version && pip list')
    expect(useComputeStore.getState().respondApproval).not.toHaveBeenCalled()
  })

  it('collapses the command when the approval queue advances to a new request', () => {
    const nextRequest: ComputeApprovalRequest = {
      ...commandRequest,
      id: 'approval-2',
      command_preview: 'Rscript ...',
      command_full: 'Rscript analysis.R --all'
    }
    useComputeStore.setState({ pendingApprovals: [commandRequest] })
    act(() => root.render(<ComputeApprovalDialog />))
    act(() => findButton('Show full command')?.click())

    act(() => useComputeStore.setState({ pendingApprovals: [nextRequest] }))

    expect(document.body.textContent).toContain('Rscript ...')
    expect(document.body.textContent).not.toContain('Rscript analysis.R --all')
    expect(findButton('Show full command')).toBeDefined()
  })

  it.each([
    ['Deny', 'deny'],
    ['Once', 'once'],
    ['This conversation', 'conversation'],
    ['This project', 'project']
  ] as const)('keeps the %s approval decision', (label, decision) => {
    useComputeStore.setState({ pendingApprovals: [commandRequest] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton(label)?.click())

    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(commandRequest.id, decision)
  })
})

const provisioningRequest = (
  overrides: Partial<ComputeApprovalRequest> = {}
): ComputeApprovalRequest =>
  ({
    id: 'p1',
    provider_id: 'ssh:biowulf',
    provider_name: 'ssh:biowulf',
    shape: 'direct_ssh',
    intent: 'Provision environment "ml-torch"',
    operation: 'environment_provisioning',
    driver: 'direct',
    build_script_summary: 'conda create -n ml-torch && pip install torch numpy scipy',
    validation_script_summary: "python -c 'import torch; assert torch.cuda.is_available()'",
    resources: JSON.stringify({
      nodes: 1,
      cpusPerTask: 4,
      gpus: 1,
      gpuType: 'a100',
      memoryMib: 32768,
      timeLimitSeconds: 3600
    }),
    cache_path: '/scratch/cache/torch',
    weight_paths: [
      '/data/weights/bert-base.safetensors',
      '/data/weights/clip-vit-large.safetensors'
    ],
    egress_domains: ['conda.anaconda.org', 'pypi.org', 'huggingface.co'],
    ...overrides
  }) as ComputeApprovalRequest

describe('ComputeApprovalDialog — environment provisioning card', () => {
  it('renders the provisioning card with provider, environment, scripts, cache/weight paths and egress domains', () => {
    useComputeStore.setState({ pendingApprovals: [provisioningRequest()] })
    act(() => root.render(<ComputeApprovalDialog />))

    const text = document.body.textContent ?? ''
    expect(text).toContain('Provisioning')
    expect(text).toContain('biowulf')
    expect(text).toContain('ssh:biowulf')
    expect(text).toContain('ml-torch')
    // build + validation script summaries
    expect(text).toContain('conda create -n ml-torch')
    expect(text).toContain('import torch; assert torch.cuda.is_available()')
    // cache + weight paths
    expect(text).toContain('/scratch/cache/torch')
    expect(text).toContain('/data/weights/bert-base.safetensors')
    expect(text).toContain('/data/weights/clip-vit-large.safetensors')
    // known egress domains
    expect(text).toContain('conda.anaconda.org')
    expect(text).toContain('pypi.org')
    expect(text).toContain('huggingface.co')
    // resources rendered as a compact summary, not raw JSON
    expect(text).toContain('1 GPU')
    expect(text).toContain('a100')
    expect(text).not.toContain('"cpusPerTask"')
  })

  it('does not render provisioning-only sections for a plain command approval', () => {
    useComputeStore.setState({
      pendingApprovals: [
        {
          id: 'c1',
          provider_id: 'ssh:biowulf',
          provider_name: 'biowulf',
          shape: 'direct_ssh',
          intent: 'Run analysis',
          operation: 'call_command',
          command_preview: 'python run.py',
          command_full: 'python run.py --flag'
        } as ComputeApprovalRequest
      ]
    })
    act(() => root.render(<ComputeApprovalDialog />))

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Build script')
    expect(text).not.toContain('Known egress')
    expect(text).toContain('Run analysis')
  })

  it('omits optional empty sections (no weights, no egress) gracefully', () => {
    useComputeStore.setState({
      pendingApprovals: [
        provisioningRequest({ weight_paths: undefined, egress_domains: undefined })
      ]
    })
    act(() => root.render(<ComputeApprovalDialog />))

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Weight paths')
    expect(text).not.toContain('Known egress')
    // still shows the required fields
    expect(text).toContain('ml-torch')
    expect(text).toContain('/scratch/cache/torch')
  })

  it('records the provisioning decision through the store', () => {
    const respondApproval = vi.fn()
    useComputeStore.setState({
      pendingApprovals: [provisioningRequest()],
      respondApproval
    })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton('This project')?.click())
    expect(respondApproval).toHaveBeenCalledWith('p1', 'project')
  })
})
