import { beforeEach, describe, expect, it } from 'vitest'

import type { ProjectBackgroundActivity } from '../../../shared/agent-result-delivery'
import {
  EMPTY_ACTIVITY,
  useProjectBackgroundActivityStore
} from './project-background-activity-store'

const snapshot = (
  revision: number,
  status: 'running' | 'pending-delivery'
): ProjectBackgroundActivity => ({
  revision,
  truncated: false,
  items: [
    {
      id: 'local-run:run-1',
      sourceKind: 'local-run',
      sourceId: 'run-1',
      executionType: 'python',
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'QC',
      lane: 'Kernel · Python',
      status,
      active: status === 'running',
      needsAttention: false,
      updatedAt: revision
    }
  ]
})

describe('Project background activity store', () => {
  beforeEach(() =>
    useProjectBackgroundActivityStore.setState({ projectId: undefined, snapshot: EMPTY_ACTIVITY })
  )

  it('does not let an older hydrate regress a terminal delivery to running', () => {
    const store = useProjectBackgroundActivityStore.getState()
    store.hydrate('project-1', snapshot(20, 'pending-delivery'))
    store.hydrate('project-1', snapshot(10, 'running'))

    expect(useProjectBackgroundActivityStore.getState().snapshot).toEqual(
      snapshot(20, 'pending-delivery')
    )
  })

  it('accepts a newer empty hydrate so consumed results disappear', () => {
    const store = useProjectBackgroundActivityStore.getState()
    store.hydrate('project-1', snapshot(20, 'pending-delivery'))
    store.hydrate('project-1', { revision: 21, items: [], truncated: false })

    expect(useProjectBackgroundActivityStore.getState().snapshot.items).toEqual([])
  })
})
