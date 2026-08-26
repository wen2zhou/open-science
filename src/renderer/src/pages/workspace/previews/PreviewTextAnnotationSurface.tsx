import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { TextAnnotation } from '../../../../../shared/annotations'
import type { PreviewFileRendererProps } from './preview-types'
import {
  revealTextAnnotationRange,
  subscribeTextAnnotationReveal
} from '../annotations/annotation-reveal'
import { anchorSelectionTrigger } from '../annotations/annotation-trigger-anchor'
import { createAnnotationId } from '../annotations/annotation-id'
import { reconcileTextAnnotationRanges } from '../annotations/text-annotation-range'

type SelectionDraft = Readonly<{ quote: string; left: number; top: number; range: Range }>

const DRAFT_HIGHLIGHT_NAME = 'preview-annotation-draft'
const DRAFT_HIGHLIGHT_STYLE_ID = 'preview-annotation-draft-style'
const NO_ANNOTATIONS: readonly never[] = []

// Pointer interactions owned by the annotate UI itself; a pointerdown inside
// these must not clear the draft (the browser collapses the selection on any
// mousedown, so the draft can only survive through an exemption).
const ANNOTATE_UI_SELECTOR = '[data-annotation-trigger], [data-radix-popper-content-wrapper]'

const projectFileSource = (item: PreviewFileItem): TextAnnotation['source'] | undefined => {
  if (!item.projectId) return undefined
  return {
    kind: 'project-file',
    projectId: item.projectId,
    path: item.path,
    name: item.name,
    ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {})
  }
}

const belongsToPreview = (annotation: TextAnnotation, item: PreviewFileItem): boolean => {
  const source = annotation.source
  if (source.kind !== 'project-file' || !item.projectId) return false
  if (source.projectId !== item.projectId || source.path !== item.path) return false
  if (source.versionId || item.selectedVersionId) {
    return source.versionId === item.selectedVersionId
  }
  return true
}

const getDraftHighlight = (): Highlight | undefined => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return undefined
  if (!document.getElementById(DRAFT_HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = DRAFT_HIGHLIGHT_STYLE_ID
    style.textContent = `::highlight(${DRAFT_HIGHLIGHT_NAME}) {
      background-color: color-mix(in oklab, var(--primary) 22%, transparent);
      text-decoration: underline 0.125rem var(--primary);
    }`
    document.head.appendChild(style)
  }
  const current = CSS.highlights.get(DRAFT_HIGHLIGHT_NAME)
  if (current) return current
  const created = new Highlight()
  CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, created)
  return created
}

export const PreviewTextAnnotationSurface = ({
  item,
  activeAnnotations = NO_ANNOTATIONS,
  onAddAnnotation,
  onAnnotationError,
  children
}: PreviewFileRendererProps & { children: React.ReactNode }): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const ownedRanges = useRef(new Map<string, Range>())
  const pendingRangeRef = useRef<Range | null>(null)
  const [selection, setSelection] = useState<SelectionDraft>()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const source = projectFileSource(item)
  const matchingAnnotations = useMemo(
    () =>
      activeAnnotations.filter(
        (annotation): annotation is TextAnnotation =>
          annotation.kind === 'text' && belongsToPreview(annotation, item)
      ),
    [activeAnnotations, item]
  )

  useLayoutEffect(() => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    for (const range of ownedRanges.current.values()) highlight.delete(range)
    const surface = surfaceRef.current
    if (!surface) {
      ownedRanges.current.clear()
      return
    }
    ownedRanges.current = reconcileTextAnnotationRanges(
      surface,
      matchingAnnotations,
      ownedRanges.current
    )
    for (const range of ownedRanges.current.values()) highlight.add(range)
  }, [children, matchingAnnotations])

  useLayoutEffect(
    () => () => {
      const highlight = getDraftHighlight()
      if (!highlight) return
      for (const range of ownedRanges.current.values()) highlight.delete(range)
      ownedRanges.current.clear()
      if (pendingRangeRef.current) {
        highlight.delete(pendingRangeRef.current)
        pendingRangeRef.current = null
      }
    },
    []
  )

  // Opening the note editor collapses the native selection; the quoted text
  // must stay visible through the draft highlight until the draft resolves,
  // so the editor itself never needs to repeat the quote.
  useLayoutEffect(() => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    if (open && selection) {
      if (pendingRangeRef.current && pendingRangeRef.current !== selection.range) {
        highlight.delete(pendingRangeRef.current)
      }
      highlight.add(selection.range)
      pendingRangeRef.current = selection.range
    } else if (pendingRangeRef.current) {
      highlight.delete(pendingRangeRef.current)
      pendingRangeRef.current = null
    }
  }, [open, selection])

  const clearDraft = useCallback((): void => {
    // Only the surface whose editor is open owns a stale native selection
    // (a keyboard-opened editor never let the browser collapse it); clearing
    // it unconditionally would destroy a selection another surface is
    // building with this very pointerdown.
    if (open) window.getSelection()?.removeAllRanges()
    setSelection(undefined)
    setOpen(false)
    setNote('')
  }, [open])

  const captureSelection = (): void => {
    // While the note editor is open the draft is frozen; stray mouseup/keyup
    // events from the surface must neither replace nor drop it.
    if (open) return
    if (!source || !onAddAnnotation) {
      clearDraft()
      return
    }
    const selected = window.getSelection()
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined
    const surface = surfaceRef.current
    if (!selected || !range || !surface || selected.isCollapsed) {
      clearDraft()
      return
    }
    const ancestor = range.commonAncestorContainer
    if (!surface.contains(ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor)) {
      clearDraft()
      return
    }
    const quote = selected.toString().trim()
    if (!quote) {
      clearDraft()
      return
    }
    setSelection({
      quote,
      ...anchorSelectionTrigger(selected, {
        rect: surface.getBoundingClientRect(),
        width: surface.clientWidth
      }),
      range: range.cloneRange()
    })
  }

  useEffect(() => {
    // Clicking anywhere else collapses the selection without any event
    // reaching this surface; the draft must follow the real selection
    // instead of lingering over the text as a stale trigger.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
      clearDraft()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [clearDraft])

  useEffect(
    () =>
      // The composer card reveals a quote by id; only the surface owning that
      // annotation's range answers.
      subscribeTextAnnotationReveal((annotationId) => {
        const range = ownedRanges.current.get(annotationId)
        if (range) revealTextAnnotationRange(range)
      }),
    []
  )

  const add = (): void => {
    if (!selection || !source || !onAddAnnotation) return
    const annotation: TextAnnotation = {
      id: createAnnotationId(),
      kind: 'text',
      target: 'agent',
      quote: selection.quote,
      ...(note.trim() ? { note: note.trim() } : {}),
      source
    }
    const error = onAddAnnotation(annotation)
    if (error) {
      onAnnotationError?.(error)
      return
    }
    const highlight = getDraftHighlight()
    highlight?.add(selection.range)
    ownedRanges.current.set(annotation.id, selection.range)
    // The range now belongs to the confirmed annotation; clearing the draft
    // below must not withdraw the highlight it just adopted.
    pendingRangeRef.current = null
    clearDraft()
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={surfaceRef}
      data-preview-text-annotation-surface="true"
      data-annotation-active={matchingAnnotations.length > 0 ? 'true' : undefined}
      className="relative size-full rounded-md data-[annotation-active=true]:outline data-[annotation-active=true]:outline-1 data-[annotation-active=true]:outline-offset-[-1px] data-[annotation-active=true]:outline-primary/50"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
    >
      {children}
      {matchingAnnotations.length > 0 ? (
        <div className="absolute bottom-2 right-2 z-30 flex items-center gap-1 rounded-full border border-primary/40 bg-bg-000/95 px-2 py-0.5 text-[11px] font-medium text-primary shadow-sm">
          <Quote className="size-3" aria-hidden="true" />
          {t('Annotated for Agent')}
        </div>
      ) : null}
      {selection ? (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) {
              setNote('')
              // Escape keeps the draft (the trigger returns) but must still
              // withdraw a keyboard-triggered native selection.
              window.getSelection()?.removeAllRanges()
            }
          }}
        >
          <PopoverAnchor asChild>
            <span
              className="absolute h-7"
              style={{ left: selection.left, top: selection.top }}
              aria-hidden="true"
            />
          </PopoverAnchor>
          {open ? null : (
            <button
              type="button"
              data-annotation-trigger="true"
              className="absolute z-40 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              style={{ left: selection.left, top: selection.top }}
              // Browsers collapse the selection on mousedown before this
              // button's click lands; its mouseup/keyup must not re-enter
              // captureSelection or the draft (and this button) are dropped.
              onMouseUp={(event) => event.stopPropagation()}
              onKeyUp={(event) => event.stopPropagation()}
              onClick={() => setOpen(true)}
            >
              {t('Annotate')}
            </button>
          )}
          <PopoverContent
            align="start"
            side="bottom"
            collisionPadding={8}
            className="w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('To Agent')}
            </div>
            <label className="block text-xs font-medium" htmlFor={`preview-note-${item.id}`}>
              {t('Note (optional)')}
            </label>
            <Textarea
              id={`preview-note-${item.id}`}
              autoFocus
              value={note}
              maxLength={2_000}
              placeholder={t('Add context for the Agent')}
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button type="button" size="sm" onClick={add}>
                {t('Annotate')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
