// Application constants for the built-in Specialists (Customize and Reviewer).
//
// Built-ins are NOT persisted in the Custom `specialists` settings array; their identity comes from
// these constants so a Custom record can never impersonate or overwrite them. The Customize built-in
// backs the "Chat with agent" entry: it only carries the Customize Skill and the Specialist
// management tools, with no data Connector by default. Its instructions use the PRD's append
// semantics (additional guidance, never a replacement for the framework's base prompt).
//
// These constants live in src/shared so both the main-process Settings service (which projects the
// Settings/runtime catalog) and any renderer surface read one source of truth.

// Stable, immutable identifier for a built-in Specialist. The Customize id is also the `agentId`
// and the value stored in `disabledBuiltinSpecialistIds`; it never changes and never aliases a
// user-created Specialist.
export const CUSTOMIZE_SPECIALIST_ID = 'customize'
export const REVIEWER_SPECIALIST_ID = 'reviewer'

// A renderer-agnostic built-in Specialist definition. The main Settings service maps each of these
// onto its stored `revision`/`enabled` projection (enabled for Customize is derived from
// `disabledBuiltinSpecialistIds`; Reviewer is always enabled and controlled by Auto-review).
export type BuiltinSpecialistDefinition = {
  readonly id: string
  // Kebab-case slug used in logs, the `agentId` field, and (eventually) delegation. Matches the
  // Custom Specialist agentId validation pattern.
  readonly agentId: string
  readonly name: string
  readonly description: string
  // Append-style guidance; the framework base prompt and app safety rules always win.
  readonly instructions: string
  readonly colorKey: string
  readonly iconKey: string
  // Fixed Skill allowlist. Customize is limited to its own Customize Skill only.
  readonly skillIds: readonly string[]
  // Fixed Connector allowlist. Customize deliberately starts with no data Connector.
  readonly connectorIds: readonly string[]
}

// The Customize built-in guides the user through creating or refining a Specialist. It speaks only
// the Customize Skill and the app-owned Specialist management MCP tools; it has no data Connector
// by default, so the conversation cannot reach bundled/custom connectors.
export const CUSTOMIZE_SPECIALIST: BuiltinSpecialistDefinition = {
  id: CUSTOMIZE_SPECIALIST_ID,
  agentId: CUSTOMIZE_SPECIALIST_ID,
  name: 'Customize',
  description: 'Create and refine reusable specialists.',
  instructions: 'Help the user create or refine a specialist configuration.',
  skillIds: ['customize'],
  connectorIds: [],
  colorKey: 'purple',
  iconKey: 'brain'
}

// Reviewer is a read-only built-in shown so users understand the app already has a role-based
// capability (Auto-review). It never enters the session switcher and is always controlled by
// Auto-review, so it carries no Skill or Connector allowlist here.
export const REVIEWER_SPECIALIST: BuiltinSpecialistDefinition = {
  id: REVIEWER_SPECIALIST_ID,
  agentId: REVIEWER_SPECIALIST_ID,
  name: 'Reviewer',
  description: 'Used by Auto-review.',
  instructions: '',
  skillIds: [],
  connectorIds: [],
  colorKey: 'slate',
  iconKey: 'search'
}

// Ordered list projected by the Settings/runtime catalog. Reviewer is included so the resolver can
// fail it closed (it must never become an ordinary session binding).
export const BUILTIN_SPECIALISTS: readonly BuiltinSpecialistDefinition[] = [
  CUSTOMIZE_SPECIALIST,
  REVIEWER_SPECIALIST
]

export const findBuiltinSpecialist = (id: string): BuiltinSpecialistDefinition | undefined =>
  BUILTIN_SPECIALISTS.find((specialist) => specialist.id === id)
