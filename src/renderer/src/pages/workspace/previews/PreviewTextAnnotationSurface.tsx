import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { TextAnnotation } from '../../../../../shared/annotations'
import type { PreviewFileRendererProps } from './preview-types'
import { createAnnotationId } from '../annotations/annotation-id'
import { reconcileTextAnnotationRanges } from '../annotations/text-annotation-range'

type SelectionDraft = Readonly<{ quote: string; left: number; top: number; range: Range }>

const DRAFT_HIGHLIGHT_NAME = 'preview-annotation-draft'
const DRAFT_HIGHLIGHT_STYLE_ID = 'preview-annotation-draft-style'
const NO_ANNOTATIONS: readonly never[] = []

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
    },
    []
  )

  const captureSelection = (): void => {
    if (!source || !onAddAnnotation) {
      setSelection(undefined)
      return
    }
    const selected = window.getSelection()
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined
    const surface = surfaceRef.current
    if (!selected || !range || !surface || selected.isCollapsed) {
      setSelection(undefined)
      return
    }
    const ancestor = range.commonAncestorContainer
    if (!surface.contains(ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor)) {
      setSelection(undefined)
      return
    }
    const quote = selected.toString().trim()
    if (!quote) {
      setSelection(undefined)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelection({
      quote,
      left: Math.max(8, Math.min(rect.right + 6, window.innerWidth - 108)),
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 52)),
      range: range.cloneRange()
    })
  }

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
    setOpen(false)
    setSelection(undefined)
    setNote('')
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
            if (!next) setNote('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="fixed z-40 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              style={{ left: selection.left, top: selection.top }}
            >
              {t('Annotate')}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="bottom"
            collisionPadding={8}
            className="w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('To Agent')}
            </div>
            <blockquote className="max-h-28 overflow-auto rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-xs leading-5">
              {selection.quote}
            </blockquote>
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
