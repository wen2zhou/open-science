import { afterEach, describe, expect, it } from 'vitest'

import {
  clearAllSkillResourceGrants,
  clearSkillResourceGrants,
  isSkillResourceGranted,
  registerSkillResourceGrant
} from './resource-capability'

afterEach(() => {
  clearSkillResourceGrants('session-a')
  clearSkillResourceGrants('session-b')
})

describe('Skill resource grants', () => {
  it('binds an exact Skill identity only to the observing Session', () => {
    expect(registerSkillResourceGrant('session-a', 'demo')).toBe(true)
    expect(isSkillResourceGranted('session-a', 'demo')).toBe(true)
    expect(isSkillResourceGranted('session-a', 'other')).toBe(false)
    expect(isSkillResourceGranted('session-b', 'demo')).toBe(false)
  })

  it('clears grants at Session teardown', () => {
    registerSkillResourceGrant('session-a', 'demo')
    clearSkillResourceGrants('session-a')
    expect(isSkillResourceGranted('session-a', 'demo')).toBe(false)
  })

  it('clears every Session grant on framework or specialist generation replacement', () => {
    registerSkillResourceGrant('session-a', 'demo-a')
    registerSkillResourceGrant('session-b', 'demo-b')
    clearAllSkillResourceGrants()
    expect(isSkillResourceGranted('session-a', 'demo-a')).toBe(false)
    expect(isSkillResourceGranted('session-b', 'demo-b')).toBe(false)
  })
})
