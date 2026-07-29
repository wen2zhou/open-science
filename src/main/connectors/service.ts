import { ParserEngine } from './engine'
import { ALL_CONNECTOR_IDS, getDescriptor } from './registry'
import { toCustomMcpConfig } from './custom-mcp-bootstrap'
import type { CustomMcpServerConfig } from './mcp-client-manager'
import type { ConnectorCredentials, ToolDescriptor } from './types'
import type { StoredConnectors } from '../settings/types'
import type { ApprovalDecision } from '../../shared/settings'
import { createLogger } from '../logger'

const log = createLogger('connector-gate')

type McpClientManagerLike = {
  call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown>
}

type ConnectorServiceDeps = {
  engine?: ParserEngine
  mcpClientManager?: McpClientManagerLike
  getConnectors: () => StoredConnectors | undefined
  resolveApiKey: (ref?: string) => string | undefined
  // Human approval gate for a tool call that isn't pre-approved. Absent (e.g. in tests) means the
  // call runs without prompting. A connector call sends data to an external service, so a call that
  // is neither pre-allowed nor skip-approved must be confirmed before it runs.
  requestApproval?: (info: {
    connector: string
    method: string
    args: Record<string, unknown>
    // The session that triggered the call, when one is known, so the resulting notification can
    // open the right conversation.
    sessionId?: string
  }) => Promise<ApprovalDecision>
  // Handlers for bundled tools that run privileged local code (e.g. write an artifact, open a preview)
  // instead of the read-only HTTP ParserEngine. Keyed by `${connector}/${method}`; invoked after the
  // same enable/policy/approval gate as any other bundled call. The call context carries the id of the
  // session that triggered the call so a handler can attribute side effects (e.g. a generated artifact)
  // to the right session instead of a global "current" one.
  localToolHandlers?: Record<
    string,
    (args: Record<string, unknown>, context: ConnectorCallContext) => Promise<unknown>
  >
  // Specialist gate: resolves effective connector ids for a session. Returns an array of allowed stable
  // ids (bundled catalog ids or custom MCP server UUIDs), or { unavailable: true } when the bound
  // specialist is unavailable (fail-closed). Absent: no specialist gate is applied (legacy/tests).
  // Called only for agent-origin calls with a sessionId; internal calls bypass the specialist gate.
  getEffectiveConnectorIds?: (
    sessionId: string
  ) => Promise<string[] | { unavailable: true }>
}

// Routing context for a connector call. Every agent-originated call MUST supply origin:'agent' and
// sessionId so the specialist gate can run. Context-free internal callers MUST declare origin:'internal'
// explicitly — never omit origin on an internal call, as omission is treated the same as absent context
// (no specialist gate for backward compatibility with legacy call sites that predate this field).
// Agent calls without sessionId fail closed when a specialist gate is wired.
export type ConnectorCallContext =
  | { origin: 'agent'; sessionId?: string }
  | { origin: 'internal' }
  | { sessionId?: string } // legacy form: no origin declared (backward compat, no specialist gate)

// Agent-agnostic gate: enforces enabled state + per-tool policy, prompts for approval on un-trusted
// calls, injects credentials, and dispatches each call to either the bundled ParserEngine or a
// user-added custom MCP server's McpClientManager. See docs/internal/2026-07-12-custom-mcp-connectors-plan4.md §3.2.
export class ConnectorService {
  private readonly engine: ParserEngine
  constructor(private readonly deps: ConnectorServiceDeps) {
    this.engine = deps.engine ?? new ParserEngine()
  }

  isEnabled(connector: string): boolean {
    // Bundled connectors are enabled by default; only an explicit opt-out disables one.
    return !(this.deps.getConnectors()?.disabledConnectorIds ?? []).includes(connector)
  }

  async call(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext = {}
  ): Promise<unknown> {
    const descriptor = getDescriptor(connector, method)
    const isBundled = descriptor !== undefined || ALL_CONNECTOR_IDS.includes(connector)

    if (isBundled) {
      // For bundled connectors, the stable catalog id equals the connector parameter.
      await this.enforceSpecialistGate(connector, context)
      return this.callBundled(connector, method, args, descriptor, context)
    }

    const custom = (this.deps.getConnectors()?.customMcpServers ?? []).find(
      (s) => s.name === connector
    )
    if (!custom) throw new Error(`connector not enabled: ${connector}`)
    // For custom MCP servers, the stable id is the UUID — use that for the specialist gate.
    await this.enforceSpecialistGate(custom.id, context)
    return this.callCustom(custom, method, args, context)
  }

  // Specialist gate: runs BEFORE connector recognition, approval prompts, and network dispatch.
  // Ordering: global enabled? → session binding available? → connector in effectiveConnectors?
  // → tool-level blocked/ask/auto-allow → dispatch
  // The gate is only applied for agent-origin calls; internal calls explicitly bypass it.
  // Missing agent session context fails closed when a specialist gate is wired.
  private async enforceSpecialistGate(
    connectorId: string,
    context: ConnectorCallContext
  ): Promise<void> {
    if (!this.deps.getEffectiveConnectorIds) return // no specialist gate wired

    const origin = 'origin' in context ? context.origin : undefined

    // Internal callers explicitly declare their origin — they bypass the specialist gate.
    if (origin === 'internal') return

    // Agent origin requires sessionId. Missing context fails closed.
    const sessionId = 'sessionId' in context ? context.sessionId : undefined
    if (origin === 'agent' && !sessionId) {
      throw new Error(
        'Agent session context (sessionId) is required for connector calls with a specialist gate.'
      )
    }

    // Legacy callers (no origin field) without sessionId: no specialist gate — backward compat.
    if (!sessionId) return

    const effectiveResult = await this.deps.getEffectiveConnectorIds(sessionId)

    // Unavailable binding: fail closed — reject all connector calls.
    if (!Array.isArray(effectiveResult)) {
      log.warn('connector call rejected: specialist unavailable', {
        connectorId,
        sessionId
      })
      throw new Error(`connector not enabled for specialist: ${connectorId}`)
    }

    // Not in effective allowlist: reject before any approval or network dispatch.
    if (!effectiveResult.includes(connectorId)) {
      log.warn('connector call rejected: not in specialist allowlist', {
        connectorId,
        sessionId
      })
      throw new Error(`connector not enabled for specialist: ${connectorId}`)
    }
  }

  private async callBundled(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    descriptor: ToolDescriptor | undefined,
    context: ConnectorCallContext
  ): Promise<unknown> {
    if (!this.isEnabled(connector)) throw new Error(`connector not enabled: ${connector}`)
    if (!descriptor) throw new Error(`unknown tool: ${connector}/${method}`)

    if (this.isBlocked(connector, method)) {
      throw new Error(`tool blocked by policy: ${connector}/${method}`)
    }
    const sessionId = 'sessionId' in context ? context.sessionId : undefined
    await this.ensureApproved(connector, method, args, sessionId)

    // Bundled tools that need privileged local behavior run here, after the same gate, instead of the
    // read-only HTTP engine.
    const localHandler = this.deps.localToolHandlers?.[`${connector}/${method}`]
    if (localHandler) return localHandler(args, context)

    return this.engine.call(descriptor, args, this.credentials())
  }

  private async callCustom(
    custom: NonNullable<StoredConnectors['customMcpServers']>[number],
    method: string,
    args: Record<string, unknown>,
    context: ConnectorCallContext
  ): Promise<unknown> {
    if (!custom.enabled) throw new Error(`connector not enabled: ${custom.name}`)
    if (this.isBlocked(custom.name, method)) {
      throw new Error(`tool blocked by policy: ${custom.name}/${method}`)
    }
    if (!this.deps.mcpClientManager) throw new Error('connector runtime not configured')
    const sessionId = 'sessionId' in context ? context.sessionId : undefined
    await this.ensureApproved(custom.name, method, args, sessionId)

    return this.deps.mcpClientManager.call(toCustomMcpConfig(custom), method, args)
  }

  private isBlocked(connector: string, method: string): boolean {
    const blocked = this.deps.getConnectors()?.blockedToolIds ?? []
    return blocked.includes(`${connector}/${method}`)
  }

  // Tools run without a prompt by default. A call is confirmed by a human only when the tool is
  // explicitly set to "Ask each time" AND the connector does not skip approvals.
  private async ensureApproved(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<void> {
    const c = this.deps.getConnectors()
    const requiresAsk = (c?.askToolIds ?? []).includes(`${connector}/${method}`)
    const skipApprovals = (c?.autoAllowIds ?? []).includes(connector)
    if (!requiresAsk || skipApprovals) return
    if (!this.deps.requestApproval) return // no approver wired (tests) — do not block

    const decision = await this.deps.requestApproval({ connector, method, args, sessionId })

    if (decision !== 'allow') {
      throw new Error(`tool call denied by user: ${connector}/${method}`)
    }
  }

  private credentials(): ConnectorCredentials {
    const c = this.deps.getConnectors()
    return { ncbiEmail: c?.contactEmail, ncbiApiKey: this.deps.resolveApiKey(c?.ncbiApiKeyRef) }
  }
}
