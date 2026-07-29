// @vitest-environment jsdom
// Component-level coverage for the composer's effective-capability projection:
//   - the framework enforcement-strength label near the specialist badge (both frameworks)
//   - send-time rejection of a forced-skill chip outside the effective allowlist, including a
//     chip that went stale after a Settings edit shrank the allowlist
// The skill catalog is seeded into the settings store the panel reads, so the projection delegates
// to the single shared resolver (no second calculation) and the renderer assertion matches the gate.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPanel } from './ConversationPanel'
import { emptyDoc, type ComposerDoc } from './composer/composer-doc'

// Builds a doc carrying one skill chip with the given id (and a matching display name).
const docWithSkillChip = (skillId: string): ComposerDoc => ({
  nodes: [{ type: 'skill', id: skillId, name: skillId }]
})

import type { ChatSession } from '@/stores/session-store'
import type { SessionSpecialistResolution } from '@/lib/specialists/resolve-session-specialist'
import type { SkillView, SpecialistView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: () => void
    'data-testid'?: string
  }>): React.JSX.Element => (
    <button type="button" disabled={disabled} onClick={onSelect} {...rest}>
      {children}
    </button>
  )
}))

vi.mock('./ComposerModelPicker', () => ({ ComposerModelPicker: (): null => null }))
vi.mock('./ComposerAgentControlsMenu', () => ({ ComposerAgentControlsMenu: (): null => null }))
vi.mock('./WorkspaceMessageScroller', () => ({ WorkspaceMessageScroller: (): null => null }))
vi.mock('./PermissionApprovalControls', () => ({ PermissionApprovalControls: (): null => null }))
vi.mock('@/components/RemoteJobBadge', () => ({ RemoteJobBadge: (): null => null }))

vi.mock('@/stores/session-job-store', () => ({
  useSessionJobStore: (
    selector: (s: {
      runningJobsForSession: () => unknown[]
      allJobsForSession: () => unknown[]
    }) => unknown
  ) =>
    selector({
      runningJobsForSession: () => [],
      allJobsForSession: () => []
    })
}))

let container: HTMLDivElement
let root: Root

const skill = (id: string, overrides: Partial<SkillView> = {}): SkillView => ({
  id,
  name: id,
  description: '',
  source: 'personal',
  updatedAt: '',
  enabled: true,
  ...overrides
})

const specialist = (id: string, overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id,
  agentId: id,
  name: id,
  skillIds: [],
  connectorIds: [],
  enabled: true,
  revision: 1,
  kind: 'custom',
  effectiveSkillCount: 0,
  effectiveConnectorCount: 0,
  ...overrides
})

const session = (framework: ChatSession['agentFrameworkId']): ChatSession =>
  ({
    id: 's1',
    title: 't',
    status: 'ready',
    agentFrameworkId: framework
  }) as unknown as ChatSession

const baseProps = {
  // Widen from the literal `undefined` so Partial<typeof baseProps> accepts a real ChatSession override.
  activeSession: undefined as ChatSession | undefined,
  draftDoc: emptyDoc,
  canSendMessage: true,
  canEditDraft: true,
  actionError: null,
  isPreviewPanelCollapsed: false,
  attachments: [],
  attachmentTransfers: [],
  isUploadingAttachments: false,
  notebookReference: undefined,
  pendingPermissions: [],
  permissionProfile: 'ask' as const,
  permissionProfileState: undefined,
  permissionGrants: [],
  contextUsage: undefined,
  canChangePermissionProfile: true,
  sessionSpecialistResolution: { kind: 'none' } as SessionSpecialistResolution,
  specialistSwitching: false,
  specialists: [] as SpecialistView[],
  onOpenSpecialistsSettings: vi.fn(),
  onSpecialistChange: vi.fn(),
  onDraftDocChange: vi.fn(),
  onSendMessage: vi.fn(),
  onStageAttachmentFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onCancelAttachmentTransfer: vi.fn(),
  onCancelRun: vi.fn(),
  onResumeSession: vi.fn().mockResolvedValue(undefined),
  onOpenNotebook: vi.fn(),
  onTogglePreviewPanel: vi.fn(),
  onRespondToPermission: vi.fn(),
  onPermissionProfileChange: vi.fn(),
  onRevokePermissionGrant: vi.fn(),
  onClearPermissionGrants: vi.fn(),
  autoReviewEnabled: false,
  onAutoReviewToggle: vi.fn(),
  enabledComputeHosts: [] as string[],
  onComputeHostToggle: vi.fn(),
  onRequestReview: vi.fn(),
  isRequestReviewDisabled: false,
  canEditMessage: true,
  onSendEditedMessage: vi.fn()
}

const renderPanel = (props: Partial<typeof baseProps> = {}): void => {
  act(() => {
    root.render(<ConversationPanel {...baseProps} {...props} />)
  })
}

const clickSend = (): void => {
  const btn = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null
  if (!btn) throw new Error('send button not found')
  act(() => {
    btn.click()
  })
}

beforeEach(() => {
  useSettingsStore.setState({ ...createInitialSettingsState(), skills: [skill('a'), skill('b')] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ConversationPanel specialist framework label', () => {
  it('shows Hard enforced for Claude Code when a specialist is bound', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    renderPanel({
      activeSession: session('claude-code'),
      sessionSpecialistResolution: { kind: 'bound', specialist: sp }
    })

    const label = container.querySelector('[data-testid="specialist-enforcement-label"]')
    expect(label?.textContent?.trim()).toBe('Hard enforced')
    expect(label?.getAttribute('data-enforcement')).toBe('hard')
  })

  it('shows Guidance only for Codex when a specialist is bound', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    renderPanel({
      activeSession: session('codex'),
      sessionSpecialistResolution: { kind: 'bound', specialist: sp }
    })

    const label = container.querySelector('[data-testid="specialist-enforcement-label"]')
    expect(label?.textContent?.trim()).toBe('Guidance only')
    expect(label?.getAttribute('data-enforcement')).toBe('guidance')
  })

  it('shows Guidance only for OpenCode when a specialist is bound', () => {
    const sp = specialist('sp', { skillIds: ['a'] })
    renderPanel({
      activeSession: session('opencode'),
      sessionSpecialistResolution: { kind: 'bound', specialist: sp }
    })

    const label = container.querySelector('[data-testid="specialist-enforcement-label"]')
    expect(label?.textContent?.trim()).toBe('Guidance only')
  })

  it('shows no enforcement label when no specialist is bound (None)', () => {
    renderPanel({ activeSession: session('claude-code') })
    expect(container.querySelector('[data-testid="specialist-enforcement-label"]')).toBeNull()
  })
})

describe('ConversationPanel forced-skill send rejection', () => {
  it('rejects an explicit chip outside the effective allowlist and does not start a turn', () => {
    const sp = specialist('sp', { skillIds: ['a'] }) // allows only a
    const onSendMessage = vi.fn()
    renderPanel({
      activeSession: session('claude-code'),
      sessionSpecialistResolution: { kind: 'bound', specialist: sp },
      draftDoc: docWithSkillChip('b'), // chip for b, which is outside the allowlist
      onSendMessage
    })

    clickSend()

    expect(onSendMessage).not.toHaveBeenCalled()
    const error = container.querySelector('[data-testid="forced-skill-error"]')
    expect(error?.textContent ?? '').toContain('"b"')
  })

  it('rejects a stale chip after a Settings edit shrank the allowlist', () => {
    // The specialist originally allowed a and b; a Settings edit removed b, so the b chip is stale.
    const sp = specialist('sp', { skillIds: ['a'] })
    const onSendMessage = vi.fn()
    renderPanel({
      activeSession: session('claude-code'),
      sessionSpecialistResolution: { kind: 'bound', specialist: sp },
      draftDoc: docWithSkillChip('b'),
      onSendMessage
    })

    clickSend()

    expect(onSendMessage).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="forced-skill-error"]')).not.toBeNull()
  })

  it('rejects every chip when the binding is unavailable', () => {
    const onSendMessage = vi.fn()
    renderPanel({
      activeSession: session('claude-code'),
      sessionSpecialistResolution: { kind: 'unavailable', specialistId: 'ghost' },
      draftDoc: docWithSkillChip('a'),
      onSendMessage
    })

    clickSend()

    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('sends when an allowed chip is within the effective allowlist and clears the error', () => {
    const sp = specialist('sp', { skillIds: ['a', 'b'] })
    const onSendMessage = vi.fn()
    renderPanel({
      activeSession: session('claude-code'),
      sessionSpecialistResolution: { kind: 'bound', specialist: sp },
      draftDoc: docWithSkillChip('a'),
      onSendMessage
    })

    clickSend()

    expect(onSendMessage).toHaveBeenCalledWith(['a'])
    expect(container.querySelector('[data-testid="forced-skill-error"]')).toBeNull()
  })

  it('leaves send behaviour unchanged when the binding is None', () => {
    const onSendMessage = vi.fn()
    renderPanel({
      activeSession: session('claude-code'),
      draftDoc: docWithSkillChip('anything'),
      onSendMessage
    })

    clickSend()

    expect(onSendMessage).toHaveBeenCalledWith(['anything'])
    expect(container.querySelector('[data-testid="forced-skill-error"]')).toBeNull()
  })
})
