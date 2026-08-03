import { createHash } from 'node:crypto'

import {
  LEGACY_UNVERSIONED_SKILL_VERSION,
  SPECIALIST_PACKAGE_SCHEMA_VERSION,
  type PackageDiagnostic,
  type SpecialistPackageBundledSkillDependency,
  type SpecialistPackageBuiltinSkillDependency,
  type SpecialistPackageCatalogSnapshot,
  type SpecialistPackageManifestV1,
  type SpecialistPackagePayload,
  type SpecialistPackageRequiredSkillDependency,
  type SpecialistPackageSkillPlan,
  type SpecialistPackageSource,
  type SpecialistPackageValidationPlan,
  type SpecialistPackageValidationResult
} from '../../../shared/specialist-package'
import type {
  ConnectorToolRule,
  SpecialistFullAccessConfig,
  SpecialistSelectedConfig
} from '../../../shared/specialist'
import { isValidSemverRange, satisfiesSemverRange } from './semver'

export type SpecialistPackageFile = { path: string; bytes: Uint8Array }

const decoder = new TextDecoder('utf-8', { fatal: true })
const SAFE_ID = /^[a-z0-9-]+$/
const RESERVED_ID_PREFIXES = ['os-', 'mcp-'] as const
const isSafeContributionId = (value: string): boolean =>
  SAFE_ID.test(value) && !RESERVED_ID_PREFIXES.some((prefix) => value.startsWith(prefix))
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const diagnostic = (
  diagnostics: PackageDiagnostic[],
  code: string,
  message: string,
  path: string,
  relatedId?: string
): void => {
  diagnostics.push({ severity: 'error', code, message, path, ...(relatedId ? { relatedId } : {}) })
}

const warning = (
  diagnostics: PackageDiagnostic[],
  code: string,
  message: string,
  path: string,
  relatedId?: string
): void => {
  diagnostics.push({
    severity: 'warning',
    code,
    message,
    path,
    ...(relatedId ? { relatedId } : {})
  })
}

const parseJson = (
  file: SpecialistPackageFile,
  diagnostics: PackageDiagnostic[]
): unknown | undefined => {
  try {
    return JSON.parse(decoder.decode(file.bytes)) as unknown
  } catch {
    diagnostic(
      diagnostics,
      'package.json-invalid',
      'The file must contain valid UTF-8 JSON.',
      file.path
    )
    return undefined
  }
}

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : undefined

const parseConnectorRules = (value: unknown): ConnectorToolRule[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const result: ConnectorToolRule[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.connectorId !== 'string') return undefined
    const allowed = new Set([
      'connectorId',
      'includedMethods',
      'excludedMethods',
      'includeToolsPattern',
      'excludeToolsPattern'
    ])
    if (Object.keys(candidate).some((key) => !allowed.has(key))) return undefined
    const includedMethods =
      candidate.includedMethods === undefined ? undefined : stringArray(candidate.includedMethods)
    const excludedMethods =
      candidate.excludedMethods === undefined ? undefined : stringArray(candidate.excludedMethods)
    if (
      (candidate.includedMethods !== undefined && includedMethods === undefined) ||
      (candidate.excludedMethods !== undefined && excludedMethods === undefined) ||
      (candidate.includeToolsPattern !== undefined &&
        typeof candidate.includeToolsPattern !== 'string') ||
      (candidate.excludeToolsPattern !== undefined &&
        typeof candidate.excludeToolsPattern !== 'string')
    ) {
      return undefined
    }
    result.push({
      connectorId: candidate.connectorId,
      ...(includedMethods ? { includedMethods } : {}),
      ...(excludedMethods ? { excludedMethods } : {}),
      ...(typeof candidate.includeToolsPattern === 'string'
        ? { includeToolsPattern: candidate.includeToolsPattern }
        : {}),
      ...(typeof candidate.excludeToolsPattern === 'string'
        ? { excludeToolsPattern: candidate.excludeToolsPattern }
        : {})
    })
  }
  return result
}

const parseFullAccess = (value: unknown): SpecialistFullAccessConfig | undefined => {
  if (!isRecord(value)) return undefined
  const excludedSkillIds = stringArray(value.excludedSkillIds)
  const excludedConnectorIds = stringArray(value.excludedConnectorIds)
  const connectorTools = parseConnectorRules(value.connectorTools)
  if (!excludedSkillIds || !excludedConnectorIds || !connectorTools) return undefined
  return { excludedSkillIds, excludedConnectorIds, connectorTools }
}

const parseSelected = (value: unknown): SpecialistSelectedConfig | undefined => {
  if (!isRecord(value)) return undefined
  const skillIds = stringArray(value.skillIds)
  const connectorIds = stringArray(value.connectorIds)
  const connectorTools = parseConnectorRules(value.connectorTools)
  if (!skillIds || !connectorIds || !connectorTools) return undefined
  return { skillIds, connectorIds, connectorTools }
}

const parseDependencyArray = <T>(
  value: unknown,
  parseEntry: (entry: Record<string, unknown>) => T | undefined
): T[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const parsed: T[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const entry = parseEntry(candidate)
    if (!entry) return undefined
    parsed.push(entry)
  }
  return parsed
}

const parseManifest = (
  value: unknown,
  diagnostics: PackageDiagnostic[]
): SpecialistPackageManifestV1 | undefined => {
  if (!isRecord(value)) {
    diagnostic(
      diagnostics,
      'manifest.object-required',
      'Manifest must be a JSON object.',
      'manifest.json'
    )
    return undefined
  }
  if (
    value.schema_version !== undefined &&
    value.schema_version !== SPECIALIST_PACKAGE_SCHEMA_VERSION
  ) {
    diagnostic(
      diagnostics,
      'manifest.schema-version-unsupported',
      'The declared package schema version is not supported.',
      'manifest.json'
    )
  }
  if (value.schema_version === undefined) {
    warning(
      diagnostics,
      'manifest.schema-version-missing',
      'schema_version is missing; the current package schema was used.',
      'manifest.json'
    )
  }
  const id = typeof value.id === 'string' && isSafeContributionId(value.id) ? value.id : undefined
  if (!id) diagnostic(diagnostics, 'manifest.id-invalid', 'Package ID is invalid.', 'manifest.json')
  const version =
    typeof value.version === 'string' && SEMVER.test(value.version) ? value.version : undefined
  if (!version)
    diagnostic(
      diagnostics,
      'manifest.version-invalid',
      'Package version must be SemVer.',
      'manifest.json'
    )
  const exportedWithAppVersion =
    value.exported_with_app_version === undefined ||
    (typeof value.exported_with_app_version === 'string' &&
      SEMVER.test(value.exported_with_app_version))
      ? value.exported_with_app_version
      : null
  if (exportedWithAppVersion === null) {
    diagnostic(
      diagnostics,
      'manifest.exported-app-version-invalid',
      'Exporting application version must be SemVer.',
      'manifest.json'
    )
  }
  const requiresApp =
    value.requires_app === undefined ||
    (typeof value.requires_app === 'string' && isValidSemverRange(value.requires_app))
      ? value.requires_app
      : null
  if (requiresApp === null) {
    diagnostic(
      diagnostics,
      'manifest.requires-app-invalid',
      'Application compatibility must be a SemVer range.',
      'manifest.json'
    )
  }
  const skills = isRecord(value.skills) ? value.skills : undefined
  if (!skills) {
    diagnostic(diagnostics, 'manifest.skills-invalid', 'Skills must be an object.', 'manifest.json')
    return undefined
  }
  const builtin = parseDependencyArray<SpecialistPackageBuiltinSkillDependency>(
    skills.builtin,
    (entry) =>
      typeof entry.id === 'string' &&
      isSafeContributionId(entry.id) &&
      typeof entry.app_version === 'string' &&
      SEMVER.test(entry.app_version) &&
      typeof entry.compatibility === 'string'
        ? { id: entry.id, app_version: entry.app_version, compatibility: entry.compatibility }
        : undefined
  )
  if (!builtin) {
    diagnostic(
      diagnostics,
      'manifest.skills-builtin-invalid',
      'Builtin Skill dependencies are invalid.',
      'manifest.json'
    )
  }
  const required = parseDependencyArray<SpecialistPackageRequiredSkillDependency>(
    skills.required,
    (entry) =>
      typeof entry.id === 'string' &&
      isSafeContributionId(entry.id) &&
      typeof entry.version_range === 'string' &&
      isValidSemverRange(entry.version_range)
        ? { id: entry.id, version_range: entry.version_range }
        : undefined
  )
  if (!required) {
    diagnostic(
      diagnostics,
      'manifest.skills-required-invalid',
      'Required Skill dependencies are invalid.',
      'manifest.json'
    )
  }
  const bundled = parseDependencyArray<SpecialistPackageBundledSkillDependency>(
    skills.bundled,
    (entry) =>
      typeof entry.id === 'string' &&
      isSafeContributionId(entry.id) &&
      typeof entry.version === 'string' &&
      SEMVER.test(entry.version) &&
      typeof entry.path === 'string'
        ? { id: entry.id, version: entry.version, path: entry.path }
        : undefined
  )
  if (!bundled) {
    diagnostic(
      diagnostics,
      'manifest.skills-bundled-invalid',
      'Bundled Skill dependencies are invalid.',
      'manifest.json'
    )
  }
  if (
    !id ||
    !version ||
    exportedWithAppVersion === null ||
    requiresApp === null ||
    !builtin ||
    !required ||
    !bundled
  ) {
    return undefined
  }
  return {
    schema_version: SPECIALIST_PACKAGE_SCHEMA_VERSION,
    id,
    version,
    ...(typeof exportedWithAppVersion === 'string'
      ? { exported_with_app_version: exportedWithAppVersion }
      : {}),
    ...(typeof requiresApp === 'string' ? { requires_app: requiresApp } : {}),
    skills: { builtin, required, bundled }
  }
}

const parsePayload = (
  value: unknown,
  diagnostics: PackageDiagnostic[]
): SpecialistPackagePayload | undefined => {
  if (!isRecord(value)) {
    diagnostic(
      diagnostics,
      'specialist.object-required',
      'Specialist payload must be a JSON object.',
      'specialist.json'
    )
    return undefined
  }
  const allowedFields = new Set([
    'id',
    'version',
    'name',
    'displayName',
    'description',
    'systemPrompt',
    'iconKey',
    'colorKey',
    'capabilityMode',
    'fullAccess',
    'selectedCapabilities'
  ])
  const hasForbiddenField = Object.keys(value).some((key) => !allowedFields.has(key))
  if (hasForbiddenField) {
    diagnostic(
      diagnostics,
      'specialist.field-forbidden',
      'The Specialist payload contains a forbidden field.',
      'specialist.json'
    )
  }
  if ('id' in value || 'version' in value) {
    diagnostic(
      diagnostics,
      'specialist.identity-field-forbidden',
      'Specialist identity and package version belong only in manifest.json.',
      'specialist.json'
    )
  }
  if ('enabled' in value) {
    diagnostic(
      diagnostics,
      'specialist.enabled-field-forbidden',
      'Installed Specialists are always enabled initially; packages cannot control this state.',
      'specialist.json'
    )
  }
  const name = typeof value.name === 'string' && value.name.trim() ? value.name : undefined
  if (!name)
    diagnostic(
      diagnostics,
      'specialist.name-invalid',
      'Specialist name is invalid.',
      'specialist.json'
    )
  const description = typeof value.description === 'string' ? value.description : undefined
  if (description === undefined)
    diagnostic(
      diagnostics,
      'specialist.description-invalid',
      'Specialist description must be a string.',
      'specialist.json'
    )
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt : undefined
  if (systemPrompt === undefined)
    diagnostic(
      diagnostics,
      'specialist.system-prompt-invalid',
      'Specialist system prompt must be a string.',
      'specialist.json'
    )
  const capabilityMode =
    value.capabilityMode === 'full' || value.capabilityMode === 'selected'
      ? value.capabilityMode
      : undefined
  if (!capabilityMode)
    diagnostic(
      diagnostics,
      'specialist.capability-mode-invalid',
      'Specialist capability mode is invalid.',
      'specialist.json'
    )
  const fullAccess = parseFullAccess(value.fullAccess)
  if (!fullAccess)
    diagnostic(
      diagnostics,
      'specialist.full-access-invalid',
      'Full-access capability rules are invalid.',
      'specialist.json'
    )
  const selectedCapabilities = parseSelected(value.selectedCapabilities)
  if (!selectedCapabilities)
    diagnostic(
      diagnostics,
      'specialist.selected-capabilities-invalid',
      'Selected capability rules are invalid.',
      'specialist.json'
    )
  if (
    !name ||
    description === undefined ||
    systemPrompt === undefined ||
    !capabilityMode ||
    !fullAccess ||
    !selectedCapabilities ||
    hasForbiddenField ||
    'id' in value ||
    'version' in value ||
    'enabled' in value
  ) {
    return undefined
  }
  return {
    name,
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    description,
    systemPrompt,
    ...(typeof value.iconKey === 'string' ? { iconKey: value.iconKey } : {}),
    ...(typeof value.colorKey === 'string' ? { colorKey: value.colorKey } : {}),
    capabilityMode,
    fullAccess,
    selectedCapabilities
  }
}

export const specialistPayloadContentHash = (payload: SpecialistPackagePayload): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        name: payload.name,
        displayName: payload.displayName ?? payload.name,
        description: payload.description,
        systemPrompt: payload.systemPrompt,
        iconKey: payload.iconKey,
        colorKey: payload.colorKey,
        capabilityMode: payload.capabilityMode,
        fullAccess: payload.fullAccess,
        selectedCapabilities: payload.selectedCapabilities
      })
    )
    .digest('hex')

const filesContentHash = (files: readonly SpecialistPackageFile[]): string => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

const bundledSkillHash = (files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string =>
  filesContentHash(files)

const planBundledSkills = (
  manifest: SpecialistPackageManifestV1,
  packageFiles: readonly SpecialistPackageFile[],
  catalog: SpecialistPackageCatalogSnapshot,
  diagnostics: PackageDiagnostic[]
): SpecialistPackageSkillPlan[] => {
  const plans: SpecialistPackageSkillPlan[] = []
  const declaredPaths = new Set<string>()
  const builtinIds = new Set(catalog.builtinSkills.map((skill) => skill.id))

  for (const bundled of manifest.skills.bundled) {
    const canonicalPath = `skills/${bundled.id}`
    if (bundled.path !== canonicalPath) {
      diagnostic(
        diagnostics,
        'skill.path-noncanonical',
        'Bundled Skill path must map canonically from its global ID.',
        'manifest.json',
        bundled.id
      )
      continue
    }
    if (builtinIds.has(bundled.id)) {
      diagnostic(
        diagnostics,
        'skill.builtin-id-protected',
        'A bundled Skill cannot use a builtin Skill ID.',
        'manifest.json',
        bundled.id
      )
      continue
    }
    if (declaredPaths.has(bundled.path)) {
      diagnostic(
        diagnostics,
        'skill.path-duplicate',
        'Bundled Skill paths must be unique.',
        'manifest.json',
        bundled.id
      )
      continue
    }
    declaredPaths.add(bundled.path)
    const prefix = `${bundled.path}/`
    const files = packageFiles
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes }))
      .sort((left, right) => {
        if (left.path === 'SKILL.md') return -1
        if (right.path === 'SKILL.md') return 1
        return left.path.localeCompare(right.path)
      })
    if (!files.some((file) => file.path === 'SKILL.md')) {
      diagnostic(
        diagnostics,
        'skill.document-missing',
        'A bundled Skill must contain SKILL.md.',
        bundled.path,
        bundled.id
      )
      continue
    }
    const standardRoots = new Set(['scripts', 'references', 'assets', 'templates'])
    const unsupported = files.find((file) => {
      if (file.path === 'SKILL.md') return false
      const [root] = file.path.split('/')
      return !standardRoots.has(root)
    })
    if (unsupported) {
      diagnostic(
        diagnostics,
        'skill.layout-invalid',
        'Bundled Skill files must use the standard Skill directory layout.',
        `${bundled.path}/${unsupported.path}`,
        bundled.id
      )
      continue
    }
    if (files.some((file) => file.path.startsWith('scripts/'))) {
      warning(
        diagnostics,
        'skill.executable-content-present',
        'This Skill contains scripts. Preview and validation do not execute them.',
        bundled.path,
        bundled.id
      )
    }
    const digest = bundledSkillHash(files)
    const existing = catalog.skills.find((skill) => skill.id === bundled.id)
    let disposition: SpecialistPackageSkillPlan['disposition'] = 'install'
    let reason: string | undefined
    if (existing) {
      const existingVersion = existing.version ?? LEGACY_UNVERSIONED_SKILL_VERSION
      if (
        existing.builtin ||
        existingVersion !== bundled.version ||
        existing.contentHash !== digest
      ) {
        disposition = 'conflict'
        reason = existing.builtin
          ? 'The ID belongs to a builtin Skill.'
          : 'The installed Skill version or normalized content differs.'
        diagnostic(
          diagnostics,
          existing.builtin ? 'skill.builtin-id-protected' : 'skill.existing-conflict',
          reason,
          'manifest.json',
          bundled.id
        )
      } else if (existing.standalone !== false && !existing.ownerIds?.length) {
        disposition = 'reuse-standalone'
        reason = 'An identical standalone Skill is already installed.'
      } else {
        disposition = 'reuse-owned'
        reason = 'An identical Specialist-owned Skill is already installed.'
      }
    }
    const required = manifest.skills.required.find((entry) => entry.id === bundled.id)
    plans.push({
      id: bundled.id,
      version: bundled.version,
      ...(required ? { versionRange: required.version_range } : {}),
      disposition,
      files: files.map((file) => file.path),
      ...(reason ? { reason } : {}),
      contentHash: digest,
      filesToInstall: files
    })
  }

  for (const file of packageFiles.filter((candidate) => candidate.path.startsWith('skills/'))) {
    if (![...declaredPaths].some((path) => file.path.startsWith(`${path}/`))) {
      diagnostic(
        diagnostics,
        'skill.undeclared-content',
        'Every bundled Skill directory must be declared in manifest.json.',
        file.path
      )
    }
  }
  return plans
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  if (ArrayBuffer.isView(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export const validateSpecialistPackage = (
  files: readonly SpecialistPackageFile[],
  _catalog: SpecialistPackageCatalogSnapshot,
  source: SpecialistPackageSource
): SpecialistPackageValidationResult => {
  const diagnostics: PackageDiagnostic[] = []
  const isNoise = (path: string): boolean =>
    path === '.DS_Store' ||
    path.endsWith('/.DS_Store') ||
    path === 'Thumbs.db' ||
    path.startsWith('__MACOSX/')
  const packageFiles = files.filter((file) => !isNoise(file.path))
  for (const file of files.filter((candidate) => isNoise(candidate.path))) {
    diagnostics.push({
      severity: 'info',
      code: 'package.metadata-noise-ignored',
      message: 'Known archive metadata was ignored.',
      path: file.path
    })
  }
  const allowedTopLevel = new Set([
    'manifest.json',
    'specialist.json',
    'README.md',
    'LICENSE',
    'skills'
  ])
  for (const file of packageFiles) {
    const topLevel = file.path.split('/')[0]
    if (!allowedTopLevel.has(topLevel)) {
      diagnostic(
        diagnostics,
        'package.top-level-content-forbidden',
        'The package contains unsupported top-level content.',
        file.path
      )
    }
  }
  const manifestFile = packageFiles.find((file) => file.path === 'manifest.json')
  const specialistFile = packageFiles.find((file) => file.path === 'specialist.json')
  if (!manifestFile)
    diagnostic(
      diagnostics,
      'package.required-file-missing',
      'The package must contain manifest.json.',
      'manifest.json'
    )
  if (!specialistFile)
    diagnostic(
      diagnostics,
      'package.required-file-missing',
      'The package must contain specialist.json.',
      'specialist.json'
    )

  const manifest = manifestFile
    ? parseManifest(parseJson(manifestFile, diagnostics), diagnostics)
    : undefined
  const payload = specialistFile
    ? parsePayload(parseJson(specialistFile, diagnostics), diagnostics)
    : undefined
  const connectorIds = payload
    ? [
        ...(payload.capabilityMode === 'selected' ? payload.selectedCapabilities.connectorIds : []),
        ...(payload.capabilityMode === 'selected'
          ? payload.selectedCapabilities.connectorTools
          : payload.fullAccess.connectorTools
        ).map((rule) => rule.connectorId)
      ].filter((id, index, all) => all.indexOf(id) === index)
    : []
  for (const connectorId of connectorIds) {
    if (!_catalog.connectorIds.includes(connectorId)) {
      warning(
        diagnostics,
        'connector.unavailable',
        'A referenced Connector is not available in this application.',
        'specialist.json',
        connectorId
      )
    }
  }
  if (
    manifest?.requires_app &&
    satisfiesSemverRange(_catalog.appVersion, manifest.requires_app) === false
  ) {
    diagnostic(
      diagnostics,
      'compatibility.app-incompatible',
      'This package is not compatible with the current application version.',
      'manifest.json',
      _catalog.appVersion
    )
  }
  if (manifest && manifest.requires_app === undefined) {
    warning(
      diagnostics,
      'compatibility.app-range-missing',
      'Application compatibility is not declared; the current version will be inferred.',
      'manifest.json',
      _catalog.appVersion
    )
  }
  if (manifest) {
    if (_catalog.protectedSpecialistIds.includes(manifest.id)) {
      diagnostic(
        diagnostics,
        'specialist.id-protected',
        'The Specialist ID is reserved and cannot be contributed.',
        'manifest.json',
        manifest.id
      )
    }
    if (source === 'builtin') {
      if (
        manifest.skills.bundled.length > 0 ||
        packageFiles.some((file) => file.path === 'skills' || file.path.startsWith('skills/'))
      ) {
        diagnostic(
          diagnostics,
          'builtin.bundled-skills-forbidden',
          'Builtin Specialist packages cannot bundle Skills.',
          'manifest.json'
        )
      }
      for (const dependency of manifest.skills.required) {
        diagnostic(
          diagnostics,
          'builtin.non-builtin-dependency-forbidden',
          'Builtin Specialist packages may depend only on builtin Skills.',
          'manifest.json',
          dependency.id
        )
      }
    }
    for (const dependency of manifest.skills.builtin) {
      const available = _catalog.builtinSkills.find((skill) => skill.id === dependency.id)
      if (!available) {
        diagnostic(
          diagnostics,
          'dependency.builtin-skill-missing',
          'A required builtin Skill is unavailable.',
          'manifest.json',
          dependency.id
        )
      } else if (available.compatibility !== dependency.compatibility) {
        diagnostic(
          diagnostics,
          'dependency.builtin-skill-incompatible',
          'A builtin Skill has an incompatible identity.',
          'manifest.json',
          dependency.id
        )
      }
    }
    for (const dependency of manifest.skills.required) {
      const bundled = manifest.skills.bundled.find((skill) => skill.id === dependency.id)
      const installed = _catalog.skills.find(
        (skill) => skill.id === dependency.id && !skill.builtin
      )
      const actualVersion =
        bundled?.version ??
        installed?.version ??
        (installed ? LEGACY_UNVERSIONED_SKILL_VERSION : undefined)
      if (!actualVersion) {
        diagnostic(
          diagnostics,
          'dependency.skill-missing',
          'A required Skill is not installed or bundled.',
          'manifest.json',
          dependency.id
        )
      } else if (satisfiesSemverRange(actualVersion, dependency.version_range) !== true) {
        diagnostic(
          diagnostics,
          'dependency.skill-incompatible',
          'An installed Skill does not satisfy the required version range.',
          'manifest.json',
          dependency.id
        )
      }
    }
    for (const bundled of manifest.skills.bundled) {
      const installed = _catalog.skills.find((skill) => skill.id === bundled.id)
      if (!installed) continue
      const bundledFiles = packageFiles.filter(
        (file) => file.path === bundled.path || file.path.startsWith(`${bundled.path}/`)
      )
      const bundledDigest = filesContentHash(bundledFiles)
      if (
        installed.builtin ||
        installed.version !== bundled.version ||
        (installed.contentDigest !== undefined && installed.contentDigest !== bundledDigest)
      ) {
        diagnostic(
          diagnostics,
          installed.builtin
            ? 'dependency.bundled-skill-protected'
            : 'dependency.bundled-skill-conflict',
          installed.builtin
            ? 'A bundled Skill uses a protected builtin Skill ID.'
            : 'An installed Skill with this ID has a different version or content digest.',
          bundled.path,
          bundled.id
        )
      }
    }
  }
  const skillPlans = manifest
    ? planBundledSkills(manifest, packageFiles, _catalog, diagnostics)
    : []
  const summary =
    manifest && payload
      ? {
          id: manifest.id,
          version: manifest.version,
          name: payload.name,
          description: payload.description,
          source,
          ...(manifest.requires_app === undefined ? {} : { requiresApp: manifest.requires_app }),
          bundledSkillIds: manifest.skills.bundled.map((skill) => skill.id),
          requiredSkillIds: manifest.skills.required.map((skill) => skill.id),
          builtinSkillIds: manifest.skills.builtin.map((skill) => skill.id),
          connectorIds,
          skills: skillPlans.map((skill) => ({
            id: skill.id,
            version: skill.version,
            ...(skill.versionRange ? { versionRange: skill.versionRange } : {}),
            disposition: skill.disposition,
            files: skill.files,
            ...(skill.reason ? { reason: skill.reason } : {})
          }))
        }
      : undefined
  if (diagnostics.some((item) => item.severity === 'error') || !manifest || !payload) {
    return { preview: { ...(summary ? { summary } : {}), diagnostics, installable: false } }
  }
  const plan: SpecialistPackageValidationPlan = {
    specialistId: manifest.id,
    packageVersion: manifest.version,
    source,
    contentHash: specialistPayloadContentHash(payload),
    manifest,
    payload,
    skills: skillPlans
  }
  deepFreeze(plan)
  return { preview: { summary, diagnostics, installable: true }, plan }
}
