import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp } from './help'
import { DELEGATE_AGENT_CONTRACT } from './delegate-contract'

const provisioned = Object.fromEntries(
  HOST_SDK_SUBAGENT_OPERATION_IDS.map((id) => [id.slice('host.'.length), true])
) as Record<
  (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number] extends `host.${infer Op}` ? Op : never,
  boolean
>
const mainContext = { callerRole: 'main', capabilities: provisioned } as const
const delegateContext = { callerRole: 'delegate', capabilities: provisioned } as const

describe('Host SDK help', () => {
  it('lists only registered operation topics in a compact deterministic catalog', () => {
    expect(hostSdkHelp.query(undefined, mainContext)).toEqual({
      kind: 'catalog',
      coverage: 'registered_topics_only',
      topics: [
        {
          id: 'host.children',
          kind: 'operation',
          path: 'host.children',
          aliases: ['children'],
          summary: 'List current direct-child Attempts on the active Message Branch.',
          availability: { status: 'available' }
        },
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
          summary:
            'Dispatch one Subagent or an atomic fan-out and optionally observe for a bounded time.',
          availability: { status: 'available' }
        },
        {
          id: 'host.message_receipt',
          kind: 'operation',
          path: 'host.message_receipt',
          aliases: ['message_receipt'],
          summary: 'Observe an owned delivery receipt for a bounded time.',
          availability: { status: 'available' }
        },
        {
          id: 'host.resolve_message',
          kind: 'operation',
          path: 'host.resolve_message',
          aliases: ['resolve_message'],
          summary: 'Acknowledge an uncertain delivery risk and release its lane fence.',
          availability: { status: 'available' }
        },
        {
          id: 'host.send_message',
          kind: 'operation',
          path: 'host.send_message',
          aliases: ['send_message'],
          summary: 'Durably queue a reliable message to a direct child or its root parent.',
          availability: { status: 'available' }
        },
        {
          id: 'host.stop_child',
          kind: 'operation',
          path: 'host.stop_child',
          aliases: ['stop_child'],
          summary: 'Stop one or more direct-child Frames without changing terminal children.',
          availability: { status: 'available' }
        },
        {
          id: 'host.submit_output',
          kind: 'operation',
          path: 'host.submit_output',
          aliases: ['submit_output'],
          summary: 'Submit the authenticated child Attempt structured JSON value.',
          availability: {
            status: 'unavailable',
            reason: 'Only a delegated child Attempt can submit output.'
          }
        }
      ],
      hint: "Query an exact topic, for example await host.help('delegate')."
    })
  })

  it('keeps the published REPL subagent surface and Help registry in lockstep', () => {
    const source = readFileSync(resolve(process.cwd(), 'resources/notebook/repl_loop.js'), 'utf8')
    const match = source.match(/const subagentHostOperations = Object\.freeze\(\{([\s\S]*?)\n\}\)/)
    expect(match).not.toBeNull()
    const published = [...(match?.[1].matchAll(/^\s{2}([a-z_]+):/gm) ?? [])]
      .map((entry) => `host.${entry[1]}`)
      .sort()
    expect(published).toEqual([...HOST_SDK_SUBAGENT_OPERATION_IDS])
  })

  it('documents exact children and stop_child contracts', () => {
    expect(hostSdkHelp.query('children', mainContext)).toMatchObject({
      id: 'host.children',
      request: {
        type: 'array',
        description: expect.stringContaining('optional')
      },
      returns: {
        type: 'array',
        items: {
          required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
          properties: { status: { enum: ['running', 'completed', 'cancelled', 'error'] } }
        }
      },
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('stop_child', mainContext)).toMatchObject({
      id: 'host.stop_child',
      request: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      returns: {
        type: 'array',
        items: {
          required: ['frame_id', 'status'],
          properties: { status: { enum: ['cancelled', 'already_terminal'] } }
        }
      },
      availability: { status: 'available' }
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
          { type: 'object', required: ['task', 'name'] },
          { type: 'array', minItems: 1, items: { type: 'object', required: ['task', 'name'] } }
        ]
      },
      options: {
        type: 'object',
        properties: {
          wait: { type: 'boolean', default: true },
          timeout_seconds: { type: 'number', minimum: 0, maximum: 1800 }
        }
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
          expect.any(Object),
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
                  optional: [
                    'terminal_message_id',
                    'response',
                    'cancellation_reason',
                    'error',
                    'structured_output',
                    'structured_output_unsatisfied'
                  ],
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
    if (canonical.kind !== 'operation') throw new Error('expected delegate operation help')
    const name = (canonical.request as typeof DELEGATE_AGENT_CONTRACT.request).oneOf[0].properties
      .name
    expect(name).toMatchObject({ type: 'string', minLength: 1, maxCodePoints: 48 })
    expect(name.description).toMatch(/required.*emoji.*not allowed/i)
    expect(name.description).toMatch(/current active root Message Branch/i)
    expect(name.description).toMatch(/NFC-equivalent.*whitespace-collapsed.*lowercase-equivalent/i)
    expect(name.description).toMatch(/never derived.*suffixed.*renamed/i)
    expect(canonical.constraints).toContainEqual(
      expect.stringMatching(/1–48.*current active root Message Branch.*NFC.*never derived/i)
    )
    expect(canonical.constraints).toContainEqual(
      expect.stringMatching(/complete, self-contained task/i)
    )
    expect(canonical.constraints).toContainEqual(
      expect.stringMatching(/staged as read-only copies.*\.\/inputs\//i)
    )
    expect(canonical.examples).not.toHaveLength(0)
    for (const example of canonical.examples) {
      expect(example.code).toContain('host.delegate')
      expect(example.code).toMatch(/name:\s*['"]/u)
    }
    const returns = canonical.returns as {
      oneOf: Array<{ properties: { children: { items: unknown } } }>
    }
    const observations = returns.oneOf[1].properties.children.items as {
      discriminator: { propertyName: string }
      oneOf: Array<{ required: string[]; properties: { status: { enum: string[] } } }>
    }
    expect(observations.discriminator).toEqual({ propertyName: 'status' })
    expect(observations.oneOf[0]).toMatchObject({
      required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
      properties: { status: { enum: ['running'] } }
    })
    expect(observations.oneOf[1]).toMatchObject({
      required: expect.arrayContaining(['artifacts_created']),
      properties: { status: { enum: ['completed', 'cancelled', 'error'] } }
    })
    expect(canonical.constraints).toContain(
      'Omitting profile inherits the authenticated parent Specialist; a Main Agent parent still selects Main Agent.'
    )
  })

  it('uses exhaustive route unions and exact per-operation receipt states', () => {
    for (const topic of ['send_message', 'message_receipt', 'resolve_message']) {
      const help = hostSdkHelp.query(topic, mainContext)
      if (help.kind !== 'operation') throw new Error(`expected operation help for ${topic}`)
      const receipt = help.returns as {
        type: string
        allOf: Array<{
          required?: string[]
          oneOf?: Array<{ properties: Record<string, unknown> }>
        }>
      }
      expect(receipt.type).toBe('delivery_receipt')
      expect(receipt.allOf[0].required).toEqual(
        expect.arrayContaining(['message_id', 'request_id'])
      )
      expect(
        receipt.allOf[1].oneOf?.map(({ properties }) => [
          properties.direction,
          properties.disposition
        ])
      ).toEqual([
        [{ enum: ['to_child'] }, { enum: ['message'] }],
        [{ enum: ['to_child'] }, { enum: ['continued'] }],
        [{ enum: ['to_parent'] }, { enum: ['message'] }]
      ])
      const states = receipt.allOf[2].oneOf?.map(({ properties }) => properties.status)
      if (topic === 'resolve_message') {
        expect(states).toEqual([{ enum: ['uncertain'] }])
        expect(receipt.allOf[2].oneOf?.[0].properties.resolution).toEqual({
          enum: ['acknowledged']
        })
        expect(JSON.stringify(help.returns)).not.toMatch(
          /"status":\{"enum":\["(?:queued|accepted|failed)"\]/
        )
      } else {
        expect(states).toEqual([
          { enum: ['queued'] },
          { enum: ['accepted'] },
          { enum: ['failed'] },
          { enum: ['uncertain'] }
        ])
      }
      expect(JSON.stringify(help.returns)).not.toContain('direction":["')
    }
  })

  it('returns structured suggestions for unknown topics', () => {
    expect(hostSdkHelp.query('delegte', mainContext)).toEqual({
      kind: 'not_found',
      query: 'delegte',
      suggestions: ['host.delegate', 'host.collect', 'host.children']
    })
    for (const unpublished of ['continue_child', 'acknowledge_message', 'stop_children']) {
      expect(hostSdkHelp.query(unpublished, mainContext)).toMatchObject({
        kind: 'not_found',
        query: unpublished
      })
    }
  })

  it('documents child-only structured output submission', () => {
    expect(
      hostSdkHelp.query('submit_output', {
        callerRole: 'delegate',
        capabilities: provisioned
      })
    ).toMatchObject({
      id: 'host.submit_output',
      returns: { required: ['accepted'] },
      availability: { status: 'available' }
    })
  })

  it('projects availability from trusted role and provisioning context', () => {
    expect(
      hostSdkHelp.query('delegate', {
        callerRole: 'delegate',
        capabilities: provisioned
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
        capabilities: { ...provisioned, delegate: false }
      })
    ).toMatchObject({
      availability: {
        status: 'unavailable',
        reason: 'host.delegate is not provisioned for this Session.'
      }
    })
  })

  it('projects provisioning independently for every operation', () => {
    for (const id of HOST_SDK_SUBAGENT_OPERATION_IDS) {
      const operation = id.slice('host.'.length) as keyof typeof provisioned
      const result = hostSdkHelp.query(id, {
        callerRole: operation === 'submit_output' ? 'delegate' : 'main',
        capabilities: { ...provisioned, [operation]: false }
      })
      expect(result).toMatchObject({ availability: { status: 'unavailable' } })
    }
  })

  it('advertises reliable parent messaging to an authenticated Delegate', () => {
    expect(hostSdkHelp.query('send_message', delegateContext)).toMatchObject({
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('message_receipt', delegateContext)).toMatchObject({
      availability: { status: 'available' }
    })
    expect(hostSdkHelp.query('resolve_message', delegateContext)).toMatchObject({
      availability: {
        status: 'unavailable',
        reason: 'Only root Main can resolve uncertain delivery.'
      }
    })
  })

  it('keeps root-only lifecycle topics discoverable but unavailable to a Delegate', () => {
    const rootCatalog = hostSdkHelp.query(undefined, mainContext)
    const childCatalog = hostSdkHelp.query(undefined, delegateContext)
    if (rootCatalog.kind !== 'catalog' || childCatalog.kind !== 'catalog') {
      throw new Error('expected catalogs')
    }
    expect(childCatalog.topics.map(({ id }) => id)).toEqual(rootCatalog.topics.map(({ id }) => id))
    for (const topic of ['delegate', 'children', 'collect', 'stop_child', 'resolve_message']) {
      expect(hostSdkHelp.query(topic, delegateContext)).toMatchObject({
        availability: { status: 'unavailable' }
      })
    }
  })

  it('rejects invalid or oversized queries and returns bounded JSON', () => {
    expect(() => hostSdkHelp.query(42, mainContext)).toThrow('host.help query must be a string')
    expect(() => hostSdkHelp.query('x'.repeat(129), mainContext)).toThrow(
      'host.help query must be at most 128 characters'
    )
    for (const topic of [undefined, ...HOST_SDK_SUBAGENT_OPERATION_IDS]) {
      const serialized = JSON.stringify(hostSdkHelp.query(topic, mainContext))
      expect(serialized.length).toBeLessThanOrEqual(16_000)
    }
  })
})
