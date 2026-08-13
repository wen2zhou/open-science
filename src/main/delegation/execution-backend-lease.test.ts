import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework, type ResolvedAgentBackend } from '../agent-framework'
import { createDelegateExecutionBackendLease } from './execution-backend-lease'

describe('delegated execution backend lease', () => {
  it('keeps one secret backend owner across batch claims and releases it exactly once', async () => {
    const release = vi.fn(async () => undefined)
    const releaseSkillRuntime = vi.fn(async () => undefined)
    const backend: ResolvedAgentBackend = {
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: { OPENAI_API_KEY: 'process-memory-only' },
      providerTransportLease: { setTarget: () => true, release },
      skillRuntimeLease: { release: releaseSkillRuntime }
    }
    const admission = createDelegateExecutionBackendLease(backend)
    const first = admission.claim()
    const second = admission.claim()

    expect(first.backend.env.OPENAI_API_KEY).toBe('process-memory-only')
    expect(first.backend.providerTransportLease).toBeUndefined()
    expect(first.backend.skillRuntimeLease).toBeUndefined()
    await admission.release()
    await admission.release()
    await first.release()
    expect(release).not.toHaveBeenCalled()
    await second.release()
    await second.release()
    expect(release).toHaveBeenCalledOnce()
    expect(releaseSkillRuntime).toHaveBeenCalledOnce()
  })

  it('fails closed when an admission owner does not provide Skill Runtime forking', async () => {
    const admission = createDelegateExecutionBackendLease({
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: {}
    })
    const claim = admission.claim()

    await expect(claim.forkSkillRuntime({ kind: 'main' })).rejects.toThrow(
      'Skill Runtime forking is unavailable'
    )

    await admission.release()
    await claim.release()
  })
})
