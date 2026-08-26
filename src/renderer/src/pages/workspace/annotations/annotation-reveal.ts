// Revealing a draft annotation from the composer: the card cannot reach the
// reading surface that owns the quoted range, so both sides meet at this
// module — cards publish a reveal request, surfaces answer with the range they
// own, and the flash/scroll choreography lives entirely here.

const REVEAL_EVENT = 'text-annotation-reveal'
const REVEAL_HIGHLIGHT_NAME = 'agent-annotation-reveal'
const REVEAL_DURATION_MS = 1_600

let revealedRange: Range | undefined
let revealTimer: ReturnType<typeof setTimeout> | undefined

const requestTextAnnotationReveal = (annotationId: string): void => {
  document.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: annotationId }))
}

const subscribeTextAnnotationReveal = (listener: (annotationId: string) => void): (() => void) => {
  const handler = (event: Event): void => {
    listener((event as CustomEvent<string>).detail)
  }
  document.addEventListener(REVEAL_EVENT, handler)
  return () => document.removeEventListener(REVEAL_EVENT, handler)
}

const revealTextAnnotationRange = (range: Range): void => {
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return

  const highlight = globalThis.CSS.highlights.get(REVEAL_HIGHLIGHT_NAME) ?? new Highlight()
  if (revealedRange) highlight.delete(revealedRange)
  highlight.add(range)
  globalThis.CSS.highlights.set(REVEAL_HIGHLIGHT_NAME, highlight)
  revealedRange = range

  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    if (revealedRange) highlight.delete(revealedRange)
    revealedRange = undefined
  }, REVEAL_DURATION_MS)
}

export { requestTextAnnotationReveal, revealTextAnnotationRange, subscribeTextAnnotationReveal }
