// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  CUSTOMIZE_CHAT_PREFILL_TEXT,
  CUSTOMIZE_CHAT_SPECIALIST_ID,
  buildCustomizeChatPrefill,
  resolveCustomizeChatEntry
} from './customize-chat'
import { docToText } from '../../pages/workspace/composer/composer-doc'
import type { SpecialistView } from '../../../../shared/settings'

const customizeView = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'customize',
  agentId: 'customize',
  name: 'Customize',
  description: 'Create and refine reusable specialists.',
  instructions: 'Help the user create or refine a specialist configuration.',
  colorKey: 'purple',
  iconKey: 'brain',
  skillIds: ['customize'],
  connectorIds: [],
  enabled: true,
  revision: 1,
  kind: 'builtin-customize',
  effectiveSkillCount: 1,
  effectiveConnectorCount: 0,
  ...overrides
})

describe('buildCustomizeChatPrefill', () => {
  it('pre-fills the Customize Skill chip and the editable request text', () => {
    const doc = buildCustomizeChatPrefill()
    // First node is the Customize skill chip; second is the request text.
    expect(doc.nodes[0]).toEqual({ type: 'skill', id: 'customize', name: 'Customize' })
    expect(doc.nodes[1]).toMatchObject({ type: 'text' })
    expect((doc.nodes[1] as { text: string }).text.trim()).toBe(CUSTOMIZE_CHAT_PREFILL_TEXT)
  })

  it('renders as the /Customize chip followed by the request, matching the PRD', () => {
    expect(docToText(buildCustomizeChatPrefill())).toBe(`/Customize ${CUSTOMIZE_CHAT_PREFILL_TEXT}`)
  })
})

describe('resolveCustomizeChatEntry', () => {
  it('is ready when Customize is enabled, binding the session to Customize', () => {
    const result = resolveCustomizeChatEntry([customizeView()])
    expect(result).toEqual({
      kind: 'ready',
      specialistId: CUSTOMIZE_CHAT_SPECIALIST_ID,
      prefill: expect.any(Object)
    })
  })

  it('is disabled when Customize is disabled, with no pre-filled chat', () => {
    const result = resolveCustomizeChatEntry([customizeView({ enabled: false })])
    expect(result).toEqual({ kind: 'disabled', specialistId: CUSTOMIZE_CHAT_SPECIALIST_ID })
    expect(result.kind).toBe('disabled')
    if (result.kind === 'disabled') {
      // No forced-Skill bypass path is offered.
      expect('prefill' in result).toBe(false)
    }
  })

  it('is disabled when Customize is absent from the catalog (no fallback bypass)', () => {
    const result = resolveCustomizeChatEntry([])
    expect(result.kind).toBe('disabled')
  })

  it('ignores non-Customize specialists when deciding the entry state', () => {
    const custom = customizeView({
      id: 'sp-1',
      agentId: 'rnaseq',
      name: 'RNA Reviewer',
      kind: 'custom'
    })
    // Customize present + enabled → ready even with other specialists around.
    expect(
      resolveCustomizeChatEntry([custom, customizeView({ enabled: true })]).kind
    ).toBe('ready')
    // Customize disabled → disabled regardless of other enabled specialists.
    expect(
      resolveCustomizeChatEntry([custom, customizeView({ enabled: false })]).kind
    ).toBe('disabled')
  })
})
