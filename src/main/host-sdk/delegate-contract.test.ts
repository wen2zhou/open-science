import { describe, expect, it } from 'vitest'

import {
  COLLECT_AGENT_CONTRACT,
  DELEGATE_AGENT_CONTRACT,
  parseCollectRpcCall,
  parseDelegateRpcCall
} from './delegate-contract'

describe('Agent-facing delegate contract', () => {
  it('owns a machine-readable single-request or non-empty-array input schema', () => {
    const [singleRequest, requestArray] = DELEGATE_AGENT_CONTRACT.request.oneOf

    expect(singleRequest).toMatchObject({
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        profile: { type: 'string', minLength: 1 },
        context: { type: 'string', minLength: 1 },
        inputs: {
          type: 'array',
          items: { type: 'string', minLength: 1, identity: 'immutable_upload_or_artifact_version' }
        },
        output_schema: expect.objectContaining({ description: expect.stringContaining('2020-12') })
      }
    })
    expect(requestArray).toEqual({ type: 'array', minItems: 1, items: singleRequest })
    expect(singleRequest.properties.profile.description).toContain(
      'Omit to inherit the authenticated parent Specialist'
    )
  })

  it('normalizes wire request and options shapes without replacing domain admission validation', () => {
    expect(
      parseDelegateRpcCall({
        request: [{ task: 'Audit', inputs: ['upload-version-1'] }],
        options: { wait: false }
      })
    ).toEqual({
      request: [{ task: 'Audit', inputs: ['upload-version-1'] }],
      options: { wait: false }
    })
    expect(parseDelegateRpcCall({ request: [] })).toEqual({ request: [], options: {} })
    expect(
      parseDelegateRpcCall({
        request: { task: 'Observe' },
        options: { timeout_seconds: 0 }
      })
    ).toEqual({ request: { task: 'Observe' }, options: { timeoutSeconds: 0 } })
    expect(parseDelegateRpcCall({ request: { task: '' } })).toEqual({
      request: { task: '' },
      options: {}
    })
    expect(
      parseDelegateRpcCall({ request: { task: 'Extract', output_schema: { type: 'number' } } })
    ).toEqual({
      request: { task: 'Extract', outputSchema: { type: 'number' } },
      options: {}
    })
    expect(() => parseDelegateRpcCall({ request: 'Audit' })).toThrow(
      'host.delegate requires one request object or a non-empty request array.'
    )
    expect(() =>
      parseDelegateRpcCall({ request: { task: 'Audit' }, options: { wait: 'no' } })
    ).toThrow('host.delegate wait must be a boolean.')
    expect(() =>
      parseDelegateRpcCall({
        request: { task: 'Audit' },
        options: { wait: false, timeout_seconds: 1 }
      })
    ).toThrow('cannot be combined')
  })
})

describe('Agent-facing collect contract', () => {
  it('normalizes string and explicit Attempt selectors with bounded options', () => {
    expect(
      parseCollectRpcCall({
        selectors: ['frame-1', { frame_id: 'frame-2', attempt_id: 'attempt-2' }],
        options: { timeout_seconds: 0 }
      })
    ).toEqual({
      selectors: ['frame-1', { frameId: 'frame-2', attemptId: 'attempt-2' }],
      options: { timeoutSeconds: 0 }
    })
    expect(COLLECT_AGENT_CONTRACT.options.properties.timeout_seconds).toMatchObject({
      minimum: 0,
      maximum: 1800,
      default: 30
    })
    for (const invalid of [-1, 1801, Number.NaN, Number.POSITIVE_INFINITY, '30']) {
      expect(() =>
        parseCollectRpcCall({ selectors: ['frame-1'], options: { timeout_seconds: invalid } })
      ).toThrow('finite number from 0 through 1800')
    }
  })
})
