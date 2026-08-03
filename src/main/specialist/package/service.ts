import { createHash, randomUUID } from 'node:crypto'

import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageCatalogSnapshot,
  SpecialistPackageInstallRequest,
  SpecialistPackageInstallResult,
  SpecialistPackageValidationPlan
} from '../../../shared/specialist-package'
import { SpecialistRepository } from '../repository'
import { createLogger } from '../../logger'
import { validateSpecialistZip } from './zip-adapter'
import { compareSemver } from './semver'
import { specialistPayloadContentHash } from './validator'
import {
  SpecialistPackageRecoveryError,
  SpecialistPackageRevisionConflictError,
  SpecialistPackageRollbackError,
  SpecialistPackageTransaction
} from './transaction'
import type { SpecialistPackageSkillPort } from './skill-port'

const CANDIDATE_TTL_MS = 10 * 60 * 1000
const log = createLogger('specialist.package.service')

type Candidate = {
  plan?: Readonly<SpecialistPackageValidationPlan>
  expiresAt: number
  archiveDigest: string
  installable: boolean
  archiveBytes: Uint8Array
  overwrite?: { id: string; expectedRevision: number }
}

type SpecialistPackageServiceOptions = {
  storageDir: string
  repository: SpecialistRepository
  catalog: () => Promise<SpecialistPackageCatalogSnapshot>
  token?: () => string
  now?: () => Date
  onCommitted?: () => void
  skillPort?: SpecialistPackageSkillPort
}

const inferredAppRange = (version: string): string => {
  const major = Number(version.split('.')[0] ?? 0)
  return `>=${version} <${major + 1}.0.0`
}

export class SpecialistPackageService {
  private readonly candidates = new Map<string, Candidate>()
  private readonly transaction: SpecialistPackageTransaction
  private readonly token: () => string
  private readonly now: () => Date

  constructor(private readonly options: SpecialistPackageServiceOptions) {
    this.transaction = new SpecialistPackageTransaction(
      options.storageDir,
      options.repository,
      randomUUID,
      options.skillPort
    )
    this.token = options.token ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  async preview(archiveBytes: Uint8Array): Promise<SpecialistPackageCandidatePreview> {
    // One renderer window owns one active preview. Selecting another archive invalidates the prior
    // capability immediately so stale confirmation buttons cannot replay it.
    this.candidates.clear()
    const catalog = await this.options.catalog()
    const result = validateSpecialistZip(archiveBytes, catalog)
    const token = this.token()
    const diagnostics = [...result.preview.diagnostics]
    let overwrite: SpecialistPackageCandidatePreview['overwrite']
    const installable = result.preview.installable
    let overwriteTarget: Candidate['overwrite']
    if (result.plan) {
      const existing = (await this.options.repository.getAll()).specialists.find(
        (specialist) => specialist.id === result.plan?.specialistId
      )
      if (existing) {
        overwrite = {
          id: existing.id,
          target: 'custom',
          currentVersion: existing.packageVersion,
          incomingVersion: result.plan.packageVersion,
          modifiedSinceImport:
            existing.origin === 'imported' &&
            existing.importBaseline !== undefined &&
            existing.importBaseline.contentDigest !== specialistPayloadContentHash(existing),
          hasImportBaseline: existing.origin === 'imported' && existing.importBaseline !== undefined
        }
        overwriteTarget = { id: existing.id, expectedRevision: existing.revision }
        const versionOrder = compareSemver(result.plan.packageVersion, existing.packageVersion)
        if (versionOrder === 0)
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-same-version',
            message: 'The incoming package has the same version as the installed Specialist.',
            relatedId: existing.id
          })
        if (versionOrder !== undefined && versionOrder < 0)
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-downgrade',
            message: 'The incoming package version is lower than the installed version.',
            relatedId: existing.id
          })
        if (overwrite.modifiedSinceImport)
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-local-modifications',
            message: 'Local edits differ from the imported baseline and will be replaced.',
            relatedId: existing.id
          })
        if (
          versionOrder === 0 &&
          existing.importBaseline &&
          existing.importBaseline.contentDigest !== result.plan.contentHash
        )
          diagnostics.push({
            severity: 'warning',
            code: 'specialist.overwrite-content-without-version-bump',
            message: 'Package content changed without increasing its version.',
            relatedId: existing.id
          })
      }
    }
    this.candidates.set(token, {
      plan: result.plan,
      expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
      archiveDigest: createHash('sha256').update(archiveBytes).digest('hex'),
      installable,
      archiveBytes: Uint8Array.from(archiveBytes),
      ...(overwriteTarget ? { overwrite: overwriteTarget } : {})
    })
    return {
      candidateToken: token,
      ...result.preview,
      diagnostics,
      installable,
      ...(overwrite ? { overwrite } : {})
    }
  }

  async install(request: SpecialistPackageInstallRequest): Promise<SpecialistPackageInstallResult> {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some((key) => !['candidateToken', 'confirmOverwrite'].includes(key)) ||
      typeof request.candidateToken !== 'string' ||
      !request.candidateToken ||
      (request.confirmOverwrite !== undefined && request.confirmOverwrite !== true)
    ) {
      return { status: 'failed', code: 'candidate-invalid' }
    }
    const candidate = this.candidates.get(request.candidateToken)
    if (!candidate) return { status: 'failed', code: 'stale-candidate' }
    if (candidate.expiresAt <= this.now().getTime()) {
      this.candidates.delete(request.candidateToken)
      return { status: 'failed', code: 'candidate-expired' }
    }
    if (!candidate.installable || !candidate.plan) {
      return { status: 'failed', code: 'candidate-not-installable' }
    }
    if (candidate.overwrite && request.confirmOverwrite !== true) {
      return { status: 'failed', code: 'overwrite-confirmation-required' }
    }
    this.candidates.delete(request.candidateToken)
    let specialist: Extract<SpecialistPackageInstallResult, { status: 'installed' }>['specialist']
    try {
      const catalog = await this.options.catalog()
      const liveValidation = validateSpecialistZip(candidate.archiveBytes, catalog)
      if (catalog.protectedSpecialistIds.includes(candidate.plan.specialistId)) {
        return { status: 'failed', code: 'protected-target' }
      }
      if (!liveValidation.preview.installable || !liveValidation.plan)
        return { status: 'failed', code: 'candidate-not-installable' }
      specialist = await this.transaction.install(
        liveValidation.plan,
        this.now(),
        candidate.archiveDigest,
        inferredAppRange(catalog.appVersion),
        candidate.overwrite ? { expectedRevision: candidate.overwrite.expectedRevision } : undefined
      )
    } catch (error) {
      return {
        status: 'failed',
        code:
          error instanceof SpecialistPackageRecoveryError
            ? 'recovery-failed'
            : error instanceof SpecialistPackageRevisionConflictError
              ? 'revision-conflict'
              : error instanceof SpecialistPackageRollbackError
                ? 'rollback-failed'
                : 'commit-failed'
      }
    }
    try {
      this.options.onCommitted?.()
    } catch {
      log.warn('post-commit Specialist package refresh failed', {
        code: 'package-refresh-failed',
        specialistId: specialist.id
      })
    }
    return { status: 'installed', specialist }
  }

  cancel(candidateToken: unknown): void {
    if (typeof candidateToken === 'string') this.candidates.delete(candidateToken)
  }

  dispose(): void {
    this.candidates.clear()
  }
}
