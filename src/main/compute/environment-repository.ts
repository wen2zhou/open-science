import type { ComputeEnvironment as PrismaComputeEnvironment, PrismaClient } from '@prisma/client'

import type {
  ComputeEnvironment,
  ComputeEnvironmentStatus,
  ComputeEnvironmentVisibility,
  EnvironmentResolution,
  EnvironmentSpec,
  EnvironmentValidationEvidence,
  UpsertComputeEnvironmentRequest
} from '../../shared/compute-environment'
import {
  ComputeEnvironmentResolutionSchema,
  ComputeEnvironmentSpecSchema
} from '../../shared/compute-environment'
import { computeSpecHash } from './spec-hash'

// Only the computeEnvironment delegate is needed; typing to this subset keeps the repository unit-
// testable with a lightweight mock (aligns with the host/job repositories).
type ComputeEnvironmentClient = Pick<PrismaClient, 'computeEnvironment'>
type ComputeEnvironmentClientProvider = () => Promise<ComputeEnvironmentClient>

// JSON columns parse defensively: a corrupt value degrades to undefined rather than throwing, so one
// bad row cannot break loading the whole environment list (design.md §10 compatibility).
const parseJson = <T>(value: string | null): T | undefined => {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

const asStatus = (value: string): ComputeEnvironmentStatus => {
  const valid: ComputeEnvironmentStatus[] = [
    'draft',
    'building',
    'validating',
    'ready',
    'failed',
    'stale'
  ]
  return valid.includes(value as ComputeEnvironmentStatus)
    ? (value as ComputeEnvironmentStatus)
    : 'draft'
}

const asVisibility = (value: string): ComputeEnvironmentVisibility =>
  value === 'project' ? 'project' : 'provider'

// Maps a Prisma row (JSON strings + DateTime + nullable columns) into the epoch-ms domain shape shared
// with the renderer. spec/resolution/validation are parsed back to their typed shapes; a corrupt row
// degrades to undefined so the renderer never crashes.
const toEnvironment = (row: PrismaComputeEnvironment): ComputeEnvironment => {
  const spec = parseJson<unknown>(row.specJson)
  const resolution = parseJson<unknown>(row.resolutionJson)
  const validation = parseJson<EnvironmentValidationEvidence>(row.validationJson)
  // Re-validate defensively: a legacy/seed row or a corrupt JSON degrades to undefined rather than
  // surfacing an invalid shape (design.md §10 — a bad row must not break loading).
  const specParsed = spec ? ComputeEnvironmentSpecSchema.safeParse(spec) : undefined
  const resolutionParsed = resolution
    ? ComputeEnvironmentResolutionSchema.safeParse(resolution)
    : undefined
  return {
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    visibility: asVisibility(row.visibility),
    specHash: row.specHash,
    spec: specParsed?.success ? specParsed.data : undefined,
    resolution: resolutionParsed?.success ? resolutionParsed.data : undefined,
    status: asStatus(row.status),
    buildJobId: row.buildJobId ?? undefined,
    validation: validation ?? undefined,
    validatedAt: row.validatedAt?.getTime(),
    detailsDoc: row.detailsDoc,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

export type CreateEnvironmentRequest = UpsertComputeEnvironmentRequest & {
  initialStatus?: ComputeEnvironmentStatus
  buildJobId?: string
}

export type UpdateEnvironmentRequest = {
  name?: string
  visibility?: ComputeEnvironmentVisibility
  spec?: EnvironmentSpec
  resolution?: EnvironmentResolution
  status?: ComputeEnvironmentStatus
  buildJobId?: string | null
  detailsDoc?: string
}

// Owns ComputeEnvironment reads/writes (design.md §8). Follows the same lazy-provider pattern as the
// host and job repositories. The repository is the resolution authority: it validates spec/resolution
// shapes defensively on read and recomputes specHash on every spec change so a changed spec always
// makes the environment stale (design.md §8.2 / §8.3 — cross-cutting: registry updates must prevent
// concurrent reuse of an old ready record).
export class ComputeEnvironmentRepository {
  constructor(private readonly getClient: ComputeEnvironmentClientProvider) {}

  // Creates a registry record. spec/resolution are serialized to canonical JSON; specHash is computed
  // from the spec so staleness is detectable later. The unique (providerId, name) index is the
  // authoritative guard; we pre-check for a readable duplicate error.
  async create(request: CreateEnvironmentRequest): Promise<ComputeEnvironment> {
    const client = await this.getClient()
    const specJson = JSON.stringify(request.spec)
    const specHash = computeSpecHash(request.spec)
    const resolutionJson = JSON.stringify(request.resolution)

    const existing = await client.computeEnvironment.findUnique({
      where: { providerId_name: { providerId: request.providerId, name: request.name } }
    })
    if (existing) {
      throw new Error(
        `An environment named "${request.name}" is already registered for provider "${request.providerId}".`
      )
    }

    const row = await client.computeEnvironment.create({
      data: {
        providerId: request.providerId,
        name: request.name,
        visibility: request.visibility ?? 'provider',
        specJson,
        specHash,
        resolutionJson,
        status: request.initialStatus ?? 'draft',
        buildJobId: request.buildJobId,
        detailsDoc: request.detailsDoc ?? ''
      }
    })
    return toEnvironment(row)
  }

  async get(id: string): Promise<ComputeEnvironment | null> {
    const client = await this.getClient()
    const row = await client.computeEnvironment.findUnique({ where: { id } })
    return row ? toEnvironment(row) : null
  }

  // Lists environments for a provider, newest-first (createdAt desc). The id (cuid, timestamp-prefixed
  // and monotonically increasing) is the tiebreaker so two environments created within the same second
  // still list in creation order — matching job-repository's newest-first ordering.
  async listByProvider(providerId: string): Promise<ComputeEnvironment[]> {
    const client = await this.getClient()
    const rows = await client.computeEnvironment.findMany({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    return rows.map(toEnvironment)
  }

  // Resolves a ready environment by (providerId, name). Returns null when the environment does not
  // exist or is not `ready` (design.md §8.3 — only a ready environment may be named by a job). This is
  // the single authoritative ready-check the submit path consults.
  async findReadyByName(providerId: string, name: string): Promise<ComputeEnvironment | null> {
    const client = await this.getClient()
    const row = await client.computeEnvironment.findUnique({
      where: { providerId_name: { providerId, name } }
    })
    if (!row) return null
    if (row.status !== 'ready') return null
    return toEnvironment(row)
  }

  // Updates fields. When `spec` changes the specHash is recomputed; when spec OR resolution changes on
  // a currently-ready row, the row is force-transitioned to `stale` so the old ready record cannot be
  // reused by a new job (design.md §8.3 — cross-cutting requirement). An explicit `status` in the
  // request overrides the auto-stale logic (used by the provisioning workflow in issue 06).
  async update(id: string, updates: UpdateEnvironmentRequest): Promise<ComputeEnvironment> {
    const client = await this.getClient()

    const current = await client.computeEnvironment.findUnique({ where: { id } })
    if (!current) {
      throw new Error(`No compute environment found with id "${id}".`)
    }

    const data: Parameters<typeof client.computeEnvironment.update>[0]['data'] = {}
    if (updates.name !== undefined) data.name = updates.name
    if (updates.visibility !== undefined) data.visibility = updates.visibility
    if (updates.buildJobId !== undefined) data.buildJobId = updates.buildJobId
    if (updates.detailsDoc !== undefined) data.detailsDoc = updates.detailsDoc

    let specChanged = false
    if (updates.spec !== undefined) {
      data.specJson = JSON.stringify(updates.spec)
      data.specHash = computeSpecHash(updates.spec)
      specChanged = data.specHash !== current.specHash
    }
    let resolutionChanged = false
    if (updates.resolution !== undefined) {
      const newJson = JSON.stringify(updates.resolution)
      data.resolutionJson = newJson
      resolutionChanged = newJson !== current.resolutionJson
    }

    // Stale transition: a ready environment whose spec or resolution changed must become stale so it
    // can no longer be resolved by name (design.md §8.3). The provisioning workflow (issue 06) can pass
    // an explicit status to re-validate and flip it back to ready.
    const autoStale =
      (specChanged || resolutionChanged) &&
      current.status === 'ready' &&
      updates.status === undefined
    if (updates.status !== undefined) {
      data.status = updates.status
    } else if (autoStale) {
      data.status = 'stale'
    }

    const row = await client.computeEnvironment.update({ where: { id }, data })
    return toEnvironment(row)
  }

  // Records validation evidence and the validatedAt timestamp. Sets status to the evidence result
  // (ready/failed) unless the caller has since moved the row to a non-terminal state; this slice only
  // records terminal evidence (issue 06 owns the live validation workflow).
  async recordValidation(
    id: string,
    evidence: EnvironmentValidationEvidence
  ): Promise<ComputeEnvironment> {
    const client = await this.getClient()
    const row = await client.computeEnvironment.update({
      where: { id },
      data: {
        validationJson: JSON.stringify(evidence),
        validatedAt: new Date(evidence.validatedAt),
        status: evidence.result
      }
    })
    return toEnvironment(row)
  }

  // Atomically reserves an environment for provisioning: flips status to `building` ONLY when it is
  // not already building/validating. Returns true when this caller won the reservation, false when
  // another provisioning is in flight. The conditional updateMany IS the lock — there is no
  // read-then-write race window, so two concurrent provisioning runs for the same environment cannot
  // both proceed (design.md §8.3: concurrent builds for the same provider/name are rejected or safely
  // serialized). Terminal/initial states (draft/ready/failed/stale) are all reservable.
  async reserveForProvisioning(id: string): Promise<boolean> {
    const client = await this.getClient()
    const result = await client.computeEnvironment.updateMany({
      where: { id, status: { notIn: ['building', 'validating'] } },
      data: { status: 'building' }
    })
    return result.count > 0
  }

  async delete(id: string): Promise<void> {
    const client = await this.getClient()
    await client.computeEnvironment.delete({ where: { id } })
  }
}

export { toEnvironment }
export type { ComputeEnvironmentClient, ComputeEnvironmentClientProvider }
