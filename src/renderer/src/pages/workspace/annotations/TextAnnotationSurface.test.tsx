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
  })
})
