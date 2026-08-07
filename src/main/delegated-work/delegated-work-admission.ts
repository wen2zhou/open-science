import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import type {
  DurableDelegateRequest,
  DurableSnapshot,
  SpecialistDelegationProfile
} from './durable-delegated-work'

type DurableResolvedAgent = DurableSnapshot['records'][number]['attempts'][number]['resolvedAgent']

class DelegatedWorkAdmissionPolicy {
  constructor(
    private readonly resolveSpecialistById?: (
      profileId: string
    ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined,
    private readonly resolveSpecialistReference?: (
      profileReference: string
    ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined,
    private readonly validateInput?: (identity: string) => Promise<boolean> | boolean
  ) {}

  async admit(
    requestOrRequests: DurableDelegateRequest | readonly DurableDelegateRequest[]
  ): Promise<
    Readonly<{
      requests: readonly DurableDelegateRequest[]
      resolvedAgents: readonly DurableResolvedAgent[]
    }>
  > {
    const rawRequests: readonly unknown[] = Array.isArray(requestOrRequests)
      ? requestOrRequests
      : [requestOrRequests]
    if (
      rawRequests.length === 0 ||
      rawRequests.some(
        (request) =>
          typeof request !== 'object' ||
          request === null ||
          Array.isArray(request) ||
          !('task' in request) ||
          typeof request.task !== 'string' ||
          request.task.trim().length === 0
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation requires a non-empty task'
      )
    }
    const requests = rawRequests as readonly DurableDelegateRequest[]
    if (
      requests.some(
        (request) =>
          request.name !== undefined && (typeof request.name !== 'string' || !request.name.trim())
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit delegate name cannot be empty'
      )
    }
    if (
      requests.some(
        (request) =>
          request.context !== undefined &&
          (typeof request.context !== 'string' || !request.context.trim())
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit delegate context cannot be empty'
      )
    }
    const resolvedAgents = await Promise.all(
      requests.map((request) => this.resolveRequestedAgent(request.profile))
    )
    if (
      requests.some(
        (request) =>
          request.inputs !== undefined &&
          (!Array.isArray(request.inputs) ||
            request.inputs.some((input) => typeof input !== 'string' || !input.trim()))
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegation inputs must be immutable Version identities'
      )
    }
    const inputs = requests.flatMap((request) => request.inputs ?? [])
    if (inputs.length > 0) {
      if (!this.validateInput) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation inputs require an immutable Upload or Artifact Version validator'
        )
      }
      const validInputs = await Promise.all(inputs.map(this.validateInput))
      if (validInputs.some((valid) => !valid)) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation inputs must be immutable Upload or Artifact Version identities'
        )
      }
    }
    return { requests, resolvedAgents }
  }

  async resolveAgent(profileId: string | undefined): Promise<DurableResolvedAgent> {
    return this.resolve(profileId, this.resolveSpecialistById, true)
  }

  private async resolveRequestedAgent(
    profileReference: string | undefined
  ): Promise<DurableResolvedAgent> {
    return this.resolve(
      profileReference,
      this.resolveSpecialistReference ?? this.resolveSpecialistById,
      this.resolveSpecialistReference === undefined
    )
  }

  private async resolve(
    profileId: string | undefined,
    resolver:
      | ((
          profileId: string
        ) =>
          | Promise<SpecialistDelegationProfile | undefined>
          | SpecialistDelegationProfile
          | undefined)
      | undefined,
    requireMatchingId: boolean
  ): Promise<DurableResolvedAgent> {
    if (profileId === undefined) return { kind: 'main' }
    if (typeof profileId !== 'string' || !profileId.trim()) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'an explicit Specialist profile identity cannot be empty'
      )
    }
    let profile: SpecialistDelegationProfile | undefined
    try {
      profile = await resolver?.(profileId)
    } catch (error) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        error instanceof Error ? error.message : String(error),
        'The requested Specialist is unavailable. Choose an enabled Specialist in Settings and try again.'
      )
    }
    if (
      !profile ||
      (requireMatchingId && profile.id !== profileId) ||
      !profile.enabled ||
      profile.setupPending === true ||
      !Number.isSafeInteger(profile.revision) ||
      profile.revision < 0
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        `Specialist ${profileId} is unavailable for delegated execution`,
        'The requested Specialist is unavailable. Choose an enabled Specialist in Settings and try again.'
      )
    }
    const displayName = profile.displayName?.trim() || profile.name.trim()
    if (!displayName) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        `Specialist ${profileId} has no display label`,
        'The requested Specialist is unavailable. Choose an enabled Specialist in Settings and try again.'
      )
    }
    return {
      kind: 'specialist',
      profileId: profile.id,
      revision: profile.revision,
      displayName
    }
  }
}

export { DelegatedWorkAdmissionPolicy }
