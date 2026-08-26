// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { anchorSelectionTrigger } from './annotation-trigger-anchor'

const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
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

describe('anchorSelectionTrigger', () => {
  // The surface sits at viewport (90, 10); selection rects are viewport
  // coordinates. The trigger must be placed in surface-local coordinates so
  // it scrolls with the text instead of drifting as a fixed overlay.
  const container = { rect: rect(90, 10, 490, 610), width: 400 }

  afterEach(() => {
    document.body.innerHTML = ''
    document.getSelection()?.removeAllRanges()
  })

  const selectWithRects = (rects: DOMRect[], bounding: DOMRect, backward = false): Selection => {
    const paragraph = document.createElement('p')
    paragraph.textContent = 'first line then second line'
    document.body.appendChild(paragraph)
    const text = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => rects
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => bounding
    })
    const selection = document.getSelection()!
    selection.removeAllRanges()
    if (backward) {
      // The user dragged backwards: the focus end sits earlier in the document.
      selection.setBaseAndExtent(text, 5, text, 0)
    } else {
      selection.setBaseAndExtent(text, 0, text, 5)
    }
    Object.defineProperty(selection, 'getRangeAt', {
      configurable: true,
      value: () => range
    })
    return selection
  }

  it('anchors a forward selection at its last line, in surface-local coordinates', () => {
    const selection = selectWithRects(
      [rect(100, 20, 300, 40), rect(100, 50, 120, 70)],
      rect(100, 20, 300, 70)
    )

    expect(anchorSelectionTrigger(selection, container)).toEqual({ left: 36, top: 66 })
  })

  it('anchors a backward selection at its first line, in surface-local coordinates', () => {
    const selection = selectWithRects(
      [rect(100, 20, 300, 40), rect(100, 50, 120, 70)],
      rect(100, 20, 300, 70),
      true
    )

    expect(anchorSelectionTrigger(selection, container)).toEqual({ left: 216, top: 36 })
  })

  it('keeps the trigger inside the surface width', () => {
    const selection = selectWithRects([rect(100, 20, 480, 40)], rect(100, 20, 480, 40))

    expect(anchorSelectionTrigger(selection, container)).toEqual({ left: 392, top: 36 })
  })
})
