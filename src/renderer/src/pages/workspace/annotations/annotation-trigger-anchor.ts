/**
 * Placement for the transient "Annotate" trigger button shown next to a live
 * text selection. The trigger anchors beside the selection's visible end —
 * the last line for a forward drag and the first line for a backward drag —
 * so it stays near the text the user is looking at instead of jumping to the
 * selection's bounding-box corner.
 *
 * Coordinates are surface-local: viewport geometry is translated through the
 * surface rectangle, and the trigger is rendered absolutely inside the
 * surface so it scrolls with the text. A fixed-position viewport snapshot
 * would drift away from the selection as soon as the message list scrolls,
 * and would break entirely under any transformed ancestor.
 */

type SelectionTriggerContainer = Readonly<{ rect: DOMRect; width: number }>

const TRIGGER_ANCHOR_OFFSET = 6
const TRIGGER_CONTAINER_MARGIN = 8

const isBackwardSelection = (selected: Selection): boolean => {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selected
  if (!anchorNode || !focusNode) return false
  if (anchorNode === focusNode) return focusOffset < anchorOffset
  const relation = anchorNode.compareDocumentPosition(focusNode)
  return (relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0
}

const anchorSelectionTrigger = (
  selected: Selection,
  container: SelectionTriggerContainer
): { left: number; top: number } => {
  const range = selected.rangeCount > 0 ? selected.getRangeAt(0) : undefined
  // jsdom and detached ranges expose neither geometry method.
  const rects =
    range && typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
  const bounding =
    range && typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : undefined
  const anchorRect =
    rects.length > 0
      ? isBackwardSelection(selected)
        ? rects[0]
        : rects[rects.length - 1]
      : bounding
  const localLeft = (anchorRect?.right ?? 0) + TRIGGER_ANCHOR_OFFSET - container.rect.left
  return {
    left: Math.max(0, Math.min(localLeft, container.width - TRIGGER_CONTAINER_MARGIN)),
    top: (anchorRect?.bottom ?? 0) + TRIGGER_ANCHOR_OFFSET - container.rect.top
  }
}

export { anchorSelectionTrigger }
