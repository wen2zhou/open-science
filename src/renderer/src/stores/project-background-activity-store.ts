import { create } from 'zustand'

import type { ProjectBackgroundActivity } from '../../../shared/agent-result-delivery'

type ProjectBackgroundActivityState = {
  projectId?: string
  snapshot: ProjectBackgroundActivity
  hydrate: (projectId: string, snapshot: ProjectBackgroundActivity) => void
  clear: () => void
}

const EMPTY_ACTIVITY: ProjectBackgroundActivity = { revision: 0, items: [], truncated: false }

const useProjectBackgroundActivityStore = create<ProjectBackgroundActivityState>((set) => ({
  snapshot: EMPTY_ACTIVITY,
  hydrate: (projectId, incoming) =>
    set((state) => {
      if (state.projectId === projectId && incoming.revision < state.snapshot.revision) return state
      return { projectId, snapshot: incoming }
    }),
  clear: () => set({ projectId: undefined, snapshot: EMPTY_ACTIVITY })
}))

export { EMPTY_ACTIVITY, useProjectBackgroundActivityStore }
