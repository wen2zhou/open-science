/**
 * Placement for the transient "Annotate" trigger button shown next to a live
 * text selection. The trigger anchors beside the selection's visible end —
 * the last line for a forward drag and the first line for a backward drag —
 * so it stays near the text the user is looking at instead of jumping to the
 * selection's bounding-box corner, and it is clamped inside the viewport.
 */

type SelectionTriggerViewport = Readonly<{ width: number; height: number }>

const TRIGGER_ANCHOR_OFFSET = 6
const TRIGGER_VIEWPORT_MARGIN = 8
const TRIGGER_VIEWPORT_RESERVED_WIDTH = 108
const TRIGGER_VIEWPORT_RESERVED_HEIGHT = 52

const isBackwardSelection = (selected: Selection): boolean => {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selected
  if (!anchorNode || !focusNode) return false
  if (anchorNode === focusNode) return focusOffset < anchorOffset
  const relation = anchorNode.compareDocumentPosition(focusNode)
  return (relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0
}

const anchorSelectionTrigger = (
  selected: Selection,
  viewport: SelectionTriggerViewport
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
  return {
    left: Math.max(
      TRIGGER_VIEWPORT_MARGIN,
      Math.min(
        (anchorRect?.right ?? 0) + TRIGGER_ANCHOR_OFFSET,
        viewport.width - TRIGGER_VIEWPORT_RESERVED_WIDTH
      )
    ),
    top: Math.max(
      TRIGGER_VIEWPORT_MARGIN,
      Math.min(
        (anchorRect?.bottom ?? 0) + TRIGGER_ANCHOR_OFFSET,
        viewport.height - TRIGGER_VIEWPORT_RESERVED_HEIGHT
      )
    )
  }
}

export { anchorSelectionTrigger }
