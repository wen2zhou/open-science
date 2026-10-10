import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { notebookRpcToolsForEnvironment } from '../notebook/mcp-server'
import { generatePlanToolSchema } from '../session-plan/plan-mcp-server'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME
} from '../../shared/activity-groups'

// This is an Auto review inventory, deliberately separate from remembered permission identities.
// Legacy entries require no migration of their existing authorization contract.
const registrations: Record<
  string,
  'allow_once' | 'inner_authorization' | 'legacy' | 'operations'
> = {
  "artifacts/mcp-server.ts:'write_artifact_file'": 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_SEARCH_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_READ_PDF_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_SAVE_TOOL_NAME': 'allow_once',
  "literature/library-mcp-server.ts:'acquire_pdf'": 'allow_once',
  'literature/mcp-server.ts:LITERATURE_READ_DOCUMENT_TOOL_NAME': 'allow_once',
  "literature/mcp-server.ts:'list_pdf_elements'": 'allow_once',
  "literature/mcp-server.ts:'read_pdf_element'": 'allow_once',
  'notebook/mcp-server.ts:definition.name': 'operations',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.readTurn': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.queryExecutionLog': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.readArtifact': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.submitFindings': 'legacy',
  "session-plan/plan-mcp-server.ts:'generate_plan'": 'operations',
  "session-plan/plan-mcp-server.ts:'update_step_status'": 'legacy',
  'side-chat/host-message-mcp-server.ts:HOST_SEND_MESSAGE_TOOL_NAME': 'legacy',
  'skills/mcp-server.ts:REQUEST_SKILL_IMPORT_TOOL_NAME': 'inner_authorization',
  'skills/runtime-mcp-server.ts:LOAD_SKILL_TOOL_NAME': 'legacy'
}
const notebookOperations: Record<string, 'inner_authorization' | 'legacy' | 'operations'> = {
  ask_user_question: 'inner_authorization',
  notebook_execute: 'legacy',
  background_run: 'operations',
  repl_execute: 'legacy',
  bash_execute: 'legacy',
  request_network_access: 'inner_authorization',
  notebook_state: 'legacy',
  list_notebook_runtimes: 'legacy',
  notebook_bind_runtime: 'legacy',
  notebook_switch_runtime: 'legacy',
  notebook_restart: 'legacy',
  notebook_shutdown: 'legacy',
  inspect_packages: 'legacy',
  manage_packages: 'legacy',
  manage_environments: 'operations',
  list_memory_categories: 'legacy',
  search_memories: 'legacy',
  remember_memory: 'legacy',
  wsl_setup_diagnostics: 'legacy',
  wsl_setup_install_platform: 'legacy',
  wsl_setup_install_recommended_distro: 'legacy',
  wsl_setup_select_profile: 'legacy',
  wsl_setup_open_terminal: 'legacy'
}
const mainRoot = join(import.meta.dirname, '..')
const readSource = (path: string): string => readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith('.ts') && !entry.name.includes('.test.')
        ? [path]
        : []
  })
const collectRegistrations = (source: string, filename: string): string[] => {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'registerTool'
    ) {
      names.push(`${filename}:${node.arguments[0].getText(file)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const tools = notebookRpcToolsForEnvironment({ memoryTools: true, wslSetupTools: true })

describe('Auto operation completeness against real tool registrations', () => {
  it('requires an explicit Auto disposition for every actual app tool', () => {
    const actual = sourceFiles(mainRoot).flatMap((path) =>
      collectRegistrations(readSource(path), relative(mainRoot, path).replaceAll('\\', '/'))
    )
    expect(actual.sort()).toEqual(Object.keys(registrations).sort())
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(notebookOperations).sort())
    // Activity is a compatibility declaration identity, not a registered MCP server in this tree.
    expect(`${ACTIVITY_GROUP_MCP_SERVER_NAME}/${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`).toBe(
      'open-science-activity/begin_activity_group'
    )
  })

  it('detects a newly registered tool independently of the grant catalog', () => {
    const added = collectRegistrations(
      "server.registerTool('new_effect', {}, handler)",
      'notebook/mcp-server.ts'
    )
    expect(added.filter((key) => !(key in registrations))).toEqual([
      "notebook/mcp-server.ts:'new_effect'"
    ])
    expect('new_effect' in notebookOperations).toBe(false)
  })

  it('requires review when automatically handled schemas or handler branches change', () => {
    // Update these fingerprints only after reviewing the new parameter/handler branches against
    // the operation classifier and its positive/negative tests. Whole-source hashes intentionally
    // err toward extra review; they cannot silently bless a newly added side-effect branch.
    const automaticFiles = [
      ...new Set(
        Object.entries(registrations)
          .filter(([key, mode]) => mode !== 'legacy' && !key.startsWith('notebook/'))
          .map(([key]) => key.slice(0, key.indexOf(':')))
      )
    ]
    const definitions = Object.fromEntries(
      automaticFiles.sort().map((file) => [file, digest(readSource(join(mainRoot, file)))])
    )
    const notebookSchemas = Object.fromEntries(
      tools
        .filter((tool) => notebookOperations[tool.name] !== 'legacy')
        .map((tool) => [
          tool.name,
          digest({
            schema: z.toJSONSchema(z.strictObject(tool.inputSchema)),
            method: tool.method,
            resolveMethod: tool.resolveMethod?.toString()
          })
        ])
    )
    const sharedContracts = {
      planSchema: digest(z.toJSONSchema(generatePlanToolSchema)),
      planValidation: digest(readSource(join(mainRoot, '../shared/session-plan/contract.ts'))),
      activityDeclaration: digest(readSource(join(mainRoot, '../shared/activity-groups.ts')))
    }
    expect({ definitions, notebookSchemas, sharedContracts }).toMatchSnapshot()
  })

  it('detects an unmapped operation added to an automatic tool schema', () => {
    const tool = tools.find((tool) => tool.name === 'background_run')!
    const original = z.toJSONSchema(z.strictObject(tool.inputSchema))
    const changed = z.toJSONSchema(
      z.strictObject({ ...tool.inputSchema, action: z.enum(['query', 'cancel', 'start']) })
    )
    expect(digest(changed)).not.toBe(digest(original))
  })
})
