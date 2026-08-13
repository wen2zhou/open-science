import { describe, expect, it, vi } from 'vitest'

import type { ResolvedAgentBackend } from './types'
import { releaseResolvedAgentBackendLeases } from './resolved-agent-backend-leases'

describe('resolved agent backend lease owner', () => {
  it('settles best-effort leases and releases each successful Skill Runtime lease at most once', async () => {
    const responsesRelease = vi.fn(async () => {
      throw new Error('already closed')
    })
    const anthropicRelease = vi.fn(async () => undefined)
    const transportRelease = vi.fn(() => {
      throw new Error('synchronous close failure')
    })
    const skillRuntimeRelease = vi.fn(async () => undefined)
    const backend = {
      responsesBridgeLease: { release: responsesRelease },
      anthropicBridgeLease: { release: anthropicRelease },
      providerTransportLease: { release: transportRelease },
      skillRuntimeLease: { release: skillRuntimeRelease }
    } as unknown as ResolvedAgentBackend

    const first = releaseResolvedAgentBackendLeases(backend)
    const second = releaseResolvedAgentBackendLeases(backend)

    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(responsesRelease).toHaveBeenCalledOnce()
    expect(anthropicRelease).toHaveBeenCalledOnce()
    expect(transportRelease).toHaveBeenCalledOnce()
    expect(skillRuntimeRelease).toHaveBeenCalledOnce()
    await releaseResolvedAgentBackendLeases(backend)
    expect(responsesRelease).toHaveBeenCalledOnce()
  })

  it('retains failed Skill Runtime lease ownership and retries only that lease', async () => {
    const bridgeRelease = vi.fn(async () => {
      throw new Error('best-effort bridge close failure')
    })
    const skillRuntimeRelease = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Skill Runtime cleanup failed'))
      .mockResolvedValueOnce(undefined)
    const backend = {
      responsesBridgeLease: { release: bridgeRelease },
      skillRuntimeLease: { release: skillRuntimeRelease }
    } as unknown as ResolvedAgentBackend

    const first = releaseResolvedAgentBackendLeases(backend)
    expect(releaseResolvedAgentBackendLeases(backend)).toBe(first)
    await expect(first).rejects.toThrow('Skill Runtime cleanup failed')

    await expect(releaseResolvedAgentBackendLeases(backend)).resolves.toBeUndefined()
    expect(bridgeRelease).toHaveBeenCalledOnce()
    expect(skillRuntimeRelease).toHaveBeenCalledTimes(2)
    await releaseResolvedAgentBackendLeases(backend)
    expect(skillRuntimeRelease).toHaveBeenCalledTimes(2)
  })

  it('releases an aliased lease only once', async () => {
    const release = vi.fn(async () => undefined)
    const aliasedLease = { release }
    const backend = {
      responsesBridgeLease: aliasedLease,
      anthropicBridgeLease: aliasedLease,
      providerTransportLease: aliasedLease
    } as unknown as ResolvedAgentBackend

    await releaseResolvedAgentBackendLeases(backend)

    expect(release).toHaveBeenCalledOnce()
  })
})
