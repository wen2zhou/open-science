import { describe, expect, it } from 'vitest'

import { hostSdkHelp } from './help'

const mainContext = { callerRole: 'main', capabilities: { delegation: true } } as const

describe('Host SDK help', () => {
  it('lists only registered operation topics in a compact deterministic catalog', () => {
    expect(hostSdkHelp.query(undefined, mainContext)).toEqual({
      kind: 'catalog',
      coverage: 'registered_topics_only',
      topics: [
        {
          id: 'host.collect',
          kind: 'operation',
          path: 'host.collect',
          aliases: ['collect'],
          summary:
            'Observe pinned Subagent Attempts until all settle or a bounded deadline expires.',
          availability: { status: 'available' }
        },
        {
          id: 'host.delegate',
          kind: 'operation',
          path: 'host.delegate',
          aliases: ['delegate'],
          summary: 'Dispatch one Subagent or an atomic fan-out and optionally wait for completion.',
          availability: { status: 'available' }
        }
      ],
      hint: "Query an exact topic, for example await host.help('delegate')."
    })
  })

  it('documents bounded collect selectors and the default without terminal fields on running', () => {
    const collect = hostSdkHelp.query('collect', mainContext)
    expect(collect).toMatchObject({
      kind: 'operation',
      id: 'host.collect',
      request: { type: 'array', minItems: 1 },
      options: {
        properties: {
          timeout_seconds: { type: 'number', minimum: 0, maximum: 1800, default: 30 }
        }
      }
    })
    expect(collect).toMatchObject({
      examples: [
        { title: 'Cell 1 — preserve handles', code: expect.stringContaining('globalThis') },
        { title: 'Cell 2 — collect pinned Attempts', code: expect.stringContaining('globalThis') }
      ]
    })
  })

  it('returns the same machine-readable delegate contract by canonical path and alias', () => {
    const canonical = hostSdkHelp.query('host.delegate', mainContext)
    expect(hostSdkHelp.query('delegate', mainContext)).toEqual(canonical)
    expect(canonical).toMatchObject({
      kind: 'operation',
      id: 'host.delegate',
      request: {
        oneOf: [
          { type: 'object', required: ['task'] },
          { type: 'array', minItems: 1, items: { type: 'object', required: ['task'] } }
        ]
      },
      options: {
        type: 'object',
        properties: { wait: { type: 'boolean', default: true } }
      },
      returns: {
        discriminator: { propertyName: 'kind' },
        oneOf: [
          {
            properties: {
              kind: { type: 'string', enum: ['receipts'] },
              children: {
                items: {
                  required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
                  optional: [],
                  properties: { status: { type: 'string', enum: ['running'] } }
                }
              }
            }
          },
          {
            properties: {
              kind: { type: 'string', enum: ['results'] },
              children: {
                items: {
                  required: [
                    'frame_id',
                    'attempt_id',
                    'name',
                    'agent_name',
                    'status',
                    'artifacts_created'
                  ],
                  optional: ['terminal_message_id', 'response', 'cancellation_reason', 'error'],
                  properties: {
                    status: { type: 'string', enum: ['completed', 'cancelled', 'error'] },
                    terminal_message_id: { type: 'string' },
                    response: { type: 'string' },
                    cancellation_reason: {
                      type: 'string',
                      enum: ['main_agent_stop', 'session_stop', 'runtime_interrupted']
                    }
                  }
                }
              }
            }
          }
        ]
      },
      errors: {
        thrown_type: 'Error',
        message_prefix: 'host.delegate: ',
        domain_error_code_exposed: false
      },
      availability: { status: 'available' }
    })
  })

  it('returns structured suggestions for unknown topics', () => {
    expect(hostSdkHelp.query('delegte', mainContext)).toEqual({
      kind: 'not_found',
      query: 'delegte',
      suggestions: ['host.delegate', 'host.collect']
    })
  })

  it('projects availability from trusted role and provisioning context', () => {
    expect(
      hostSdkHelp.query('delegate', {
        callerRole: 'delegate',
        capabilities: { delegation: true }
      })
    ).toMatchObject({
      availability: {
        status: 'unavailable',
        reason: 'Nested delegation is unsupported for Delegate agents.'
      }
    })
    expect(
      hostSdkHelp.query('delegate', {
        callerRole: 'main',
        capabilities: { delegation: false }
      })
    ).toMatchObject({
      availability: {
        status: 'unavailable',
        reason: 'Delegated Work is not provisioned for this Session.'
      }
    })
  })

  it('rejects invalid or oversized queries and returns bounded JSON', () => {
    expect(() => hostSdkHelp.query(42, mainContext)).toThrow('host.help query must be a string')
    expect(() => hostSdkHelp.query('x'.repeat(129), mainContext)).toThrow(
      'host.help query must be at most 128 characters'
    )
    const serialized = JSON.stringify(hostSdkHelp.query('delegate', mainContext))
    expect(serialized.length).toBeLessThanOrEqual(16_000)
  })
})
