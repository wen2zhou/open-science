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
import { SpecialistPackageRecoveryError, SpecialistPackageTransaction } from './transaction'

const CANDIDATE_TTL_MS = 10 * 60 * 1000
const log = createLogger('specialist.package.service')

type Candidate = {
  plan?: Readonly<SpecialistPackageValidationPlan>
  expiresAt: number
  archiveDigest: string
  installable: boolean
}

type SpecialistPackageServiceOptions = {
  storageDir: string
  repository: SpecialistRepository
  catalog: () => Promise<SpecialistPackageCatalogSnapshot>
  token?: () => string
  now?: () => Date
  onCommitted?: () => void
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
    this.transaction = new SpecialistPackageTransaction(options.storageDir, options.repository)
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
    let installable = result.preview.installable
    if (result.plan) {
      const existing = (await this.options.repository.getAll()).specialists.find(
        (specialist) => specialist.id === result.plan?.specialistId
      )
      if (existing) {
        overwrite = {
          id: existing.id,
          currentVersion: existing.packageVersion,
          incomingVersion: result.plan.packageVersion,
          modifiedSinceImport:
            existing.origin === 'imported' &&
            existing.importBaseline?.contentDigest !== result.plan.contentHash
        }
        diagnostics.push({
          severity: 'error',
          code: 'specialist.overwrite-confirmation-required',
          message:
            'This custom Specialist already exists; overwrite is not enabled in this release.',
          relatedId: existing.id
        })
        installable = false
      }
    }
    this.candidates.set(token, {
      plan: result.plan,
      expiresAt: this.now().getTime() + CANDIDATE_TTL_MS,
      archiveDigest: createHash('sha256').update(archiveBytes).digest('hex'),
      installable
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
      Object.keys(request).length !== 1 ||
      typeof request.candidateToken !== 'string' ||
      !request.candidateToken
    ) {
      return { status: 'failed', code: 'candidate-invalid' }
    }
    const candidate = this.candidates.get(request.candidateToken)
    this.candidates.delete(request.candidateToken)
    if (!candidate) return { status: 'failed', code: 'candidate-invalid' }
    if (candidate.expiresAt <= this.now().getTime()) {
      return { status: 'failed', code: 'candidate-expired' }
    }
    if (!candidate.installable || !candidate.plan) {
      return { status: 'failed', code: 'candidate-not-installable' }
    }
    let specialist: Extract<SpecialistPackageInstallResult, { status: 'installed' }>['specialist']
    try {
      const catalog = await this.options.catalog()
      specialist = await this.transaction.install(
        candidate.plan,
        this.now(),
        candidate.archiveDigest,
        inferredAppRange(catalog.appVersion)
      )
    } catch (error) {
      return {
        status: 'failed',
        code: error instanceof SpecialistPackageRecoveryError ? 'recovery-failed' : 'commit-failed'
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
