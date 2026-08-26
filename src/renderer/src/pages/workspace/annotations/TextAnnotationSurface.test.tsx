// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TextAnnotation } from '../../../../../shared/annotations'
import { requestTextAnnotationReveal } from './annotation-reveal'
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

class EditorTestHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges)
  }
}

describe('TextAnnotationSurface note editor highlight', () => {
  let container: HTMLDivElement
  let root: Root
  let highlights: Map<string, Set<Range>>

  beforeEach(() => {
    highlights = new Map()
    vi.stubGlobal('Highlight', EditorTestHighlight)
    vi.stubGlobal('CSS', { highlights })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
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

  const annotateTrigger = (): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Annotate'
    )

  const draftRanges = (): Range[] => Array.from(highlights.get('agent-annotation-draft') ?? [])

  it('keeps the selection highlighted while the note editor is open', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(draftRanges()).toHaveLength(0)

    await act(async () => annotateTrigger()?.click())
    expect(draftRanges().map((range) => range.toString())).toContain('selectable agent reply')
  })

  it('clears the pending highlight when the editor is dismissed', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    expect(draftRanges()).toHaveLength(1)

    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())

    expect(draftRanges()).toHaveLength(0)
  })

  it('does not repeat the selected quote inside the note editor', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())

    const editor = document.querySelector('[data-radix-popper-content-wrapper]')
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toContain('To Agent')
    // The selection stays highlighted in the message itself; the editor never
    // repeats the quote.
    expect(editor?.textContent).not.toContain('selectable agent reply')
  })

  it('reveals the quoted text when the composer card requests it', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          sessionId="session-1"
          messageId="message-1"
          activeAnnotations={[]}
          onAdd={onAdd}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())
    const added = onAdd.mock.calls[0]?.[0] as TextAnnotation

    await act(async () => requestTextAnnotationReveal(added.id))

    const revealed = Array.from(highlights.get('agent-annotation-reveal') ?? [])
    expect(revealed.map((range) => range.toString())).toContain('selectable agent reply')
    expect(scrollIntoView).toHaveBeenCalled()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('clears the native selection when the editor is dismissed by escape', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    // A keyboard-triggered editor keeps the native selection alive; closing
    // the editor must withdraw it, not only the pending highlight.
    expect(window.getSelection()?.rangeCount).toBeGreaterThan(0)

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector('textarea')).toBeNull()
    expect(window.getSelection()?.rangeCount).toBe(0)
    expect(draftRanges()).toHaveLength(0)
  })

  it('clears the native selection when clicking outside the open editor', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    expect(window.getSelection()?.rangeCount).toBeGreaterThan(0)

    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })

    expect(document.querySelector('textarea')).toBeNull()
    expect(window.getSelection()?.rangeCount).toBe(0)
    expect(draftRanges()).toHaveLength(0)
  })

  it('clears the highlight when the annotation is removed from the draft', async () => {
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    const renderWith = async (active: readonly TextAnnotation[]): Promise<void> => {
      await act(async () =>
        root.render(
          <TextAnnotationSurface
            sessionId="session-1"
            messageId="message-1"
            activeAnnotations={active}
            onAdd={onAdd}
            onError={vi.fn()}
          >
            <p>selectable agent reply</p>
          </TextAnnotationSurface>
        )
      )
    }
    await renderWith([])
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())
    const added = onAdd.mock.calls[0]?.[0]!
    expect(draftRanges()).toHaveLength(1)

    // The composer drops the annotation (card removed) — the highlight on the
    // message must withdraw with it.
    await renderWith([])
    expect(draftRanges()).toHaveLength(0)
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()
  })

  it('hands the pending highlight over to the confirmed annotation', async () => {
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          sessionId="session-1"
          messageId="message-1"
          activeAnnotations={[]}
          onAdd={onAdd}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const pending = draftRanges()[0]

    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())

    expect(onAdd).toHaveBeenCalledTimes(1)
    const added = onAdd.mock.calls[0]?.[0]
    expect(added?.quote).toBe('selectable agent reply')
    expect(draftRanges()).toEqual([pending])
    expect(draftRanges()[0]?.toString()).toBe('selectable agent reply')

    // The pending range keeps its highlight across later annotation syncs.
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          sessionId="session-1"
          messageId="message-1"
          activeAnnotations={[added]}
          onAdd={onAdd}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    expect(draftRanges()).toEqual([pending])
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

  it('keeps the note editor open while typing a note', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const editor = document.querySelector<HTMLTextAreaElement>('textarea')
    expect(editor).not.toBeNull()

    await act(async () => {
      editor!.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'first character')
      editor!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const survivingEditor = document.querySelector<HTMLTextAreaElement>('textarea')
    expect(survivingEditor).toBe(editor)
    expect(survivingEditor?.value).toBe('first character')
  })

  it('shows only the trigger after selecting again, not the note editor', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    expect(document.querySelector('textarea')).not.toBeNull()

    // The user dismisses the editor and selects different text.
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector('textarea')).toBeNull()

    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('clears the draft trigger when clicking anywhere outside it', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()

    // Clicking elsewhere collapses the selection in a real browser; the
    // leftover trigger must not linger over the text.
    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })

    expect(annotateTrigger()).toBeUndefined()
  })

  it('hides the trigger while the note editor is open and restores it after escape', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())

    expect(annotateTrigger()).toBeUndefined()
    expect(document.querySelector('textarea')).not.toBeNull()

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(annotateTrigger()).toBeDefined()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('does not reopen the note editor for a fresh selection after the draft was cleared', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    expect(document.querySelector('textarea')).not.toBeNull()

    // The draft is cleared from outside while the editor was open; a stale
    // open state must not resurrect the editor with the next selection.
    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })
    expect(annotateTrigger()).toBeUndefined()
    expect(document.querySelector('textarea')).toBeNull()

    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('places the trigger beside the last line of a multi-line selection', async () => {
    const paragraph = await renderSurface()
    // The surface itself sits away from the viewport origin; the trigger must
    // be placed in surface-local coordinates and scroll with the text.
    const surface = container.querySelector<HTMLElement>('[data-annotation-surface]')!
    surface.getBoundingClientRect = () =>
      ({
        left: 90,
        top: 10,
        right: 490,
        bottom: 610,
        width: 400,
        height: 600,
        x: 90,
        y: 10,
        toJSON: () => ({})
      }) as DOMRect
    Object.defineProperty(surface, 'clientWidth', { configurable: true, value: 400 })
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
      value: () => [lineRect(100, 20, 300, 40), lineRect(100, 50, 120, 70)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => lineRect(100, 20, 300, 70)
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const trigger = annotateTrigger()
    // The trigger follows the selection's visible end (last line), not the
    // bounding box's far right edge, and stays anchored to the surface so it
    // scrolls with the text instead of floating at a stale viewport position.
    expect(trigger?.className).toContain('absolute')
    expect(trigger?.className).not.toContain('fixed')
    expect(trigger?.style.left).toBe('36px')
    expect(trigger?.style.top).toBe('66px')
  })
})
