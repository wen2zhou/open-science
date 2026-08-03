import { create } from 'zustand'
import type {
  SpecialistListItem,
  SpecialistProfileView,
  CreateSpecialistInput,
  UpdateSpecialistInput
} from '../../../shared/specialist'
import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallResult
} from '../../../shared/specialist-package'

type SpecialistStoreData = {
  items: SpecialistListItem[]
  isLoaded: boolean
  packagePreview?: SpecialistPackageCandidatePreview
}

type SpecialistStoreActions = {
  load: () => Promise<void>
  create: (input: CreateSpecialistInput) => Promise<SpecialistProfileView>
  update: (input: UpdateSpecialistInput) => Promise<SpecialistProfileView>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  delete: (id: string, expectedRevision: number) => Promise<void>
  duplicate: (id: string) => Promise<CreateSpecialistInput>
  selectPackage: () => Promise<{ cancelled: true } | SpecialistPackageCandidatePreview>
  installPackage: () => Promise<SpecialistPackageInstallResult>
  cancelPackage: () => Promise<void>
}

type SpecialistStore = SpecialistStoreData & SpecialistStoreActions

const useSpecialistStore = create<SpecialistStore>((set) => ({
  items: [],
  isLoaded: false,
  packagePreview: undefined,

  load: async () => {
    const items = await window.api.specialist.list()
    set({ items, isLoaded: true })
  },

  create: async (input: CreateSpecialistInput) => {
    const view = await window.api.specialist.create(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    const items = await window.api.specialist.list()
    set({ items })
    return view
  },

  update: async (input: UpdateSpecialistInput) => {
    const view = await window.api.specialist.update(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    const items = await window.api.specialist.list()
    set({ items })
    return view
  },

  setEnabled: async (id: string, enabled: boolean) => {
    await window.api.specialist.setEnabled({ id, enabled })
    const items = await window.api.specialist.list()
    set({ items })
  },

  delete: async (id: string, expectedRevision: number) => {
    await window.api.specialist.delete({ id, expectedRevision })
    const items = await window.api.specialist.list()
    set({ items })
  },

  duplicate: async (id: string) => window.api.specialist.duplicate({ id }),

  selectPackage: async () => {
    const result = await window.api.specialist.selectPackage()
    set({ packagePreview: 'cancelled' in result ? undefined : result })
    return result
  },

  installPackage: async () => {
    const preview = useSpecialistStore.getState().packagePreview
    if (!preview) return { status: 'failed', code: 'candidate-invalid' }
    const result = await window.api.specialist.installPackage({
      candidateToken: preview.candidateToken
    })
    if (result.status === 'installed') {
      const items = await window.api.specialist.list()
      set({ items, packagePreview: undefined })
    }
    return result
  },

  cancelPackage: async () => {
    const preview = useSpecialistStore.getState().packagePreview
    if (preview) {
      await window.api.specialist.cancelPackage({ candidateToken: preview.candidateToken })
    }
    set({ packagePreview: undefined })
  }
}))

export { useSpecialistStore }
