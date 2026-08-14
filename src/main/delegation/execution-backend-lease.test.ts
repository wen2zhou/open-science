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
      env: {
        OPENAI_API_KEY: 'process-memory-only',
        TMPDIR: '/runtime/tmp',
        XDG_CACHE_HOME: '/runtime/cache'
      },
      providerTransportLease: { setTarget: () => true, release },
      skillRuntime: {
        projectionRoot: '/runtime/catalog',
        discoveryRoot: '/runtime/catalog/skills',
        descriptors: [],
        environment: { TMPDIR: '/runtime/tmp', XDG_CACHE_HOME: '/runtime/cache' }
      },
      skillRuntimeLease: { release: releaseSkillRuntime },
      skillRuntimeFork: {
        acquire: vi.fn(async (lifecycle) => {
          const releaseAttempt = attemptReleases[nextAttempt++]!
          return {
            view: {
              ...backend.skillRuntime!,
              environment: {
                TMPDIR: `/runtime/${lifecycle.agentFrameId}/tmp`,
                XDG_CACHE_HOME: `/runtime/${lifecycle.agentFrameId}/cache`
              }
            },
            lease: { release: releaseAttempt }
          }
        })
      }
    }
    const attemptReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)]
    let nextAttempt = 0
    const admission = createDelegateExecutionBackendLease(backend)
    const first = admission.claim()
    const second = admission.claim()

    const firstBackend = await first.acquireAttemptBackend({
      lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-1', runtimeSegmentId: 'runtime-1' }
    })
    const firstBackendAgain = await first.acquireAttemptBackend({
      lifecycle: { sessionId: 'ignored', agentFrameId: 'ignored', runtimeSegmentId: 'ignored' }
    })
    const secondBackend = await second.acquireAttemptBackend({
      lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-2', runtimeSegmentId: 'runtime-2' }
    })
    expect(firstBackend.env.OPENAI_API_KEY).toBe('process-memory-only')
    expect(firstBackendAgain).toBe(firstBackend)
    expect(backend.skillRuntimeFork?.acquire).toHaveBeenCalledTimes(2)
    expect(firstBackend.providerTransportLease).toBeUndefined()
    expect(firstBackend.skillRuntime?.projectionRoot).toBe(
      secondBackend.skillRuntime?.projectionRoot
    )
    expect(firstBackend.skillRuntime?.environment.TMPDIR).not.toBe(
      secondBackend.skillRuntime?.environment.TMPDIR
    )
    expect(firstBackend.skillRuntimeLease).toBeUndefined()
    await admission.release()
    await admission.release()
    await first.release()
    expect(release).not.toHaveBeenCalled()
    await second.release()
    await second.release()
    expect(release).toHaveBeenCalledOnce()
    expect(releaseSkillRuntime).toHaveBeenCalledOnce()
    expect(attemptReleases[0]).toHaveBeenCalledOnce()
    expect(attemptReleases[1]).toHaveBeenCalledOnce()
  })

  it('retries a transient attempt runtime cleanup failure before releasing admission', async () => {
    const releaseSkillRuntime = vi.fn(async () => undefined)
    const releaseAttempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient cleanup failure'))
      .mockResolvedValue(undefined)
    const backend: ResolvedAgentBackend = {
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: {},
      skillRuntime: {
        projectionRoot: '/runtime/catalog',
        discoveryRoot: '/runtime/catalog/skills',
        descriptors: [],
        environment: { TMPDIR: '/runtime/base/tmp' }
      },
      skillRuntimeLease: { release: releaseSkillRuntime },
      skillRuntimeFork: {
        acquire: vi.fn(async () => ({
          view: {
            ...backend.skillRuntime!,
            environment: { TMPDIR: '/runtime/attempt/tmp' }
          },
          lease: { release: releaseAttempt }
        }))
      }
    }
    const admission = createDelegateExecutionBackendLease(backend)
    const claim = admission.claim()

    await claim.acquireAttemptBackend({
      lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-1', runtimeSegmentId: 'runtime-1' }
    })
    await admission.release()
    await expect(claim.release()).resolves.toBeUndefined()

    expect(releaseAttempt).toHaveBeenCalledTimes(2)
    expect(releaseSkillRuntime).toHaveBeenCalledOnce()
  })
})
