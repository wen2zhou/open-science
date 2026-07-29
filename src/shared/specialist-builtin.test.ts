import { describe, expect, it } from 'vitest'

import {
  BUILTIN_SPECIALISTS,
  CUSTOMIZE_SPECIALIST,
  CUSTOMIZE_SPECIALIST_ID,
  REVIEWER_SPECIALIST,
  REVIEWER_SPECIALIST_ID,
  findBuiltinSpecialist
} from './specialist-builtin'

describe('built-in specialist constants', () => {
  it('exposes the Customize built-in with only the Customize Skill and no data Connector', () => {
    expect(CUSTOMIZE_SPECIALIST.id).toBe(CUSTOMIZE_SPECIALIST_ID)
    expect(CUSTOMIZE_SPECIALIST.agentId).toBe('customize')
    expect(CUSTOMIZE_SPECIALIST.skillIds).toEqual(['customize'])
    // Customize never carries a data Connector by default.
    expect(CUSTOMIZE_SPECIALIST.connectorIds).toEqual([])
  })

  it('keeps the Customize id equal to its kebab-case agentId', () => {
    expect(CUSTOMIZE_SPECIALIST.id).toBe(CUSTOMIZE_SPECIALIST.agentId)
    // kebab-case slug only.
    expect(CUSTOMIZE_SPECIALIST.agentId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  it('ships append-style Customize instructions (non-empty guidance, not a full prompt)', () => {
    expect(CUSTOMIZE_SPECIALIST.instructions.trim().length).toBeGreaterThan(0)
  })

  it('lists Customize before Reviewer and includes both in the catalog', () => {
    expect(BUILTIN_SPECIALISTS.map((s) => s.id)).toEqual(['customize', 'reviewer'])
    expect(REVIEWER_SPECIALIST.id).toBe(REVIEWER_SPECIALIST_ID)
  })

  it('finds built-ins by id and returns undefined for unknown ids', () => {
    expect(findBuiltinSpecialist('customize')?.name).toBe('Customize')
    expect(findBuiltinSpecialist('reviewer')?.name).toBe('Reviewer')
    expect(findBuiltinSpecialist('does-not-exist')).toBeUndefined()
  })

  it('does not define an unrestricted mode for any built-in', () => {
    // No built-in advertises an "all"/"unrestricted" capability switch; allowlists are fixed sets.
    for (const specialist of BUILTIN_SPECIALISTS) {
      expect(Array.isArray(specialist.skillIds)).toBe(true)
      expect(Array.isArray(specialist.connectorIds)).toBe(true)
    }
  })
})
