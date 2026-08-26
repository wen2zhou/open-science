export const ANNOTATION_LIMITS = Object.freeze({
  count: 10,
  quote: 4_000,
  note: 2_000,
  payload: 10_000,
  messagePayload: 100_000
})

export type TextAnnotationSource =
  | Readonly<{
      kind: 'agent-message'
      sessionId: string
      messageId: string
    }>
  | Readonly<{
      kind: 'project-file'
      projectId: string
      path: string
      name?: string
      versionId?: string
      sessionId?: string
    }>

export type TextAnnotation = Readonly<{
  id: string
  kind: 'text'
  target: 'agent'
  quote: string
  note?: string
  source: TextAnnotationSource
}>

export type ImagePointAnnotation = Readonly<{
  id: string
  kind: 'image-point'
  target: 'agent'
  note: string
  source: Readonly<{
    kind: 'artifact-version' | 'upload-version'
    projectId: string
    sessionId: string
    versionId: string
    name: string
    path: string
    mimeType: string
  }>
  point: Readonly<{ x: number; y: number }>
  naturalSize: Readonly<{ width: number; height: number }>
}>

export type Annotation = TextAnnotation | ImagePointAnnotation

export type ImagePointAgentPayload = Readonly<{
  annotationId: string
  number: number
  note: string
  sourceKind: ImagePointAnnotation['source']['kind']
  versionId: string
  name: string
  mimeType: string
  x: number
  y: number
  imageWidth: number
  imageHeight: number
}>

export type PreparedImagePointAnnotations = Readonly<{
  attachments: ArtifactReference[]
  points: ImagePointAgentPayload[]
}>

export type AnnotationValidationError =
  'too-many' | 'quote-too-long' | 'note-too-long' | 'payload-too-large' | 'invalid'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result || undefined
}

const sanitizeTextSource = (value: unknown): TextAnnotationSource | undefined => {
  if (!isRecord(value)) return undefined
  const kind = value.kind
  if (kind === 'agent-message') {
    const sessionId = trimmed(value.sessionId)
    const messageId = trimmed(value.messageId)
    return sessionId && messageId ? { kind, sessionId, messageId } : undefined
  }
  if (kind === 'project-file') {
    const projectId = trimmed(value.projectId)
    const path = trimmed(value.path)
    if (!projectId || !path) return undefined
    return {
      kind,
      projectId,
      path,
      ...(trimmed(value.name) ? { name: trimmed(value.name) } : {}),
      ...(trimmed(value.versionId) ? { versionId: trimmed(value.versionId) } : {}),
      ...(trimmed(value.sessionId) ? { sessionId: trimmed(value.sessionId) } : {})
    }
  }
  return undefined
}

export const sanitizeAnnotation = (value: unknown): Annotation | undefined => {
  if (!isRecord(value) || value.target !== 'agent') return undefined
  const id = trimmed(value.id)
  if (!id) return undefined
  if (value.kind === 'text') {
    const quote = trimmed(value.quote)
    const source = sanitizeTextSource(value.source)
    const note = trimmed(value.note)
    if (!quote || !source) return undefined
    return { id, kind: 'text', target: 'agent', quote, source, ...(note ? { note } : {}) }
  }
  if (value.kind === 'image-point' && isRecord(value.source) && isRecord(value.point)) {
    const note = trimmed(value.note)
    const source = value.source
    const naturalSize = value.naturalSize
    const x = value.point.x
    const y = value.point.y
    const width = isRecord(naturalSize) ? naturalSize.width : undefined
    const height = isRecord(naturalSize) ? naturalSize.height : undefined
    const sourceKind = source.kind
    const mimeType = trimmed(source.mimeType)
    if (
      !note ||
      (sourceKind !== 'artifact-version' && sourceKind !== 'upload-version') ||
      !trimmed(source.projectId) ||
      !trimmed(source.sessionId) ||
      !trimmed(source.versionId) ||
      !trimmed(source.name) ||
      !trimmed(source.path) ||
      !mimeType ||
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1 ||
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return undefined
    }
    return {
      id,
      kind: 'image-point',
      target: 'agent',
      note,
      source: {
        kind: sourceKind,
        projectId: trimmed(source.projectId)!,
        sessionId: trimmed(source.sessionId)!,
        versionId: trimmed(source.versionId)!,
        name: trimmed(source.name)!,
        path: trimmed(source.path)!,
        mimeType
      },
      point: { x, y },
      naturalSize: { width, height }
    }
  }
  return undefined
}

export const sanitizeAnnotations = (value: unknown): Annotation[] => {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const annotations: Annotation[] = []
  for (const candidate of value) {
    const annotation = sanitizeAnnotation(candidate)
    if (!annotation || ids.has(annotation.id)) continue
    ids.add(annotation.id)
    annotations.push(annotation)
    if (annotations.length >= ANNOTATION_LIMITS.count) break
  }
  return validateAnnotations(annotations) ? [] : annotations
}

export const imageVersionKey = (source: ImagePointAnnotation['source']): string =>
  [source.kind, source.projectId, source.sessionId, source.versionId].join('\u0000')

export const imageAnnotationFileReference = (
  source: ImagePointAnnotation['source']
): ArtifactReference => ({
  id:
    source.kind === 'artifact-version'
      ? (parseArtifactVersionLocator(source.path)?.artifactId ?? source.versionId)
      : source.versionId,
  name: source.name,
  path: source.path,
  source: source.kind === 'artifact-version' ? 'artifact' : 'upload',
  mimeType: source.mimeType,
  versionId: source.versionId
})

export const prepareImagePointAnnotationsForAgent = (
  annotations: readonly Annotation[]
): PreparedImagePointAnnotations => {
  const attachments: ArtifactReference[] = []
  const attachedVersions = new Set<string>()
  const points: ImagePointAgentPayload[] = []
  for (const annotation of annotations) {
    if (annotation.kind !== 'image-point') continue
    const key = imageVersionKey(annotation.source)
    if (!attachedVersions.has(key)) {
      attachedVersions.add(key)
      attachments.push(imageAnnotationFileReference(annotation.source))
    }
    points.push({
      annotationId: annotation.id,
      number: points.length + 1,
      note: annotation.note,
      sourceKind: annotation.source.kind,
      versionId: annotation.source.versionId,
      name: annotation.source.name,
      mimeType: annotation.source.mimeType,
      x: Math.round(
        Math.min(1, Math.max(0, annotation.point.x)) * (annotation.naturalSize.width - 1)
      ),
      y: Math.round(
        Math.min(1, Math.max(0, annotation.point.y)) * (annotation.naturalSize.height - 1)
      ),
      imageWidth: annotation.naturalSize.width,
      imageHeight: annotation.naturalSize.height
    })
  }
  return { attachments, points }
}

const fileReferenceVersionKey = (reference: FileReference): string | undefined =>
  reference.source === 'linked-folder' || !reference.versionId
    ? undefined
    : [reference.source, reference.versionId].join('\u0000')

export const mergeImageAnnotationReferences = (
  referencedArtifacts: readonly FileReference[] | undefined,
  imageReferences: readonly ArtifactReference[]
): FileReference[] | undefined => {
  const merged = [...(referencedArtifacts ?? [])]
  const keys = new Set(merged.map(fileReferenceVersionKey).filter((key): key is string => !!key))
  for (const reference of imageReferences) {
    const key = fileReferenceVersionKey(reference)
    if (key && keys.has(key)) continue
    if (key) keys.add(key)
    merged.push(reference)
  }
  return merged.length > 0 ? merged : undefined
}

const payloadItem = (
  annotation: Annotation,
  imagePoints: ReadonlyMap<string, ImagePointAgentPayload>
): Record<string, unknown> => {
  if (annotation.kind === 'text') {
    return {
      kind: annotation.kind,
      quote: annotation.quote,
      ...(annotation.note ? { note: annotation.note } : {}),
      source: annotation.source
    }
  }
  const point = imagePoints.get(annotation.id)
  return point
    ? {
        kind: annotation.kind,
        note: point.note,
        sourceKind: point.sourceKind,
        versionId: point.versionId,
        name: point.name,
        mimeType: point.mimeType,
        number: point.number,
        x: point.x,
        y: point.y,
        imageWidth: point.imageWidth,
        imageHeight: point.imageHeight
      }
    : {
        kind: annotation.kind,
        note: annotation.note,
        source: annotation.source,
        point: annotation.point,
        naturalSize: annotation.naturalSize
      }
}

export const annotationPayloadText = (annotations: readonly Annotation[]): string => {
  if (annotations.length === 0) return ''
  const prepared = prepareImagePointAnnotationsForAgent(annotations)
  const imagePoints = new Map(prepared.points.map((point) => [point.annotationId, point]))
  return `[Annotations]\n${JSON.stringify({
    version: 1,
    items: annotations.map((annotation) => payloadItem(annotation, imagePoints))
  })}`
}

export const validateAnnotations = (
  annotations: readonly Annotation[],
  messageText = ''
): AnnotationValidationError | undefined => {
  if (annotations.length > ANNOTATION_LIMITS.count) return 'too-many'
  for (const annotation of annotations) {
    if (!sanitizeAnnotation(annotation)) return 'invalid'
    if (annotation.kind === 'text' && annotation.quote.length > ANNOTATION_LIMITS.quote) {
      return 'quote-too-long'
    }
    if (annotation.note && annotation.note.length > ANNOTATION_LIMITS.note) return 'note-too-long'
  }
  if (annotationPayloadText(annotations).length > ANNOTATION_LIMITS.payload) {
    return 'payload-too-large'
  }
  if (
    annotations.length > 0 &&
    [messageText.trim(), annotationPayloadText(annotations)].filter(Boolean).join('\n\n').length >
      ANNOTATION_LIMITS.messagePayload
  ) {
    return 'payload-too-large'
  }
  return undefined
}

export const appendAnnotationsToPrompt = (
  text: string,
  annotations: readonly Annotation[]
): string => [text.trim(), annotationPayloadText(annotations)].filter(Boolean).join('\n\n')
import type { ArtifactReference, FileReference } from './artifacts'
import { parseArtifactVersionLocator } from './artifact-provenance'
