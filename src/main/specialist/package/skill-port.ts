import type { SpecialistPackageSkillPlan } from '../../../shared/specialist-package'

// The Skill Module owns its files. Package transactions can only stage an immutable plan, promote it,
// or deterministically settle/undo one transaction during normal completion and restart recovery.
export interface SpecialistPackageSkillPort {
  snapshot(): Promise<
    ReadonlyArray<{
      id: string
      version: string
      contentHash: string
      standalone: boolean
      ownerIds: readonly string[]
    }>
  >
  prepare(
    transactionId: string,
    specialistId: string,
    skills: readonly SpecialistPackageSkillPlan[]
  ): Promise<void>
  commit(transactionId: string): Promise<void>
  rollback(transactionId: string): Promise<void>
  recover(transactionId: string | undefined, outcome: 'commit' | 'rollback'): Promise<void>
  exportSnapshot?: (skillIds: readonly string[]) => Promise<
    ReadonlyArray<{
      id: string
      version: string
      contentHash: string
      files: ReadonlyArray<{ path: string; bytes: Uint8Array }>
    }>
  >
}

export const NOOP_SPECIALIST_PACKAGE_SKILL_PORT: SpecialistPackageSkillPort = {
  snapshot: async () => [],
  prepare: async () => undefined,
  commit: async () => undefined,
  rollback: async () => undefined,
  recover: async () => undefined
}
