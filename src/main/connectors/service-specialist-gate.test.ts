import { describe, it, expect, vi } from 'vitest'
import { ConnectorService } from './service'
import { ParserEngine } from './engine'

// Specialist gate tests for ConnectorService.
// These tests pin the gate ordering:
//   global enabled? → session binding available? → connector in effectiveConnectors?
//   → tool-level blocked/ask/auto-allow → dispatch

describe('ConnectorService specialist gate', () => {
  const makeCustomServer = (overrides = {}) => ({
    id: 'uuid-custom-1',
    name: 'myserver',
    transport: 'stdio' as const,
    command: 'npx',
    enabled: true,
    ...overrides
  })

  const makeGate = (effectiveConnectorIds: string[]) =>
    vi.fn().mockResolvedValue(effectiveConnectorIds)

  describe('agent origin with session context', () => {
    it('allows bundled connector call when connector id is in effectiveConnectors', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({
          PropertyTable: { Properties: [{ CID: 1 }] }
        }) })
      const getEffectiveConnectorIds = makeGate(['chemistry'])
      const svc = new ConnectorService({
        engine: new ParserEngine({ fetchImpl }),
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      const out = await svc.call(
        'chemistry',
        'pubchem_get_compounds',
        { cids: [1] },
        { origin: 'agent', sessionId: 'session-1' }
      )
      expect(out).toBeDefined()
      expect(getEffectiveConnectorIds).toHaveBeenCalledWith('session-1')
    })

    it('rejects bundled connector call when connector id is not in effectiveConnectors', async () => {
      const fetchImpl = vi.fn()
      const getEffectiveConnectorIds = makeGate(['pubmed']) // only pubmed allowed
      const svc = new ConnectorService({
        engine: new ParserEngine({ fetchImpl }),
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      await expect(
        svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, {
          origin: 'agent',
          sessionId: 'session-1'
        })
      ).rejects.toThrow('connector not enabled for specialist: chemistry')
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('stable error message for denied connector call', async () => {
      const getEffectiveConnectorIds = makeGate([])
      const svc = new ConnectorService({
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      await expect(
        svc.call('chemistry', 'pubchem_get_compounds', {}, { origin: 'agent', sessionId: 's-1' })
      ).rejects.toThrow('connector not enabled for specialist: chemistry')
    })

    it('resolves custom MCP server by UUID for specialist gate', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      // specialist.connectorIds stores UUID, call() gets name — must map name → UUID
      const getEffectiveConnectorIds = makeGate(['uuid-custom-1'])
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [makeCustomServer()]
        }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      const out = await svc.call('myserver', 'do_thing', {}, {
        origin: 'agent',
        sessionId: 's-1'
      })
      expect(out).toEqual({ ok: true })
    })

    it('rejects custom MCP server call when its UUID is not in effectiveConnectors', async () => {
      const call = vi.fn()
      const getEffectiveConnectorIds = makeGate([]) // uuid-custom-1 not allowed
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [makeCustomServer()]
        }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      await expect(
        svc.call('myserver', 'do_thing', {}, { origin: 'agent', sessionId: 's-1' })
      ).rejects.toThrow('connector not enabled for specialist: uuid-custom-1')
      expect(call).not.toHaveBeenCalled()
    })

    it('does not open approval prompt for specialist-denied calls', async () => {
      const requestApproval = vi.fn()
      const getEffectiveConnectorIds = makeGate([])
      const svc = new ConnectorService({
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['chemistry/pubchem_get_compounds']
        }),
        resolveApiKey: () => undefined,
        requestApproval,
        getEffectiveConnectorIds
      })
      await expect(
        svc.call('chemistry', 'pubchem_get_compounds', {}, { origin: 'agent', sessionId: 's-1' })
      ).rejects.toThrow('connector not enabled for specialist')
      expect(requestApproval).not.toHaveBeenCalled()
    })
  })

  describe('unavailable binding — rejects all connector calls', () => {
    it('rejects every call when effective connectors returns unavailable signal', async () => {
      // An empty array from getEffectiveConnectorIds means the specialist is unavailable
      const getEffectiveConnectorIds = vi.fn().mockResolvedValue({ unavailable: true })
      const svc = new ConnectorService({
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      await expect(
        svc.call('chemistry', 'pubchem_get_compounds', {}, { origin: 'agent', sessionId: 's-1' })
      ).rejects.toThrow('connector not enabled for specialist: chemistry')
    })
  })

  describe('missing agent session context — fails closed', () => {
    it('rejects call when origin is agent but sessionId is absent', async () => {
      const fetchImpl = vi.fn()
      const getEffectiveConnectorIds = makeGate(['chemistry'])
      const svc = new ConnectorService({
        engine: new ParserEngine({ fetchImpl }),
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      // origin: 'agent' without sessionId must fail closed
      await expect(
        svc.call('chemistry', 'pubchem_get_compounds', {}, { origin: 'agent' })
      ).rejects.toThrow(/session context.*required|agent.*session/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  describe('context-free internal calls', () => {
    it('allows context-free internal calls to bypass specialist gate', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({
          PropertyTable: { Properties: [{ CID: 1 }] }
        }) })
      const getEffectiveConnectorIds = vi.fn() // should NOT be called
      const svc = new ConnectorService({
        engine: new ParserEngine({ fetchImpl }),
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      const out = await svc.call(
        'chemistry',
        'pubchem_get_compounds',
        { cids: [1] },
        { origin: 'internal' }
      )
      expect(out).toBeDefined()
      expect(getEffectiveConnectorIds).not.toHaveBeenCalled()
    })
  })

  describe('global disabled takes priority over specialist', () => {
    it('rejects globally-disabled connector even if in specialist effectiveConnectors', async () => {
      const getEffectiveConnectorIds = makeGate(['chemistry']) // specialist allows it
      const svc = new ConnectorService({
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          disabledConnectorIds: ['chemistry'] // globally disabled
        }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      // Global disabled fires before specialist gate, so error is about global enablement
      await expect(
        svc.call('chemistry', 'pubchem_get_compounds', {}, { origin: 'agent', sessionId: 's-1' })
      ).rejects.toThrow(/not enabled/)
    })
  })

  describe('rename/delete stable-id behavior', () => {
    it('custom MCP server rename preserves specialist reference by UUID', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      // The UUID doesn't change when name changes from 'old-name' → 'new-name'
      const getEffectiveConnectorIds = makeGate(['uuid-custom-1'])
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [makeCustomServer({ id: 'uuid-custom-1', name: 'new-name' })]
        }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      // Call by new name — UUID match should still work
      const out = await svc.call('new-name', 'do_thing', {}, { origin: 'agent', sessionId: 's-1' })
      expect(out).toEqual({ ok: true })
    })

    it('custom MCP server deletion surfaces as missing reference (gate blocks call)', async () => {
      const call = vi.fn()
      const getEffectiveConnectorIds = makeGate(['uuid-custom-1'])
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [] // server was deleted
        }),
        resolveApiKey: () => undefined,
        getEffectiveConnectorIds
      })
      // Server not found by any name — should throw connector not enabled
      await expect(
        svc.call('old-name', 'do_thing', {}, { origin: 'agent', sessionId: 's-1' })
      ).rejects.toThrow(/not enabled/)
      expect(call).not.toHaveBeenCalled()
    })
  })

  describe('no specialist gate wired (legacy / tests)', () => {
    it('allows calls without specialist gate when getEffectiveConnectorIds is absent', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({
          PropertyTable: { Properties: [{ CID: 1 }] }
        }) })
      const svc = new ConnectorService({
        engine: new ParserEngine({ fetchImpl }),
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
        resolveApiKey: () => undefined
        // no getEffectiveConnectorIds
      })
      // Old tests not passing origin context — should still work
      const out = await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })
      expect(out).toBeDefined()
    })
  })
})
