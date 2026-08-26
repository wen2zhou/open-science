// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TextAnnotation } from '../../../../../shared/annotations'
import { TextAnnotationSurface } from './TextAnnotationSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class TestHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges)
  }
}

const highlights = new Map<string, TestHighlight>()
const annotation = (id: string, quote: string): TextAnnotation => ({
  id,
  kind: 'text',
  target: 'agent',
  quote,
  source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
})

describe('TextAnnotationSurface highlight restoration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    highlights.clear()
    vi.stubGlobal('Highlight', TestHighlight)
    vi.stubGlobal('CSS', { highlights })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderSurface = async (
    activeAnnotations: readonly TextAnnotation[],
    messageId = 'message-1',
    content = 'repeat then repeat'
  ): Promise<void> => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          sessionId="session-1"
          messageId={messageId}
          activeAnnotations={activeAnnotations}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <p>{content}</p>
        </TextAnnotationSurface>
      )
    )
  }

  it('rebuilds duplicate quote ranges deterministically after a virtualized remount', async () => {
    const active = [annotation('first', 'repeat'), annotation('second', 'repeat')]
    await renderSurface(active)

    const firstMountRanges = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(firstMountRanges.map((range) => range.startOffset)).toEqual([0, 12])

    await renderSurface(active, 'message-2')
    expect(highlights.has('agent-annotation-draft')).toBe(false)
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()

    await act(async () => root.unmount())
    expect(highlights.has('agent-annotation-draft')).toBe(false)
    root = createRoot(container)
    await renderSurface(active)

    const remountedRanges = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(remountedRanges.map((range) => range.startOffset)).toEqual([0, 12])
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Annotated for Agent')
  })

  it('keeps the non-color annotation state when a saved quote can no longer be projected', async () => {
    const active = [annotation('missing', 'no longer present')]
    await renderSurface(active)

    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])).toHaveLength(0)
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Annotated for Agent')

    await renderSurface(active, 'message-1', 'no longer present')
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])).toHaveLength(1)

    await renderSurface(active, 'message-1', 'stream replaced the quote')
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])).toHaveLength(0)
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
  })

  it('reprojects an Agent quote when streaming mutates the mounted text node in place', async () => {
    const active = [annotation('streaming', 'repeat')]
    await renderSurface(active)
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])[0]?.startOffset).toBe(0)

    await renderSurface(active, 'message-1', 'prefix repeat then repeat')
    const range = Array.from(highlights.get('agent-annotation-draft') ?? [])[0]
    expect(range?.toString()).toBe('repeat')
    expect(range?.startOffset).toBe(7)
  })
})

describe('TextAnnotationSurface annotate trigger', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.getSelection()?.removeAllRanges()
  })

  const renderSurface = async (): Promise<HTMLParagraphElement> => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          sessionId="session-1"
          messageId="message-1"
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    return container.querySelector('p')!
  }

  const annotateTrigger = (): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Annotate'
    )

  const commitSelection = async (paragraph: HTMLParagraphElement): Promise<void> => {
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 10,
          right: 120,
          top: 20,
          bottom: 40,
          width: 110,
          height: 20,
          x: 10,
          y: 20,
          toJSON: () => ({})
        }) as DOMRect
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  }

  it('keeps the trigger alive when clicking it collapses the browser selection', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    const trigger = annotateTrigger()
    expect(trigger).toBeDefined()

    // A real browser collapses the selection on mousedown before the click
    // lands, and the button's mouseup bubbles back into the surface.
    window.getSelection()?.removeAllRanges()
    await act(async () => trigger!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const surviving = annotateTrigger()
    expect(surviving).toBe(trigger)

    await act(async () => surviving?.click())
    expect(document.querySelector('textarea')).not.toBeNull()
  })

  it('places the trigger beside the last line of a multi-line selection', async () => {
    const paragraph = await renderSurface()
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    const lineRect = (left: number, top: number, right: number, bottom: number): DOMRect =>
      ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({})
      }) as DOMRect
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [lineRect(10, 10, 300, 30), lineRect(10, 40, 120, 60)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => lineRect(10, 10, 300, 60)
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const trigger = annotateTrigger()
    // The trigger follows the selection's visible end (last line), not the
    // bounding box's far right edge.
    expect(trigger?.style.left).toBe('126px')
    expect(trigger?.style.top).toBe('66px')
  })
})
