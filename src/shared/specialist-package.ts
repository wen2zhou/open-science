import type {
  SpecialistCapabilityMode,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from './specialist'

export const SPECIALIST_PACKAGE_SCHEMA_VERSION = 1 as const
export const LEGACY_UNVERSIONED_SKILL_VERSION = '0.1.0' as const

export type SpecialistPackageSource = 'zip' | 'directory' | 'builtin'
export type PackageDiagnosticSeverity = 'error' | 'warning' | 'info'

export type ContributionTemplateExportResult = { saved: boolean }

export type PackageDiagnostic = {
  severity: PackageDiagnosticSeverity
  code: string
  message: string
  path?: string
  relatedId?: string
}

export type SpecialistPackageBuiltinSkillDependency = {
  id: string
  app_version: string
  compatibility: string
}

export type SpecialistPackageRequiredSkillDependency = {
  id: string
  version_range: string
}

export type SpecialistPackageBundledSkillDependency = {
  id: string
  version: string
  path: string
}

export type SpecialistPackageManifestV1 = {
  schema_version?: typeof SPECIALIST_PACKAGE_SCHEMA_VERSION
  id: string
  version: string
  exported_with_app_version?: string
  requires_app?: string
  skills: {
    builtin: SpecialistPackageBuiltinSkillDependency[]
    required: SpecialistPackageRequiredSkillDependency[]
    bundled: SpecialistPackageBundledSkillDependency[]
  }
}

export type SpecialistPackagePayload = {
  name: string
  displayName?: string
  description: string
  systemPrompt: string
  iconKey?: string
  colorKey?: string
  capabilityMode: SpecialistCapabilityMode
  fullAccess: SpecialistFullAccessConfig
  selectedCapabilities: SpecialistSelectedConfig
}

export type SpecialistPackageCatalogSnapshot = {
  appVersion: string
  builtinSkills: ReadonlyArray<{ id: string; appVersion: string; compatibility: string }>
  skills: ReadonlyArray<{
    id: string
    version?: string
    builtin: boolean
    contentDigest?: string
  }>
  connectorIds: readonly string[]
  protectedSpecialistIds: readonly string[]
}

export type SpecialistPackageSummary = {
  id: string
  version: string
  name: string
  description: string
  source: SpecialistPackageSource
  requiresApp?: string
  bundledSkillIds: readonly string[]
  requiredSkillIds: readonly string[]
  builtinSkillIds: readonly string[]
  connectorIds: readonly string[]
}

export type SpecialistPackagePreview = {
  summary?: SpecialistPackageSummary
  diagnostics: readonly PackageDiagnostic[]
  installable: boolean
}

export type SpecialistPackageCandidatePreview = SpecialistPackagePreview & {
  candidateToken: string
  overwrite?: {
    id: string
    target: 'custom'
    currentVersion: string
    incomingVersion: string
    modifiedSinceImport: boolean
    hasImportBaseline: boolean
  }
}

export type SpecialistPackageInstallRequest = {
  candidateToken: string
  confirmOverwrite?: true
}

export type SpecialistPackageInstallResult =
  | { status: 'installed'; specialist: import('./specialist').SpecialistProfileView }
  | {
      status: 'failed'
      code:
        | 'candidate-invalid'
        | 'candidate-expired'
        | 'stale-candidate'
        | 'candidate-not-installable'
        | 'overwrite-confirmation-required'
        | 'revision-conflict'
        | 'protected-target'
        | 'recovery-failed'
        | 'rollback-failed'
        | 'commit-failed'
    }

export type SpecialistPackageValidationPlan = {
  specialistId: string
  packageVersion: string
  source: SpecialistPackageSource
  contentHash: string
  manifest: SpecialistPackageManifestV1
  payload: SpecialistPackagePayload
}

export type SpecialistPackageValidationResult = {
  preview: SpecialistPackagePreview
  plan?: Readonly<SpecialistPackageValidationPlan>
}

export type BuiltinSpecialistRegistryEntry = SpecialistPackagePayload & {
  kind: 'builtin'
  readonly: true
  enabled: true
  id: string
  version: string
}

export type BuiltinSpecialistRegistryResult = {
  entries: readonly BuiltinSpecialistRegistryEntry[]
  diagnostics: readonly PackageDiagnostic[]
}
