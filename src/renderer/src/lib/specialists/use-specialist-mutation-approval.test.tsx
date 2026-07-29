// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSpecialistMutationApproval, type SpecialistApprovalApi } from './use-specialist-mutation-approval'
import type { SpecialistMutationPreview } from '../../../../shared/specialist-preview'

const preview: SpecialistMutationPreview = {
  action: 'create',
  identity: { agentId: 'rna-reviewer', name: 'RNA Reviewer' },
  instructionsSummary: { changed: true, length: 10 },
  skills: ['rna-seq'],
  connectors: ['pubmed'],
  affectedSessions: { available: true }
}

type ApiMocks = {
  api: SpecialistApprovalApi
  confirmMutation: ReturnType<typeof vi.fn>
  cancelMutation: ReturnType<typeof vi.fn>
  stageMutation: ReturnType<typeof vi.fn>
}

const makeApi = (): ApiMocks => {
  const confirmMutation = vi.fn(async () => ({ specialist: { id: 'sp-1' } }))
  const cancelMutation = vi.fn(async () => undefined)
  const stageMutation = vi.fn(async () => ({ mutationId: 'mut-1', preview }))
  const api = {
    stageMutation,
    confirmMutation,
    cancelMutation
  } as unknown as SpecialistApprovalApi
  return { api, confirmMutation, cancelMutation, stageMutation }
}

describe('useSpecialistMutationApproval', () => {
  it('stages a proposal and exposes a live approval with the preview', async () => {
    const { api, stageMutation } = makeApi()
    const { result } = renderHook(() => useSpecialistMutationApproval({ api }))

    await act(async () => {
      await result.current.stage('create_specialist', { agentId: 'rna-reviewer' })
    })

    expect(stageMutation).toHaveBeenCalledWith({
      toolName: 'create_specialist',
      args: { agentId: 'rna-reviewer' }
    })
    expect(result.current.approval?.preview.identity.name).toBe('RNA Reviewer')
    expect(result.current.approval?.mutationId).toBe('mut-1')
    expect(result.current.approval?.pending).toBe(false)
  })

  it('approve confirms the mutation exactly once and settles applied', async () => {
    const { api, confirmMutation, cancelMutation } = makeApi()
    const onSettled = vi.fn()
    const { result } = renderHook(() => useSpecialistMutationApproval({ api, onSettled }))
    await act(async () => {
      await result.current.stage('create_specialist', {})
    })

    await act(async () => {
      await result.current.approval?.approve()
    })

    expect(confirmMutation).toHaveBeenCalledTimes(1)
    expect(confirmMutation).toHaveBeenCalledWith({ mutationId: 'mut-1' })
    expect(cancelMutation).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ kind: 'applied', specialistId: 'sp-1' }))
    // After settle the card clears.
    expect(result.current.approval).toBeUndefined()
  })

  it('decline cancels the staged mutation and settles declined with no confirm', async () => {
    const { api, cancelMutation, confirmMutation } = makeApi()
    const onSettled = vi.fn()
    const { result } = renderHook(() => useSpecialistMutationApproval({ api, onSettled }))
    await act(async () => {
      await result.current.stage('create_specialist', {})
    })

    await act(async () => {
      await result.current.approval?.decline()
    })

    expect(cancelMutation).toHaveBeenCalledTimes(1)
    expect(confirmMutation).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ kind: 'declined' }))
  })

  it('a stale-revision confirm failure settles as a conflict (newer data preserved)', async () => {
    const { api, confirmMutation } = makeApi()
    confirmMutation.mockRejectedValueOnce(new Error('Stale revision; reload to pick up newer data.'))
    const onSettled = vi.fn()
    const { result } = renderHook(() => useSpecialistMutationApproval({ api, onSettled }))
    await act(async () => {
      await result.current.stage('update_specialist', {})
    })

    await act(async () => {
      await result.current.approval?.approve()
    })

    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'conflict' })
    )
  })

  it('a switch approval confirms and reports the switched session binding', async () => {
    const { api, confirmMutation } = makeApi()
    confirmMutation.mockResolvedValueOnce({
      switched: { targetSessionId: 'session-1', specialistId: 'sp-target' }
    })
    const onSettled = vi.fn()
    const { result } = renderHook(() => useSpecialistMutationApproval({ api, onSettled }))
    await act(async () => {
      await result.current.stage('switch_specialist', { sessionId: 'session-1', specialistId: 'sp-target' })
    })

    await act(async () => {
      await result.current.approval?.approve()
    })

    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'applied',
          switched: { targetSessionId: 'session-1', specialistId: 'sp-target' }
        })
      )
    })
  })
})
