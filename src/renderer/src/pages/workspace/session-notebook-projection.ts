import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ChatSession } from '@/stores/session-store'

type NotebookFrameFilterValue = 'all' | 'unattributed' | `frame:${string}`
type NotebookFrameFilterOption = Readonly<{
  value: NotebookFrameFilterValue
  label: string
  count: number
}>

const createNotebookFrameFilterOptions = (
  runs: readonly NotebookRunRecord[],
  frameLabels: Readonly<Record<string, string>> = {}
): NotebookFrameFilterOption[] => {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (run.agentFrameId) counts.set(run.agentFrameId, (counts.get(run.agentFrameId) ?? 0) + 1)
  }
  const options: NotebookFrameFilterOption[] = [
    { value: 'all', label: 'All', count: runs.length },
    ...[...counts].map(([agentFrameId, count]) => ({
      value: `frame:${agentFrameId}` as const,
      label: frameLabels[agentFrameId] ?? agentFrameId,
      count
    }))
  ]
  const unattributedCount = runs.filter((run) => !run.agentFrameId).length
  if (unattributedCount > 0) {
    options.push({ value: 'unattributed', label: 'Unattributed', count: unattributedCount })
  }
  return options
}

const projectNotebookRunsForFrame = (
  runs: readonly NotebookRunRecord[],
  filter: NotebookFrameFilterValue
): NotebookRunRecord[] => {
  if (filter === 'all') return [...runs]
  if (filter === 'unattributed') return runs.filter((run) => !run.agentFrameId)
  const agentFrameId = filter.slice('frame:'.length)
  return runs.filter((run) => run.agentFrameId === agentFrameId)
}

const notebookFrameFilterForExport = (
  filter: NotebookFrameFilterValue
): string | null | undefined => {
  if (filter === 'all') return undefined
  if (filter === 'unattributed') return null
  return filter.slice('frame:'.length)
}

const filterNotebookRunsForSessionBranch = (
  runs: NotebookRunRecord[],
  session: ChatSession
): NotebookRunRecord[] => {
  const activeMessageIds = new Set(session.messages.map((message) => message.id))
  const rootFrameId = session.conversationGraph?.rootFrameId
  return runs.filter(
    (run) =>
      !run.promptMessageId ||
      (run.agentFrameId !== undefined && run.agentFrameId !== rootFrameId) ||
      activeMessageIds.has(run.promptMessageId)
  )
}

const notebookFrameLabels = (session: ChatSession): Record<string, string> => {
  const graph = session.conversationGraph
  if (!graph) return {}
  return Object.fromEntries(
    graph.frames.map((frame) => [
      frame.id,
      frame.id === graph.rootFrameId
        ? 'Main agent'
        : (frame.delegateName ?? frame.agentName ?? frame.id)
    ])
  )
}

export {
  createNotebookFrameFilterOptions,
  filterNotebookRunsForSessionBranch,
  notebookFrameFilterForExport,
  notebookFrameLabels,
  projectNotebookRunsForFrame
}
export type { NotebookFrameFilterOption, NotebookFrameFilterValue }
