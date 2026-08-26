// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Annotation, TextAnnotation } from '../../../../../shared/annotations'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { PreviewTextAnnotationSurface } from './PreviewTextAnnotationSurface'

const item = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'preview-1',
  type: 'file',
  title: 'notes.md',
  name: 'notes.md',
  path: '/project/notes.md',
  format: 'markdown',
  source: 'artifact',
  projectId: 'project-1',
  sessionId: 'session-1',
  selectedVersionId: 'version-7',
  ...overrides
})

const annotation = (overrides: Partial<TextAnnotation> = {}): TextAnnotation => ({
  id: 'annotation-1',
  kind: 'text',
  target: 'agent',
  quote: 'confidence intervals overlap',
  source: {
    kind: 'project-file',
    projectId: 'project-1',
    path: '/project/notes.md',
    name: 'notes.md',
    versionId: 'version-7',
    sessionId: 'session-1'
  },
  ...overrides
})

describe('PreviewTextAnnotationSurface', () => {
  let container: HTMLDivElement
  let root: Root
  let registeredRanges: Set<Range>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    registeredRanges = new Set()
    class TestHighlight extends Set<Range> {}
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: TestHighlight
    })
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        highlights: {
          get: vi.fn(() => ({
            add: (range: Range) => registeredRanges.add(range),
            delete: (range: Range) => registeredRanges.delete(range)
          })),
          set: vi.fn((_name: string, highlight: Set<Range>) => {
            registeredRanges = highlight
          }),
          delete: vi.fn(() => registeredRanges.clear())
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.getSelection()?.removeAllRanges()
  })

  const renderSurface = async ({
    activeAnnotations = [],
    onAddAnnotation = vi.fn(() => undefined),
    previewItem = item(),
    content = 'Experiment result: confidence intervals overlap.'
  }: {
    activeAnnotations?: readonly Annotation[]
    onAddAnnotation?: (annotation: Annotation) => undefined
    previewItem?: PreviewFileItem
    content?: string
  } = {}): Promise<void> => {
    await act(async () => {
      root.render(
        <PreviewTextAnnotationSurface
          item={previewItem}
          activeAnnotations={activeAnnotations}
          onAddAnnotation={onAddAnnotation}
          onAnnotationError={vi.fn()}
        >
          <p>{content}</p>
        </PreviewTextAnnotationSurface>
      )
    })
  }

  const selectRange = async (start: number, end: number): Promise<void> => {
    const text = container.querySelector('p')?.firstChild
    if (!text) throw new Error('Preview text was not rendered')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, end)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        right: 120,
        top: 20,
        bottom: 40,
        width: 110,
        height: 20,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    await act(async () => {
      container
        .querySelector('[data-preview-text-annotation-surface="true"]')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
  }

  const selectQuote = (): Promise<void> => selectRange(19, 47)

  const confirmAnnotation = async (): Promise<void> => {
    const entry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => entry?.click())
    const actions = Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => actions.at(-1)?.click())
  }

  it('creates a versioned project-file annotation only after confirmation', async () => {
    const onAddAnnotation = vi.fn<(annotation: Annotation) => undefined>(() => undefined)
    await renderSurface({ onAddAnnotation })
    await selectQuote()

    expect(onAddAnnotation).not.toHaveBeenCalled()
    const entry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => entry?.click())
    const actions = Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => actions.at(-1)?.click())

    expect(onAddAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        quote: 'confidence intervals overlap',
        source: {
          kind: 'project-file',
          projectId: 'project-1',
          path: '/project/notes.md',
          name: 'notes.md',
          versionId: 'version-7',
          sessionId: 'session-1'
        }
      })
    )
    expect(registeredRanges.size).toBe(1)
  })

  it('does not create an annotation for cancellation or an empty selection', async () => {
    const onAddAnnotation = vi.fn(() => undefined)
    await renderSurface({ onAddAnnotation })

    await act(async () => {
      container
        .querySelector('[data-preview-text-annotation-surface="true"]')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('To Agent')

    await selectQuote()
    const entry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => entry?.click())
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())

    expect(onAddAnnotation).not.toHaveBeenCalled()
  })

  it('reprojects matching draft quotes after reopening and ignores other sources', async () => {
    await renderSurface({
      activeAnnotations: [
        annotation(),
        annotation({
          id: 'annotation-other',
          source: {
            kind: 'project-file',
            projectId: 'project-1',
            path: '/project/other.md',
            versionId: 'version-7'
          }
        }),
        annotation({
          id: 'annotation-other-version',
          source: {
            kind: 'project-file',
            projectId: 'project-1',
            path: '/project/notes.md',
            versionId: 'version-8'
          }
        })
      ]
    })

    expect(container.textContent).toContain('Annotated for Agent')
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(registeredRanges.size).toBe(1)

    await act(async () => root.render(<div>Preview closed</div>))
    expect(registeredRanges.size).toBe(0)

    await renderSurface({ activeAnnotations: [annotation()] })
    expect(registeredRanges.size).toBe(1)

    await renderSurface({ activeAnnotations: [] })
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()
    expect(registeredRanges.size).toBe(0)
  })

  it('preserves exact duplicate ranges until deletion and falls back only after reopening', async () => {
    const onAddAnnotation = vi.fn<(annotation: Annotation) => undefined>(() => undefined)
    const content = 'repeat then repeat'
    await renderSurface({ onAddAnnotation, content })
    await selectRange(12, 18)
    await confirmAnnotation()
    const second = onAddAnnotation.mock.calls[0]?.[0] as TextAnnotation

    await renderSurface({ activeAnnotations: [second], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([12])

    await selectRange(0, 6)
    await confirmAnnotation()
    const first = onAddAnnotation.mock.calls[1]?.[0] as TextAnnotation
    await renderSurface({ activeAnnotations: [second, first], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([12, 0])

    await renderSurface({ activeAnnotations: [second], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([12])

    await act(async () => root.render(<div>Preview closed</div>))
    await renderSurface({ activeAnnotations: [second], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([0])
  })

  it('does not expose annotation controls without a project identity', async () => {
    await renderSurface({ previewItem: item({ projectId: undefined, source: 'local' }) })
    await selectQuote()

    expect(document.body.textContent).not.toContain('To Agent')
  })
})
