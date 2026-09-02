import type { LocalRunAgentResultDeliveryContext } from '../../shared/agent-result-delivery'
import type { NotebookRunRecord } from '../../shared/notebook'

const SUMMARY_LIMIT = 8_000

const resultSummary = (run: NotebookRunRecord): string => {
  const parts = [
    run.exitCode === undefined ? undefined : `exitCode: ${String(run.exitCode)}`,
    run.text.stdout.trim() ? `stdout:\n${run.text.stdout.trim()}` : undefined,
    run.text.stderr.trim() ? `stderr:\n${run.text.stderr.trim()}` : undefined,
    run.text.traceback.trim() ? `traceback:\n${run.text.traceback.trim()}` : undefined
  ].filter((part): part is string => part !== undefined)
  const summary = parts.join('\n\n') || `Run ended with status ${run.status}.`
  return summary.length <= SUMMARY_LIMIT ? summary : `${summary.slice(0, SUMMARY_LIMIT - 1)}…`
}

const errorGuidance = (run: NotebookRunRecord): string | undefined => {
  if (run.status === 'completed') return undefined
  if (run.status === 'cancelled')
    return 'The Run was cancelled. Decide whether any follow-up is needed.'
  if (run.status === 'timeout')
    return 'The Run timed out. Inspect its output before deciding whether to run new work.'
  if (run.status === 'interrupted') {
    return 'The Run was interrupted. Inspect its durable output and runtime state before continuing.'
  }
  return 'The Run failed. Inspect its durable error and decide the next step; do not assume it should be rerun.'
}

const notebookRunDeliveryContext = (
  session: Readonly<{ projectId: string; sessionId: string }>,
  run: NotebookRunRecord
): LocalRunAgentResultDeliveryContext | undefined => {
  if (run.executionMode !== 'background' || run.status === 'queued' || run.status === 'running') {
    return undefined
  }
  const executionType = run.kernelKind === 'bash' ? 'shell' : run.kernelKind
  const provenance = {
    ...(run.messageBranchId ? { messageBranchId: run.messageBranchId } : {}),
    ...(run.runtimeSegmentId ? { runtimeSegmentId: run.runtimeSegmentId } : {}),
    ...(run.promptMessageId ? { promptMessageId: run.promptMessageId } : {}),
    ...(run.executionInvocationId ? { executionInvocationId: run.executionInvocationId } : {})
  }
  return {
    runId: run.runId,
    executionType,
    terminalStatus: run.status,
    resultSummary: resultSummary(run),
    ...(errorGuidance(run) ? { errorGuidance: errorGuidance(run) } : {}),
    projectId: session.projectId,
    sessionId: session.sessionId,
    ...(run.agentFrameId ? { agentFrameId: run.agentFrameId } : {}),
    ...(Object.keys(provenance).length > 0 ? { provenance } : {})
  }
}

export { notebookRunDeliveryContext }
