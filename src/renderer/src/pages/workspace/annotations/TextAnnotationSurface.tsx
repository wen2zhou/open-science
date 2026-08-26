import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { AnnotationValidationError, TextAnnotation } from '../../../../../shared/annotations'
import { anchorSelectionTrigger } from './annotation-trigger-anchor'
import { createAnnotationId } from './annotation-id'
import { reconcileTextAnnotationRanges } from './text-annotation-range'

type SelectionDraft = { quote: string; left: number; top: number; range: Range }

const DRAFT_HIGHLIGHT_NAME = 'agent-annotation-draft'
const draftHighlightRanges = new Map<string, Range>()

const syncDraftHighlights = (): void => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return
  if (draftHighlightRanges.size === 0) {
    CSS.highlights.delete(DRAFT_HIGHLIGHT_NAME)
    return
  }
  CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, new Highlight(...draftHighlightRanges.values()))
}

const TextAnnotationSurface = ({
  children,
  sessionId,
  messageId,
  activeAnnotations,
  onAdd,
  onError
}: {
  children: React.ReactNode
  sessionId: string
  messageId: string
  activeAnnotations: readonly TextAnnotation[]
  onAdd: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onError: (error: AnnotationValidationError) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const ownedHighlightIds = useRef(new Set<string>())
  const [selection, setSelection] = useState<SelectionDraft>()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const matchingAnnotations = useMemo(
    () =>
      activeAnnotations.filter(
        (annotation) =>
          annotation.source.kind === 'agent-message' &&
          annotation.source.sessionId === sessionId &&
          annotation.source.messageId === messageId
      ),
    [activeAnnotations, messageId, sessionId]
  )

  const captureSelection = (): void => {
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
    setSelection({
      quote,
      ...anchorSelectionTrigger(selected, {
        width: window.innerWidth,
        height: window.innerHeight
      }),
      range: range.cloneRange()
    })
  }

  useLayoutEffect(() => {
    const existing = new Map<string, Range>()
    for (const id of ownedHighlightIds.current) {
      const range = draftHighlightRanges.get(id)
      if (range) existing.set(id, range)
    }
    for (const id of ownedHighlightIds.current) draftHighlightRanges.delete(id)
    ownedHighlightIds.current.clear()
    const content = contentRef.current
    if (content) {
      const next = reconcileTextAnnotationRanges(content, matchingAnnotations, existing)
      for (const [id, range] of next) {
        ownedHighlightIds.current.add(id)
        draftHighlightRanges.set(id, range)
      }
    }
    syncDraftHighlights()
  }, [children, matchingAnnotations])

  useLayoutEffect(
    () => () => {
      for (const id of ownedHighlightIds.current) draftHighlightRanges.delete(id)
      syncDraftHighlights()
    },
    []
  )

  const add = (): void => {
    if (!selection) return
    const annotation: TextAnnotation = {
      id: createAnnotationId(),
      kind: 'text',
      target: 'agent',
      quote: selection.quote,
      ...(note.trim() ? { note: note.trim() } : {}),
      source: { kind: 'agent-message', sessionId, messageId }
    }
    const error = onAdd(annotation)
    if (error) {
      onError(error)
      return
    }
    ownedHighlightIds.current.add(annotation.id)
    draftHighlightRanges.set(annotation.id, selection.range)
    syncDraftHighlights()
    surfaceRef.current?.setAttribute('data-annotation-active', 'true')
    setOpen(false)
    setSelection(undefined)
    setNote('')
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={surfaceRef}
      data-annotation-surface="true"
      data-annotation-active={matchingAnnotations.length > 0 ? 'true' : undefined}
      className="relative rounded-md data-[annotation-active=true]:outline data-[annotation-active=true]:outline-1 data-[annotation-active=true]:outline-offset-4 data-[annotation-active=true]:outline-primary/50"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
    >
      <div ref={contentRef} className="contents">
        {children}
      </div>
      {matchingAnnotations.length > 0 ? (
        <div className="mt-2 flex w-fit items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
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
              // Browsers collapse the selection on mousedown before this
              // button's click lands; its mouseup/keyup must not re-enter
              // captureSelection or the draft (and this button) are dropped.
              onMouseUp={(event) => event.stopPropagation()}
              onKeyUp={(event) => event.stopPropagation()}
            >
              {t('Annotate')}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="bottom"
            className="w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('To Agent')}
            </div>
            <blockquote className="max-h-28 overflow-auto rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-xs leading-5">
              {selection.quote}
            </blockquote>
            <label className="block text-xs font-medium" htmlFor={`annotation-note-${messageId}`}>
              {t('Note (optional)')}
            </label>
            <Textarea
              id={`annotation-note-${messageId}`}
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

export { TextAnnotationSurface }
