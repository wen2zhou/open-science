import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SpecialistPackageValidationPlan } from '../../../shared/specialist-package'
import type { SpecialistProfileView } from '../../../shared/specialist'
import { createLogger } from '../../logger'
import { SpecialistRepository } from '../repository'
import { SPECIALISTS_FILE_VERSION, type StoredSpecialist, type StoredSpecialists } from '../types'

type TransactionPhase = 'prepared' | 'committing' | 'committed' | 'rolling-back' | 'rolled-back'

type TransactionJournal = {
  transactionId: string
  phase: TransactionPhase
  specialistId: string
  beforeDigest: string
  afterDigest: string
  before: StoredSpecialists
  after: StoredSpecialists
}

const log = createLogger('specialist.package.transaction')

const documentDigest = (document: StoredSpecialists): string =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex')

export class SpecialistPackageRecoveryError extends Error {
  constructor() {
    super('Specialist package recovery failed; package mutations are blocked.')
    this.name = 'SpecialistPackageRecoveryError'
  }
}

const toView = (stored: StoredSpecialist): SpecialistProfileView => ({
  ...stored,
  displayName: stored.displayName ?? stored.name
})

export class SpecialistPackageTransaction {
  private readonly journalPath: string
  private queue: Promise<void> = Promise.resolve()
  private recoveryFailure: unknown

  constructor(
    storageDir: string,
    private readonly repository: SpecialistRepository,
    private readonly transactionId: () => string = randomUUID
  ) {
    this.journalPath = join(storageDir, 'specialist-package-transaction.json')
  }

  async recover(): Promise<void> {
    if (this.recoveryFailure) throw new SpecialistPackageRecoveryError()
    let raw: string
    try {
      raw = await readFile(this.journalPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.recoveryFailure = error
      throw new SpecialistPackageRecoveryError()
    }

    try {
      const journal = JSON.parse(raw) as TransactionJournal
      if (!journal || typeof journal.transactionId !== 'string' || !journal.before) {
        throw new Error('Invalid Specialist package transaction journal.')
      }
      if (journal.phase !== 'committed' && journal.phase !== 'rolled-back') {
        await this.repository.replaceAll(journal.before)
      }
      await rm(this.journalPath, { force: true })
      log.info('recovered specialist package transaction', {
        transactionId: journal.transactionId,
        specialistId: journal.specialistId
      })
    } catch (error) {
      this.recoveryFailure = error
      throw new SpecialistPackageRecoveryError()
    }
  }

  install(
    plan: Readonly<SpecialistPackageValidationPlan>,
    importedAt: Date,
    archiveDigest: string,
    inferredRequiresApp: string
  ): Promise<SpecialistProfileView> {
    const run = this.queue.then(async () => {
      await this.recover()
      const before = await this.repository.getAll()
      if (before.specialists.some((specialist) => specialist.id === plan.specialistId)) {
        throw new Error('Specialist overwrite requires a future explicit overwrite transaction.')
      }
      const stored: StoredSpecialist = {
        id: plan.specialistId,
        name: plan.payload.name,
        displayName: plan.payload.displayName ?? plan.payload.name,
        description: plan.payload.description,
        systemPrompt: plan.payload.systemPrompt,
        iconKey: plan.payload.iconKey,
        colorKey: plan.payload.colorKey,
        enabled: true,
        capabilityMode: plan.payload.capabilityMode,
        fullAccess: structuredClone(plan.payload.fullAccess),
        selectedCapabilities: structuredClone(plan.payload.selectedCapabilities),
        revision: 1,
        packageVersion: plan.packageVersion,
        origin: 'imported',
        ownedSkillIds: [],
        importBaseline: {
          importedAt: importedAt.toISOString(),
          archiveDigest,
          contentDigest: plan.contentHash,
          requiresApp: plan.manifest.requires_app ?? inferredRequiresApp
        }
      }
      const after: StoredSpecialists = {
        version: SPECIALISTS_FILE_VERSION,
        specialists: [...before.specialists, stored]
      }
      const journal: TransactionJournal = {
        transactionId: this.transactionId(),
        phase: 'prepared',
        specialistId: stored.id,
        beforeDigest: documentDigest(before),
        afterDigest: documentDigest(after),
        before,
        after
      }

      try {
        await this.writeJournal(journal)
        journal.phase = 'committing'
        await this.writeJournal(journal)
        await this.repository.replaceAll(after)
        journal.phase = 'committed'
        await this.writeJournal(journal)
        await rm(this.journalPath, { force: true })
        log.info('committed specialist package transaction', {
          transactionId: journal.transactionId,
          specialistId: stored.id
        })
        return toView(stored)
      } catch (error) {
        try {
          journal.phase = 'rolling-back'
          await this.writeJournal(journal)
          await this.repository.replaceAll(before)
          journal.phase = 'rolled-back'
          await this.writeJournal(journal)
          await rm(this.journalPath, { force: true })
        } catch (recoveryError) {
          this.recoveryFailure = recoveryError
        }
        throw error
      }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async writeJournal(journal: TransactionJournal): Promise<void> {
    const temporary = `${this.journalPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, 'utf8')
    await rename(temporary, this.journalPath)
  }
}
