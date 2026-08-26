import { describe, expect, it } from 'vitest'

import {
  annotationPayloadText,
  mergeImageAnnotationReferences,
  type Annotation,
  type ImagePointAnnotation
} from '../../../../../shared/annotations'
import { prepareImagePointAnnotationsForAgent } from './image-annotation-payload'

const image = (
  id: string,
  versionId: string,
  point: { x: number; y: number }
): ImagePointAnnotation => ({
  id,
  kind: 'image-point',
  target: 'agent',
  note: `note for ${id}`,
  source: {
    kind: 'artifact-version',
    projectId: 'project-1',
    sessionId: 'session-1',
    versionId,
    name: 'figure.png',
    path: `artifact-version:project-1/session-1/artifact-1/${versionId}`,
    mimeType: 'image/png'
  },
  point,
  naturalSize: { width: 1200, height: 800 }
})

describe('image annotation Agent payload projection', () => {
  it('keeps mixed annotation ordering, stable image numbering, and one attachment per Version', () => {
    const annotations: Annotation[] = [
      image('point-1', 'version-1', { x: 0, y: 1 }),
      {
        id: 'quote-1',
        kind: 'text',
        target: 'agent',
        quote: 'Compare this sentence.',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
      },
      image('point-2', 'version-1', { x: 0.5, y: 0.5 }),
      image('point-3', 'version-2', { x: 1, y: 0 })
    ]

    expect(prepareImagePointAnnotationsForAgent(annotations)).toEqual({
      attachments: [
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/version-1',
          source: 'artifact',
          mimeType: 'image/png',
          versionId: 'version-1'
        },
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/version-2',
          source: 'artifact',
          mimeType: 'image/png',
          versionId: 'version-2'
        }
      ],
      points: [
        expect.objectContaining({ annotationId: 'point-1', number: 1, x: 0, y: 799 }),
        expect.objectContaining({ annotationId: 'point-2', number: 2, x: 600, y: 400 }),
        expect.objectContaining({ annotationId: 'point-3', number: 3, x: 1199, y: 0 })
      ]
    })
    expect(prepareImagePointAnnotationsForAgent(annotations).points[0]).toMatchObject({
      imageWidth: 1200,
      imageHeight: 800,
      note: 'note for point-1',
      versionId: 'version-1'
    })
    expect(annotationPayloadText(annotations)).toContain(
      '"number":2,"x":600,"y":400,"imageWidth":1200,"imageHeight":800'
    )
    expect(annotationPayloadText(annotations)).not.toContain('"point":{"x":0.5')
  })

  it('merges fixed image Versions with user references without replacing the selected Version', () => {
    const prepared = prepareImagePointAnnotationsForAgent([
      image('point-1', 'version-1', { x: 0.5, y: 0.5 })
    ])
    expect(
      mergeImageAnnotationReferences(
        [
          {
            id: 'artifact-1',
            name: 'figure.png',
            path: 'artifact-version:project-1/session-1/artifact-1/version-1',
            source: 'artifact',
            versionId: 'version-1'
          },
          {
            id: 'artifact-1',
            name: 'figure.png',
            path: 'artifact-version:project-1/session-1/artifact-1/version-current',
            source: 'artifact',
            versionId: 'version-current'
          }
        ],
        prepared.attachments
      )
    ).toHaveLength(2)
  })
})
