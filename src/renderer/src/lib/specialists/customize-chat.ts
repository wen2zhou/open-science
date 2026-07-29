// "Chat with agent" entry helpers for the Customize built-in Specialist.
//
// Entering Settings › Specialists › Add specialist › Chat with agent opens a normal persisted
// session bound to the enabled Built-in Customize Specialist. The composer is pre-filled with the
// Customize Skill chip and the editable text `Help me create a new specialist.` — nothing is sent
// until the user chooses to send.
//
// When Customize is disabled, the entry must NOT bypass that disabled state through a forced Skill.
// `resolveCustomizeChatEntry` reports the disabled state and signals the caller to offer an enable
// action instead of opening a pre-filled chat.

import { CUSTOMIZE_SPECIALIST_ID } from '../../../../shared/specialist-builtin'
import type { SpecialistView } from '../../../../shared/settings'
import type { ComposerDoc } from '../../pages/workspace/composer/composer-doc'

// The editable pre-filled request text shown next to the Customize Skill chip.
export const CUSTOMIZE_CHAT_PREFILL_TEXT = 'Help me create a new specialist.'

// The Specialist the chat-with-agent session binds to: the enabled Built-in Customize.
export const CUSTOMIZE_CHAT_SPECIALIST_ID = CUSTOMIZE_SPECIALIST_ID

// Outcome of the chat-with-agent entry decision. `customizeEnabled` drives whether the entry opens a
// pre-filled chat (enabled) or surfaces a disabled state with an enable action (disabled).
export type CustomizeChatEntry =
  | { kind: 'ready'; specialistId: string; prefill: ComposerDoc }
  | { kind: 'disabled'; specialistId: string }

// Builds the pre-filled composer doc: a Customize Skill chip followed by the editable request text.
// Pure and DOM-free so it can be unit-tested without the contenteditable editor. The Customize Skill
// is referenced by id; its display name is `Customize` (matches the `/Customize` chip in the PRD).
export const buildCustomizeChatPrefill = (): ComposerDoc => ({
  nodes: [
    { type: 'skill', id: 'customize', name: 'Customize' },
    { type: 'text', text: ` ${CUSTOMIZE_CHAT_PREFILL_TEXT}` }
  ]
})

// Resolves the entry decision from the live Specialist catalog. The entry is `ready` only when the
// Built-in Customize exists and is enabled. A missing Customize is treated as disabled (the entry
// must not bypass the disabled state or fall back to a forced Skill path).
export const resolveCustomizeChatEntry = (
  specialists: readonly SpecialistView[]
): CustomizeChatEntry => {
  const customize = specialists.find((item) => item.id === CUSTOMIZE_CHAT_SPECIALIST_ID)
  if (customize && customize.enabled) {
    return { kind: 'ready', specialistId: customize.id, prefill: buildCustomizeChatPrefill() }
  }
  return { kind: 'disabled', specialistId: CUSTOMIZE_CHAT_SPECIALIST_ID }
}
