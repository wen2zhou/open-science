import { MapPin, Pencil, Quote, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Annotation, AnnotationValidationError } from '../../../../../shared/annotations'
import { prepareImagePointAnnotationsForAgent } from './image-annotation-payload'

const annotationSourceLabel = (annotation: Annotation, t: TFunction): string => {
  if (annotation.kind === 'image-point') return annotation.source.name
  if (annotation.source.kind === 'agent-message') {
    return `${t('Agent Message')} · ${annotation.source.messageId ?? annotation.source.sessionId}`
  }
  return annotation.source.name ?? annotation.source.path ?? t('Project File')
}

const AnnotationDraftCards = ({
  annotations,
  disabled,
  onUpdateNote,
  onRemove
}: {
  annotations: readonly Annotation[]
  disabled: boolean
  onUpdateNote: (id: string, note: string) => AnnotationValidationError | undefined
  onRemove: (id: string) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string>()
  const [note, setNote] = useState('')
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const imagePoints = new Map(
    prepareImagePointAnnotationsForAgent(annotations).points.map((point) => [
      point.annotationId,
      point
    ])
  )
  const closeEditor = (id: string): void => {
    setEditingId(undefined)
    queueMicrotask(() => editButtons.current.get(id)?.focus())
  }
  if (annotations.length === 0) return null

  return (
    <TooltipProvider>
      <section className="mb-2 space-y-2" aria-label={t('Annotations for Agent')}>
        {annotations.map((annotation) => {
          const imagePoint = imagePoints.get(annotation.id)
          return (
            <article
              key={annotation.id}
              className="rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs"
            >
              <div className="flex items-start gap-2">
                {imagePoint ? (
                  <MapPin className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <Quote className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    {imagePoint
                      ? t('Image point {{number}}', { number: imagePoint.number })
                      : t('Text quote')}
                  </div>
                  <div className="mt-0.5 line-clamp-2 break-words text-muted-foreground">
                    {imagePoint
                      ? t('Point {{number}} at {{x}}, {{y}}', imagePoint)
                      : annotation.kind === 'text'
                        ? annotation.quote
                        : annotation.source.name}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {t('Source: {{source}}', { source: annotationSourceLabel(annotation, t) })}
                  </div>
                  {annotation.note ? (
                    <div className="mt-1 break-words">{annotation.note}</div>
                  ) : null}
                </div>
                <Tooltip>
                  <TooltipTrigger
                    asChild
                    onFocus={(event) => {
                      if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                    }}
                  >
                    <Button
                      ref={(element) => {
                        if (element) editButtons.current.set(annotation.id, element)
                        else editButtons.current.delete(annotation.id)
                      }}
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled}
                      aria-label={t('Edit annotation note')}
                      onClick={() => {
                        setEditingId(annotation.id)
                        setNote(annotation.note ?? '')
                      }}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('Edit annotation note')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled}
                      aria-label={t('Remove annotation')}
                      onClick={() => onRemove(annotation.id)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('Remove annotation')}</TooltipContent>
                </Tooltip>
              </div>
              {editingId === annotation.id ? (
                <div className="mt-2 space-y-2">
                  <label className="sr-only" htmlFor={`edit-annotation-${annotation.id}`}>
                    {t('Annotation note')}
                  </label>
                  <Textarea
                    id={`edit-annotation-${annotation.id}`}
                    autoFocus
                    value={note}
                    maxLength={2_000}
                    placeholder={t('Add context for the Agent')}
                    onChange={(event) => setNote(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return
                      event.preventDefault()
                      closeEditor(annotation.id)
                    }}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => closeEditor(annotation.id)}
                    >
                      {t('Cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        if (!onUpdateNote(annotation.id, note)) closeEditor(annotation.id)
                      }}
                    >
                      {t('Save')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </article>
          )
        })}
      </section>
    </TooltipProvider>
  )
}

const AnnotationMessageCards = ({
  annotations
}: {
  annotations: readonly Annotation[]
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (annotations.length === 0) return null
  const imagePoints = new Map(
    prepareImagePointAnnotationsForAgent(annotations).points.map((point) => [
      point.annotationId,
      point
    ])
  )
  return (
    <section className="mb-2 space-y-2" aria-label={t('Sent annotations')}>
      {annotations.map((annotation) => {
        const imagePoint = imagePoints.get(annotation.id)
        return (
          <article
            key={annotation.id}
            className="rounded-lg border border-border/70 bg-background/70 p-2"
          >
            <div className="flex items-center gap-1 text-xs font-semibold">
              {imagePoint ? (
                <MapPin className="size-3" aria-hidden="true" />
              ) : (
                <Quote className="size-3" aria-hidden="true" />
              )}
              {imagePoint
                ? t('Image point {{number}}', { number: imagePoint.number })
                : t('Text quote')}
            </div>
            <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-2 text-xs">
              {imagePoint
                ? t('Point {{number}} at {{x}}, {{y}}', imagePoint)
                : annotation.kind === 'text'
                  ? annotation.quote
                  : annotation.source.name}
            </blockquote>
            <div className="mt-1 text-[11px] opacity-70">
              {t('Source: {{source}}', { source: annotationSourceLabel(annotation, t) })}
            </div>
            {annotation.note ? <div className="mt-1 text-xs">{annotation.note}</div> : null}
          </article>
        )
      })}
    </section>
  )
}

export { AnnotationDraftCards, AnnotationMessageCards }
