// Renderer hook that connects the Specialist mutation approval card to the live app-owned management
// MCP (issue 04a) through the IPC bridge (issue 04b). The Customize agent proposes a mutation by calling
// a management tool; the main process stages it and returns the structured preview. This hook holds the
// staged mutation so the chat can render `SpecialistMutationApprovalCard` with that live preview and the
// confirm/decline callbacks the card was waiting for.
//
// Approve routes the stored mutationId back through `specialists:confirm-mutation`, which applies the
// mutation exactly once, reads back the real state, and broadcasts `specialists:changed` so an already-
// open Settings page reloads and shows exactly one new/updated row immediately (no restart).
// Decline routes through `specialists:cancel-mutation` with no side effects.
//
// Permission-mode invariant is preserved end-to-end: the management tool surface never touches the
// session permission profile, and the switch path writes only specialistId + registry (issue-02
// next-message semantics). This hook reflects that — it has no permission-mode field to change.

import { useCallback, useState } from 'react'

import type { SpecialistMutationPreview } from '../../../../shared/specialist-preview'

export type SpecialistApprovalOutcome =
  | { kind: 'applied'; specialistId?: string; switched?: { targetSessionId: string; specialistId?: string } }
  | { kind: 'declined' }
  | { kind: 'conflict'; message?: string }
  | { kind: 'error'; message: string }

export type SpecialistApprovalPending = {
  mutationId: string
  preview: SpecialistMutationPreview
  pending: boolean
  conflict?: { message?: string }
  approve: () => Promise<void>
  decline: () => Promise<void>
}

export type SpecialistApprovalApi = {
  stageMutation: (request: {
    toolName: string
    args?: Record<string, unknown>
  }) => Promise<{ mutationId: string; preview: SpecialistMutationPreview }>
  confirmMutation: (request: {
    mutationId: string
  }) => Promise<{
    specialist?: { id: string }
    switched?: { targetSessionId: string; specialistId?: string }
  }>
  cancelMutation: (request: { mutationId: string }) => Promise<void>
}

// Extracts the typed api surface from window so tests can inject a stub. The real app provides it via
// the preload specialists namespace.
const defaultApi = (): SpecialistApprovalApi => window.api.specialists

export type UseSpecialistMutationApprovalOptions = {
  api?: SpecialistApprovalApi
  // Called after an approve/decline settles so the chat surface can clear the card or advance the turn.
  onSettled?: (outcome: SpecialistApprovalOutcome) => void
}

export const useSpecialistMutationApproval = (
  options: UseSpecialistMutationApprovalOptions = {}
) => {
  const api = options.api ?? defaultApi()
  const [pending, setPending] = useState<SpecialistApprovalPending | undefined>()

  // Stages a mutation proposal from the Customize agent and surfaces it as the live approval card state.
  const stage = useCallback(
    async (toolName: string, args: Record<string, unknown>): Promise<void> => {
      const staged = await api.stageMutation({ toolName, args })
      setPending({
        mutationId: staged.mutationId,
        preview: staged.preview,
        pending: false,
        approve: async () => undefined,
        decline: async () => undefined
      })
    },
    [api]
  )

  const settle = useCallback(
    (outcome: SpecialistApprovalOutcome): void => {
      setPending(undefined)
      options.onSettled?.(outcome)
    },
    [options]
  )

  // Approve: confirm the staged mutation exactly once through the management MCP. Applies it, reads back
  // the real state, and the main process broadcasts the settings refresh. A stale-revision conflict or
  // execution error is surfaced as a conflict/error outcome rather than force-applying.
  const approve = useCallback(async (): Promise<void> => {
    if (!pending) return
    const mutationId = pending.mutationId
    setPending({ ...pending, pending: true })
    try {
      const result = await api.confirmMutation({ mutationId })
      settle(
        result.switched
          ? { kind: 'applied', switched: result.switched }
          : { kind: 'applied', specialistId: result.specialist?.id }
      )
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The mutation could not be applied.'
      if (/reload|conflict|stale|revision/i.test(message)) {
        settle({ kind: 'conflict', message })
      } else {
        settle({ kind: 'error', message })
      }
    }
  }, [api, pending, settle])

  // Decline: cancel the staged mutation with no side effects.
  const decline = useCallback(async (): Promise<void> => {
    if (!pending) return
    const mutationId = pending.mutationId
    setPending({ ...pending, pending: true })
    try {
      await api.cancelMutation({ mutationId })
      settle({ kind: 'declined' })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The mutation could not be cancelled.'
      settle({ kind: 'error', message })
    }
  }, [api, pending, settle])

  // Re-bind the live callbacks on every render so the card always invokes the freshest state.
  const bound: SpecialistApprovalPending | undefined = pending
    ? { ...pending, approve, decline }
    : undefined

  return { stage, approval: bound }
}
