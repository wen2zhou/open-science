const rangeForTextOccurrence = (
  surface: HTMLElement,
  quote: string,
  occurrence = 0
): Range | undefined => {
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    nodes.push(textNode)
    text += textNode.data
  }
  let start = -1
  let from = 0
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(quote, from)
    if (start < 0) return undefined
    from = start + quote.length
  }
  const end = start + quote.length
  let offset = 0
  let startNode: Text | undefined
  let endNode: Text | undefined
  let startOffset = 0
  let endOffset = 0
  for (const node of nodes) {
    const nextOffset = offset + node.data.length
    if (!startNode && start >= offset && start <= nextOffset) {
      startNode = node
      startOffset = start - offset
    }
    if (!endNode && end >= offset && end <= nextOffset) {
      endNode = node
      endOffset = end - offset
      break
    }
    offset = nextOffset
  }
  if (!startNode || !endNode) return undefined
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

export { rangeForTextOccurrence }
