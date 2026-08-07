import { describe, expect, it } from 'vitest'

import { DELEGATE_AGENT_CONTRACT, parseDelegateRpcCall } from './delegate-contract'

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
        }
      }
    })
    expect(requestArray).toEqual({ type: 'array', minItems: 1, items: singleRequest })
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
    expect(parseDelegateRpcCall({ request: { task: '' } })).toEqual({
      request: { task: '' },
      options: {}
    })
    expect(() => parseDelegateRpcCall({ request: 'Audit' })).toThrow(
      'host.delegate requires one request object or a non-empty request array.'
    )
    expect(() =>
      parseDelegateRpcCall({ request: { task: 'Audit' }, options: { wait: 'no' } })
    ).toThrow('host.delegate wait must be a boolean.')
  })
})
