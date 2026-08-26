// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  requestTextAnnotationReveal,
  revealTextAnnotationRange,
  subscribeTextAnnotationReveal
} from './annotation-reveal'

class TestHighlight extends Set<Range> {}

describe('annotation reveal', () => {
  let highlights: Map<string, TestHighlight>
  let paragraph: HTMLParagraphElement

  beforeEach(() => {
    vi.useFakeTimers()
    highlights = new Map()
    vi.stubGlobal('Highlight', TestHighlight)
    vi.stubGlobal('CSS', { highlights })
    paragraph = document.createElement('p')
    paragraph.textContent = 'quoted evidence stays visible'
    document.body.appendChild(paragraph)
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    paragraph.remove()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  const textRange = (): Range => {
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    return range
  }

  it('scrolls to the range and flashes a stronger highlight', () => {
    revealTextAnnotationRange(textRange())

    expect(paragraph.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    const revealed = Array.from(highlights.get('agent-annotation-reveal') ?? [])
    expect(revealed.map((range) => range.toString())).toContain('quoted evidence stays visible')

    vi.advanceTimersByTime(1_600)
    expect(Array.from(highlights.get('agent-annotation-reveal') ?? [])).toHaveLength(0)
  })

  it('replaces an earlier reveal instead of stacking ranges', () => {
    revealTextAnnotationRange(textRange())
    revealTextAnnotationRange(textRange())
    expect(Array.from(highlights.get('agent-annotation-reveal') ?? [])).toHaveLength(1)

    vi.advanceTimersByTime(1_600)
    expect(Array.from(highlights.get('agent-annotation-reveal') ?? [])).toHaveLength(0)
  })

  it('delivers reveal requests from composer cards to subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTextAnnotationReveal(listener)

    requestTextAnnotationReveal('annotation-1')
    expect(listener).toHaveBeenCalledWith('annotation-1')

    unsubscribe()
    requestTextAnnotationReveal('annotation-2')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
