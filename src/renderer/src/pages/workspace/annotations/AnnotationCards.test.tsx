// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Annotation } from '../../../../../shared/annotations'
import { AnnotationDraftCards, AnnotationMessageCards } from './AnnotationCards'

const annotations: Annotation[] = [
  {
    id: 'quote-1',
    kind: 'text',
    target: 'agent',
    quote: 'Compare this sentence.',
    source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
  },
  {
    id: 'point-1',
    kind: 'image-point',
    target: 'agent',
    note: 'Inspect the peak.',
    source: {
      kind: 'artifact-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'figure.png',
      path: 'artifact-version:project-1/session-1/artifact-1/version-1',
      mimeType: 'image/png'
    },
    point: { x: 0.5, y: 0.25 },
    naturalSize: { width: 1000, height: 400 }
  }
]

describe('AnnotationCards image projection', () => {
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
  })

  it.each([
    [
      'draft',
      <AnnotationDraftCards
        key="draft"
        annotations={annotations}
        disabled={false}
        onUpdateNote={vi.fn()}
        onRemove={vi.fn()}
      />
    ],
    ['sent', <AnnotationMessageCards key="sent" annotations={annotations} />]
  ])('keeps mixed annotation image numbering and pixels on the %s card', async (_name, card) => {
    await act(async () => root.render(card))
    expect(container.textContent).toContain('Text quote')
    expect(container.textContent).toContain('Image point 1')
    expect(container.textContent).toContain('Point 1 at 500, 100')
    expect(container.textContent).toContain('Inspect the peak.')
  })

  it('omits the source line from draft chips', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )
    // The chip sits next to the message it annotates and the quote preview
    // jumps back to the source text, so a source line only adds noise.
    expect(container.textContent).not.toContain('Source:')
    expect(container.textContent).not.toContain('Agent Message')
  })

  it('compresses the draft quote preview to a single line', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={[
            {
              id: 'long-quote',
              kind: 'text',
              target: 'agent',
              quote:
                'A very long quoted passage that would wrap across multiple lines when the card still showed the full text.',
              source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
            }
          ]}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const quoteLine = container.querySelector('[data-annotation-quote]')
    expect(quoteLine?.textContent).toContain('A very long quoted passage')
    expect(quoteLine?.className).toContain('truncate')
    expect(quoteLine?.className).not.toContain('line-clamp-2')
  })

  it('reveals the quoted text when the quote preview is clicked', async () => {
    const onReveal = vi.fn()
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
          onReveal={onReveal}
        />
      )
    )

    const quoteButtons = container.querySelectorAll<HTMLButtonElement>(
      'button[data-annotation-quote]'
    )
    // Only the text annotation jumps to its quoted text; the image point has
    // no textual source to reveal.
    expect(quoteButtons).toHaveLength(1)

    await act(async () => quoteButtons[0]?.click())
    expect(onReveal).toHaveBeenCalledWith('quote-1')
  })
})
