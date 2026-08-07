// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

import {
  SubagentAvailabilityNotice,
  SubagentComposerAggregate,
  SubagentPreview,
  SubagentSummaryCard
} from './SubagentReleaseSurfaces'
import { MobilePreviewSheet } from './MobilePreviewSheet'

const createSession = (): ChatSession => {
  const now = 1_700_000_000_000
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Release gate',
    cwd: '/tmp/release-gate',
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames: [
        {
          id: 'root',
          originBindingState: 'root',
          kind: 'root',
          status: 'running',
          activeBranchId: 'root-branch',
          createdAt: now
        },
        {
          id: 'child-a',
          parentFrameId: 'root',
          originMessageId: 'root-prompt',
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: 'Evidence landscape',
          agentName: 'Main Agent',
          status: 'running',
          activeBranchId: 'child-a-branch',
          createdAt: now + 1
        },
        {
          id: 'child-b',
          parentFrameId: 'root',
          originMessageId: 'root-prompt',
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: 'Challenge assumptions',
          agentName: 'Risk Specialist',
          status: 'error',
          activeBranchId: 'child-b-branch',
          createdAt: now + 2
        }
      ],
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root',
          headMessageId: 'root-prompt',
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'child-a-branch',
          agentFrameId: 'child-a',
          headMessageId: 'child-a-answer',
          createdAt: now + 1,
          updatedAt: now + 3
        },
        {
          id: 'child-b-branch',
          agentFrameId: 'child-b',
          headMessageId: 'child-b-prompt',
          createdAt: now + 2,
          updatedAt: now + 2
        }
      ],
      messages: [
        {
          id: 'root-prompt',
          role: 'user',
          content: 'Compare the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: now,
          updatedAt: now,
          agentFrameId: 'root',
          introducedOnBranchId: 'root-branch'
        },
        {
          id: 'child-a-prompt',
          role: 'user',
          content: 'Map the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: now + 1,
          updatedAt: now + 1,
          agentFrameId: 'child-a',
          introducedOnBranchId: 'child-a-branch',
          runtimeSegmentId: 'runtime-a'
        },
        {
          id: 'child-a-answer',
          role: 'agent',
          content: 'Fourteen strong studies remain.',
          status: 'complete',
          eventIds: [],
          responseToMessageId: 'child-a-prompt',
          createdAt: now + 3,
          updatedAt: now + 3,
          agentFrameId: 'child-a',
          introducedOnBranchId: 'child-a-branch',
          parentMessageId: 'child-a-prompt',
          runtimeSegmentId: 'runtime-a'
        },
        {
          id: 'child-b-prompt',
          role: 'user',
          content: 'Challenge assumptions',
          status: 'complete',
          eventIds: [],
          createdAt: now + 2,
          updatedAt: now + 2,
          agentFrameId: 'child-b',
          introducedOnBranchId: 'child-b-branch',
          runtimeSegmentId: 'runtime-b'
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: [
        {
          id: 'runtime-a',
          agentFrameId: 'child-a',
          frameworkId: 'claude-code',
          startedAt: now + 1
        },
        {
          id: 'runtime-b',
          agentFrameId: 'child-b',
          frameworkId: 'claude-code',
          startedAt: now + 2
        }
      ]
    },
    runtimeContext: {
      version: 1,
      revision: 2,
      delegatedWork: {
        records: [
          {
            agentFrameId: 'child-a',
            attempts: [
              {
                id: 'attempt-a',
                status: 'running',
                resolvedAgent: { kind: 'main' },
                runtimeSegmentIds: ['runtime-a'],
                startedAt: now + 1
              }
            ],
            pendingMessages: []
          },
          {
            agentFrameId: 'child-b',
            attempts: [
              {
                id: 'attempt-b',
                status: 'error',
                resolvedAgent: {
                  kind: 'specialist',
                  profileId: 'risk',
                  revision: 2,
                  displayName: 'Risk Specialist'
                },
                runtimeSegmentIds: ['runtime-b'],
                startedAt: now + 2,
                endedAt: now + 4,
                error: { code: 'provider', message: 'Provider turn failed' }
              }
            ],
            pendingMessages: []
          }
        ]
      }
    }
  }
}

describe('release-gate Subagent surfaces', () => {
  afterEach(cleanup)

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [createSession()] })
  })

  it('renders one summary with text statuses and opens one stable Session preview', () => {
    const session = createSession()
    const { rerender } = render(<SubagentSummaryCard session={session} permissions={[]} />)

    expect(screen.getAllByRole('region', { name: 'Subagent summary' })).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: /Evidence landscape, running/i }).className
    ).toContain('focus-visible:ring-[3px]')
    expect(screen.getByRole('button', { name: /Challenge assumptions, error/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Evidence landscape, running/i }))
    fireEvent.click(screen.getByRole('button', { name: /Challenge assumptions, error/i }))
    expect(
      usePreviewWorkbenchStore
        .getState()
        .items.filter((item) => item.id === 'tool:session-1:subagents')
    ).toHaveLength(1)

    rerender(<SubagentSummaryCard session={session} permissions={[]} />)
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedAgentFrameId: 'child-b'
    })
  })

  it('keeps Composer to one aggregate and exposes a count-only polite live region', () => {
    render(<SubagentComposerAggregate session={createSession()} permissions={[]} />)

    const aggregate = screen.getByRole('button', { name: '1 subagent running' })
    expect(aggregate.getAttribute('aria-live')).toBe('polite')
    expect(aggregate.textContent).not.toContain('Evidence landscape')
    expect(aggregate.className).toContain('focus-visible:ring-[3px]')
  })

  it('provides a read-only Frame selector, raw status, error detail, and Close focus return', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open Subagents'
    document.body.append(trigger)
    trigger.focus()

    render(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          projectId: 'project-1',
          selectedAgentFrameId: 'child-b'
        }}
        returnFocus={trigger}
      />
    )

    expect(screen.getByLabelText('Subagent Frame').className).toContain('focus-visible:ring-[3px]')
    expect(screen.getByText('error')).toBeTruthy()
    expect(screen.getByText('Provider turn failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()

    const closeButton = screen.getByRole('button', { name: 'Close Subagents preview' })
    expect(closeButton.className).toContain('focus-visible:ring-[3px]')
    fireEvent.click(closeButton)
    expect(document.activeElement).toBe(trigger)
  })

  it('provides a visible tooltip for the icon-only Preview close control', async () => {
    render(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          selectedAgentFrameId: 'child-a'
        }}
      />
    )

    const closeButton = screen.getByRole('button', { name: 'Close Subagents preview' })
    fireEvent.focus(closeButton)
    expect((await screen.findByRole('tooltip')).textContent).toContain('Close Subagents preview')
  })

  it('selects another Frame by keyboard-compatible native select without opening a second preview', () => {
    const item = {
      id: 'tool:session-1:subagents',
      type: 'tool' as const,
      toolKind: 'subagents' as const,
      title: 'Subagents',
      sessionId: 'session-1',
      projectId: 'project-1',
      selectedAgentFrameId: 'child-b'
    }
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
    render(<SubagentPreview item={item} />)

    fireEvent.change(screen.getByLabelText('Subagent Frame'), { target: { value: 'child-a' } })

    expect(screen.getByText('Fourteen strong studies remain.')).toBeTruthy()
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedAgentFrameId: 'child-a'
    })
  })

  it('offers Retry when the selected durable Frame cannot be read', () => {
    render(
      <SubagentPreview
        item={{
          id: 'tool:session-1:subagents',
          type: 'tool',
          toolKind: 'subagents',
          title: 'Subagents',
          sessionId: 'session-1',
          selectedAgentFrameId: 'missing'
        }}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('could not be read')
    expect(screen.getByRole('button', { name: 'Retry Subagent preview' }).className).toContain(
      'focus-visible:ring-[3px]'
    )
  })

  it('shows an actionable unavailable notice and no false support claim', () => {
    const onOpenSettings = vi.fn()
    render(
      <SubagentAvailabilityNotice
        frameworkId="opencode"
        frameworks={[
          {
            id: 'opencode',
            displayName: 'OpenCode',
            supportsSkills: true,
            supportsDelegatedWork: false
          }
        ]}
        onOpenSettings={onOpenSettings}
      />
    )

    expect(screen.getByRole('status').textContent).toContain('Subagents unavailable for OpenCode')
    const settingsButton = screen.getByRole('button', { name: 'Open Settings' })
    expect(settingsButton.className).toContain('focus-visible:ring-[3px]')
    fireEvent.click(settingsButton)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('shows a production admission rejection as an actionable product notice', () => {
    const onOpenSettings = vi.fn()
    render(
      <SubagentAvailabilityNotice
        frameworkId="opencode"
        frameworks={[
          {
            id: 'opencode',
            displayName: 'OpenCode',
            supportsSkills: true,
            supportsDelegatedWork: true
          }
        ]}
        unavailableReason="The requested Specialist configuration is unavailable."
        onOpenSettings={onOpenSettings}
      />
    )

    expect(screen.getByRole('status').textContent).toContain(
      'Subagents unavailable for this configuration'
    )
    expect(screen.getByRole('status').textContent).toContain(
      'The requested Specialist configuration is unavailable.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('renders the same Frame selector and close controls in the mobile Preview sheet', () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'tool:session-1:subagents',
      type: 'tool',
      toolKind: 'subagents',
      title: 'Subagents',
      sessionId: 'session-1',
      projectId: 'project-1',
      selectedAgentFrameId: 'child-a'
    })
    render(<MobilePreviewSheet open onClose={vi.fn()} />)

    const sheet = screen.getByTestId('mobile-preview-sheet')
    expect(within(sheet).getByLabelText('Subagent Frame')).toBeTruthy()
    expect(within(sheet).getByRole('button', { name: 'Close Subagents preview' })).toBeTruthy()
    expect(within(sheet).getByText('Fourteen strong studies remain.')).toBeTruthy()
  })
})
