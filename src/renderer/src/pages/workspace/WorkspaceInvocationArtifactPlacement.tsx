import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { MessageArtifactList } from './WorkspaceMessageItem'
import type { MessageArtifact } from './WorkspaceArtifactVisibility'

const WorkspaceInvocationArtifactPlacement = ({
  placementId,
  artifacts,
  onPreviewArtifact
}: {
  placementId: string
  artifacts: MessageArtifact[]
  onPreviewArtifact: (artifact: MessageArtifact) => void
}): React.JSX.Element | null =>
  artifacts.length > 0 ? (
    <MessageScrollerItem messageId={placementId} className="min-w-0">
      <div className="px-4 pb-3 md:px-6">
        <div className="mx-auto w-full max-w-[56rem]">
          <MessageArtifactList artifacts={artifacts} onPreviewArtifact={onPreviewArtifact} />
        </div>
      </div>
    </MessageScrollerItem>
  ) : null

export { WorkspaceInvocationArtifactPlacement }
