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
  const viewport = { width: 1024, height: 768 }

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

  it('anchors a forward selection at its last line rect', () => {
    const selection = selectWithRects(
      [rect(10, 10, 300, 30), rect(10, 40, 120, 60)],
      rect(10, 10, 300, 60)
    )

    expect(anchorSelectionTrigger(selection, viewport)).toEqual({ left: 126, top: 66 })
  })

  it('anchors a backward selection at its first line rect', () => {
    const selection = selectWithRects(
      [rect(10, 10, 300, 30), rect(10, 40, 120, 60)],
      rect(10, 10, 300, 60),
      true
    )

    expect(anchorSelectionTrigger(selection, viewport)).toEqual({ left: 306, top: 36 })
  })

  it('keeps the trigger inside the viewport for selections near the edges', () => {
    const selection = selectWithRects([rect(10, 700, 1020, 760)], rect(10, 700, 1020, 760))

    expect(anchorSelectionTrigger(selection, viewport)).toEqual({ left: 916, top: 716 })
  })
})
