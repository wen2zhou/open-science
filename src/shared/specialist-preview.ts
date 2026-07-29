// Shared shape of a Specialist mutation preview, produced by the app-owned Specialist management
// MCP (issue 04a) and rendered as an approval card by the Chat-with-agent surface (issue 04b).
//
// The preview describes the FULL post-mutation state of a Specialist — not just the diff — so the
// user can see exactly what authorizing the change will produce. It never carries raw instruction
// text (only a length/change summary) so previews and failures cannot leak it.

export type SpecialistMutationPreview = {
  action: string
  identity: { id?: string; agentId: string; name: string }
  // Summary only — never the raw instruction text, so previews/failures cannot leak it.
  instructionsSummary: { changed: boolean; length: number }
  // The COMPLETE target Skill and Connector id sets after the mutation, not just the diff.
  skills: string[]
  connectors: string[]
  expectedRevision?: number
  // Whether existing bound sessions stay available after the change.
  affectedSessions?: { available: boolean }
  // Present for switch mutations.
  targetSessionId?: string
  // Present for switch mutations: the specialist id being switched to (or undefined for None).
  specialistId?: string
}
