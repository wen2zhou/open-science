import type { GetArtifactVersionProvenanceRequest } from './artifact-provenance'
import type { NotebookKernelKind } from './notebook'
import type { AgentFrameworkId } from './settings'

export type ArtifactCodeReconstruction = {
  code: string
  language: NotebookKernelKind
  generatedAt: string
  frameworkId: AgentFrameworkId
  model: string
  sourceTruncated: boolean
}

export type ArtifactCodeReconstructionState =
  | {
      state: 'ready'
      language: NotebookKernelKind
      sourceTruncated: boolean
    }
  | {
      state: 'cached'
      value: ArtifactCodeReconstruction
    }
  | {
      state: 'unavailable'
      reason:
        | 'execution-unavailable'
        | 'producer-unavailable'
        | 'producer-script-missing'
        | 'helper-evidence-incomplete'
        | 'supporting-code-incomplete'
    }

export type GetArtifactCodeReconstructionRequest = GetArtifactVersionProvenanceRequest
export type GenerateArtifactCodeReconstructionRequest = GetArtifactVersionProvenanceRequest
