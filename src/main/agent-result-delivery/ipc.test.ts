import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, request: never) => unknown>()

vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (event: unknown, request: never) => unknown) =>
    handlers.set(channel, handler)
}))

import { registerAgentResultDeliveryIpcHandlers } from './ipc'

describe('Agent result delivery IPC', () => {
  beforeEach(() => handlers.clear())

  it('publishes the bounded Project revision only after dismiss commits', async () => {
    const onChanged = vi.fn()
    const repository = {
      listAwaitingAgent: vi.fn(async () => []),
      listProjectVisible: vi.fn(async () => []),
      projectRevision: vi.fn(async () => 73),
      find: vi.fn(async () => ({ context: { projectId: 'project-1' } })),
      dismiss: vi.fn(async () => true)
    }
    registerAgentResultDeliveryIpcHandlers(repository as never, { onChanged })

    await expect(
      handlers.get('agent-result-delivery:dismiss')?.(undefined, {
        sessionId: 'session-1',
        deliveryId: 'delivery-1'
      } as never)
    ).resolves.toBe(true)

    expect(repository.dismiss).toHaveBeenCalledOnce()
    expect(onChanged).toHaveBeenCalledWith({ projectId: 'project-1', revision: 73 })
  })

  it('does not publish when dismiss makes no durable change', async () => {
    const onChanged = vi.fn()
    const repository = {
      listAwaitingAgent: vi.fn(async () => []),
      listProjectVisible: vi.fn(async () => []),
      projectRevision: vi.fn(async () => 73),
      find: vi.fn(async () => ({ context: { projectId: 'project-1' } })),
      dismiss: vi.fn(async () => false)
    }
    registerAgentResultDeliveryIpcHandlers(repository as never, { onChanged })

    await handlers.get('agent-result-delivery:dismiss')?.(undefined, {
      sessionId: 'session-1',
      deliveryId: 'delivery-1'
    } as never)

    expect(onChanged).not.toHaveBeenCalled()
  })
})
