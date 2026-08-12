// A grant is created only after the provider adapter reports a successfully loaded native Skill.
// It contains no bearer secret: callers must also own the authenticated local RPC Session context.
const sessionGrants = new Map<string, Set<string>>()

const registerSkillResourceGrant = (sessionId: string, skillId: string): boolean => {
  const grants = sessionGrants.get(sessionId) ?? new Set<string>()
  const before = grants.size
  grants.add(skillId)
  sessionGrants.set(sessionId, grants)
  return grants.size !== before
}

const isSkillResourceGranted = (sessionId: string, skillId: string): boolean =>
  sessionGrants.get(sessionId)?.has(skillId) === true

const clearSkillResourceGrants = (sessionId: string): void => {
  sessionGrants.delete(sessionId)
}

const clearAllSkillResourceGrants = (): void => {
  sessionGrants.clear()
}

export {
  clearAllSkillResourceGrants,
  clearSkillResourceGrants,
  isSkillResourceGranted,
  registerSkillResourceGrant
}
