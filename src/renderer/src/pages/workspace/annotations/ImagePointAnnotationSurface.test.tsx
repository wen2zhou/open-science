// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { ImagePointAnnotationSurface } from './ImagePointAnnotationSurface'

const item: PreviewFileItem = {
  id: 'artifact-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'figure.png',
  type: 'file',
  path: createArtifactVersionLocator({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1'
  }),
  format: 'image',
  name: 'figure.png',
  mimeType: 'image/png',
  artifactId: 'artifact-1',
  selectedVersionId: 'version-1'
}

describe('ImagePointAnnotationSurface', () => {
  let container: HTMLDivElement
  let root: Root
  let onAdd: NonNullable<ComponentProps<typeof ImagePointAnnotationSurface>['onAdd']>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onAdd = vi.fn()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const renderSurface = async (
    props: Partial<ComponentProps<typeof ImagePointAnnotationSurface>> = {}
  ): Promise<HTMLImageElement> => {
    await act(async () => {
      root.render(
        <ImagePointAnnotationSurface
          item={item}
          src="blob:figure"
          activeAnnotations={[]}
          onAdd={onAdd}
          onAnnotationError={vi.fn()}
          onImageError={vi.fn()}
          {...props}
        />
      )
    })
    const surface = container.querySelector<HTMLElement>('[data-image-annotation-surface]')!
    const image = container.querySelector<HTMLImageElement>('img')!
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 400 }
    })
    surface.getBoundingClientRect = () =>
      ({ left: 10, top: 20, right: 410, bottom: 420, width: 400, height: 400 }) as DOMRect
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 400 }
    })
    await act(async () => image.dispatchEvent(new Event('load', { bubbles: true })))
    return image
  }

  const pointer = async (
    target: Element,
    type: 'pointerdown' | 'pointerup',
    clientX: number,
    clientY: number
  ): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }))
    })
  }

  it('creates a temporary numbered point only for a short left click in real image pixels', async () => {
    const image = await renderSurface()

    // The 2:1 image is vertically letterboxed inside the square surface (real pixels y=120..320).
    await pointer(image, 'pointerdown', 210, 80)
    await pointer(image, 'pointerup', 210, 80)
    expect(document.body.textContent).not.toContain('Image point 1')

    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 213, 222)
    expect(document.body.textContent).toContain('Image point 1')
    expect(document.querySelector('textarea')?.getAttribute('aria-label')).toBe('Annotation note')
  })

  it('discards a temporary point on cancel and never adds it to the draft', async () => {
    const image = await renderSurface()
    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 210, 220)

    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click()
    })

    expect(onAdd).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Image point 1')
    expect(document.activeElement).toBe(
      container.querySelector<HTMLElement>('[data-image-annotation-surface]')
    )
  })

  it('requires a note and saves normalized coordinates with natural dimensions and fixed Version', async () => {
    const image = await renderSurface()
    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 210, 220)

    const annotate = (): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Annotate'
      )
    await act(async () => annotate()?.click())
    expect(document.body.textContent).toContain('Add a note for this image annotation')
    expect(onAdd).not.toHaveBeenCalled()

    const note = document.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(note, 'Inspect this peak.')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => annotate()?.click())

    expect(onAdd).toHaveBeenCalledWith({
      id: expect.stringMatching(/^annotation-/),
      kind: 'image-point',
      target: 'agent',
      note: 'Inspect this peak.',
      source: expect.objectContaining({
        kind: 'artifact-version',
        versionId: 'version-1',
        path: expect.stringMatching(/^artifact-version:/)
      }),
      point: { x: 0.5, y: 0.5 },
      naturalSize: { width: 800, height: 400 }
    })
  })

  it('does not create a point when pointer movement exceeds the click threshold', async () => {
    const image = await renderSurface()
    await pointer(image, 'pointerdown', 100, 200)
    await pointer(image, 'pointerup', 125, 220)

    expect(document.body.textContent).not.toContain('Image point 1')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('reopens an existing numbered marker for keyboard note editing or removal', async () => {
    const onUpdateNote = vi.fn()
    const onRemove = vi.fn()
    await renderSurface({
      activeAnnotations: [
        {
          id: 'point-existing',
          kind: 'image-point',
          target: 'agent',
          note: 'Original note',
          source: {
            kind: 'artifact-version',
            projectId: 'project-1',
            sessionId: 'session-1',
            versionId: 'version-1',
            name: 'figure.png',
            path: item.path,
            mimeType: 'image/png'
          },
          point: { x: 0.5, y: 0.5 },
          naturalSize: { width: 800, height: 400 }
        }
      ],
      onUpdateNote,
      onRemove
    })

    const marker = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '1'
    )!
    await act(async () => marker.click())
    const note = document.querySelector('textarea')!
    expect(note.value).toBe('Original note')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(note, 'Updated note')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    )
    expect(onUpdateNote).toHaveBeenCalledWith('point-existing', 'Updated note')

    await act(async () => marker.click())
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Remove annotation')
        ?.click()
    )
    expect(onRemove).toHaveBeenCalledWith('point-existing')
  })
})
