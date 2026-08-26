import { describe, expect, it } from 'vitest'

import {
  ANNOTATION_LIMITS,
  annotationPayloadText,
  imageAnnotationSourceIsFixed,
  sanitizeAnnotations,
  validateAnnotations,
  type TextAnnotation
} from './annotations'

const textAnnotation = (overrides: Partial<TextAnnotation> = {}): TextAnnotation => ({
  id: 'annotation-1',
  kind: 'text',
  target: 'agent',
  quote: 'The confidence intervals overlap.',
  source: {
    kind: 'agent-message',
    sessionId: 'session-1',
    messageId: 'message-1'
  },
  ...overrides
})

describe('annotations', () => {
  it('serializes text annotations as bounded structured Agent context', () => {
    expect(annotationPayloadText([textAnnotation({ note: 'Explain this caveat.' })])).toBe(
      '[Annotations]\n' +
        JSON.stringify({
          version: 1,
          items: [
            {
              kind: 'text',
              quote: 'The confidence intervals overlap.',
              note: 'Explain this caveat.',
              source: {
                kind: 'agent-message',
                sessionId: 'session-1',
                messageId: 'message-1'
              }
            }
          ]
        })
    )
  })

  it('rejects excessive count, quote, note, and aggregate payloads', () => {
    expect(
      validateAnnotations(
        Array.from({ length: ANNOTATION_LIMITS.count + 1 }, (_, index) =>
          textAnnotation({ id: `annotation-${index}` })
        )
      )
    ).toBe('too-many')
    expect(
      validateAnnotations([textAnnotation({ quote: 'x'.repeat(ANNOTATION_LIMITS.quote + 1) })])
    ).toBe('quote-too-long')
    expect(
      validateAnnotations([textAnnotation({ note: 'x'.repeat(ANNOTATION_LIMITS.note + 1) })])
    ).toBe('note-too-long')
    expect(
      validateAnnotations([
        textAnnotation({ quote: 'x'.repeat(ANNOTATION_LIMITS.quote) }),
        textAnnotation({ id: 'annotation-2', quote: 'y'.repeat(ANNOTATION_LIMITS.quote) }),
        textAnnotation({ id: 'annotation-3', quote: 'z'.repeat(ANNOTATION_LIMITS.quote) })
      ])
    ).toBe('payload-too-large')
    expect(validateAnnotations([textAnnotation()], 'x'.repeat(100_000))).toBe('payload-too-large')
    expect(validateAnnotations([], 'x'.repeat(100_001))).toBeUndefined()
  })

  it('sanitizes persisted input and drops invalid or duplicate annotations', () => {
    expect(
      sanitizeAnnotations([
        textAnnotation({ note: '  useful note  ' }),
        textAnnotation({ note: 'duplicate' }),
        { kind: 'text', quote: '', source: {} },
        { kind: 'future-kind' }
      ])
    ).toEqual([textAnnotation({ note: 'useful note' })])
  })

  it.each([
    {
      kind: 'artifact-version' as const,
      path: 'artifact-version:project-1/session-1/artifact-1/version-1'
    },
    {
      kind: 'upload-version' as const,
      path: 'upload-version:project-1/session-1/version-1'
    }
  ])('accepts a fixed $kind identity only when every locator field matches', ({ kind, path }) => {
    const source = {
      kind,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'figure.png',
      path,
      mimeType: 'image/png'
    }
    expect(imageAnnotationSourceIsFixed(source)).toBe(true)
    expect(imageAnnotationSourceIsFixed({ ...source, versionId: 'current-version' })).toBe(false)
    expect(imageAnnotationSourceIsFixed({ ...source, path: '/mutable/current/figure.png' })).toBe(
      false
    )
    expect(imageAnnotationSourceIsFixed({ ...source, mimeType: 'image/gif' })).toBe(false)
  })
})
