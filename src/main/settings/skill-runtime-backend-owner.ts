import type { SkillRuntimeView } from '../agent-framework'
import type { ResolvedAgentBackend } from '../agent-framework'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import type { SkillRuntimeBindingPolicy } from '../skills/runtime-projection'
import type { AcquiredSkillRuntimeBinding } from './agent-runtime-manager'

type SkillRuntimeBackendFactory = (
  binding: AcquiredSkillRuntimeBinding | undefined
) => Promise<ResolvedAgentBackend>

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const mergeClaudeSessionOptions = (
  base: Record<string, unknown> | undefined,
  projected: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (!base) return projected
  if (!projected) return base
  const mergeArray = (key: string): unknown[] => [
    ...new Set([
      ...(Array.isArray(base[key]) ? base[key] : []),
      ...(Array.isArray(projected[key]) ? projected[key] : [])
    ])
  ]
  return {
    ...base,
    ...projected,
    plugins: mergeArray('plugins'),
    additionalDirectories: mergeArray('additionalDirectories'),
    managedSettings: {
      ...asRecord(base.managedSettings),
      ...asRecord(projected.managedSettings)
    }
  }
}

// Bridges runtime bindings into backend views and retains any lease acquired before a backend can
// be returned to the connection owner. Abnormal process exit is still covered by startup recovery.
export class SkillRuntimeBackendOwner {
  private readonly pendingReleases = new Set<AcquiredSkillRuntimeBinding>()
  private readonly factories = new WeakMap<ResolvedAgentBackend, SkillRuntimeBackendFactory>()

  view(binding: AcquiredSkillRuntimeBinding | undefined): SkillRuntimeView | undefined {
    return binding
      ? {
          generationRoot: binding.generationRoot,
          skillsRoot: binding.skillsRoot,
          discoveryRoot: binding.discoveryRoot,
          descriptors: binding.descriptors,
          environment: binding.environment
        }
      : undefined
  }

  connectorInstructions(binding: AcquiredSkillRuntimeBinding | undefined): string {
    return renderConnectorInstructions(
      (binding?.descriptors ?? [])
        .map((descriptor) => descriptor.name)
        .filter((name) => /^mcp-[a-z0-9-]+$/.test(name))
    )
  }

  lease(
    binding: AcquiredSkillRuntimeBinding | undefined
  ): ResolvedAgentBackend['skillRuntimeLease'] {
    return binding ? { release: () => this.release(binding) } : undefined
  }

  async retryPendingReleases(): Promise<void> {
    await Promise.allSettled([...this.pendingReleases].map((binding) => this.release(binding)))
  }

  register(backend: ResolvedAgentBackend, factory: SkillRuntimeBackendFactory): void {
    this.factories.set(backend, factory)
  }

  async fork(
    backend: ResolvedAgentBackend,
    policy: SkillRuntimeBindingPolicy,
    acquire: () => Promise<AcquiredSkillRuntimeBinding | undefined>
  ): Promise<ResolvedAgentBackend> {
    const factory = this.factories.get(backend)
    if (!factory) throw new Error('The admitted Subagent backend can no longer fork Skill state.')
    await this.retryPendingReleases()
    const binding = policy.kind === 'none' ? undefined : await acquire()
    try {
      return await factory(binding)
    } catch (error) {
      if (binding) await this.release(binding).catch(() => undefined)
      throw error
    }
  }

  async release(binding: AcquiredSkillRuntimeBinding): Promise<void> {
    this.pendingReleases.add(binding)
    await binding.release()
    this.pendingReleases.delete(binding)
  }
}

export { mergeClaudeSessionOptions }
