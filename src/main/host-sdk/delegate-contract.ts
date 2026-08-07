import type {
  DurableDelegateRequest,
  DurableDelegatedWork
} from '../delegated-work/durable-delegated-work'

const DELEGATE_REQUEST_OBJECT_SCHEMA = {
  type: 'object',
  required: ['task'],
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      description: 'Non-empty assignment for the Subagent.'
    },
    name: { type: 'string', minLength: 1, description: 'Non-empty display title.' },
    profile: {
      type: 'string',
      minLength: 1,
      description:
        'Stable Specialist id or unique exact public name from await host.agents.list(). Omit to use Main Agent regardless of the Session binding.'
    },
    context: {
      type: 'string',
      minLength: 1,
      description: 'Non-empty explicit context; the parent transcript is not copied.'
    },
    inputs: {
      type: 'array',
      items: {
        type: 'string',
        minLength: 1,
        identity: 'immutable_upload_or_artifact_version'
      },
      description: 'Immutable Upload Version or Artifact Version identities only.'
    }
  }
} as const

const DELEGATE_OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    wait: {
      type: 'boolean',
      default: true,
      description: 'Wait for all children to settle when true.'
    }
  }
} as const

const DELEGATE_AGENT_CONTRACT = {
  request: {
    oneOf: [
      DELEGATE_REQUEST_OBJECT_SCHEMA,
      {
        type: 'array',
        minItems: 1,
        items: DELEGATE_REQUEST_OBJECT_SCHEMA
      }
    ]
  },
  options: DELEGATE_OPTIONS_SCHEMA,
  returns: {
    discriminator: { propertyName: 'kind' },
    oneOf: [
      {
        description: 'Returned when options.wait is false.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['receipts'] },
          children: {
            type: 'array',
            items: {
              type: 'object',
              required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
              optional: [],
              properties: {
                frame_id: { type: 'string' },
                attempt_id: { type: 'string' },
                name: { type: 'string', description: 'Child delegation name.' },
                agent_name: { type: 'string', description: 'Resolved Attempt agent display name.' },
                status: { type: 'string', enum: ['running'] }
              }
            }
          }
        }
      },
      {
        description: 'Returned when options.wait is omitted or true.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['results'] },
          children: {
            type: 'array',
            items: {
              type: 'object',
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
                frame_id: { type: 'string' },
                attempt_id: { type: 'string' },
                name: { type: 'string', description: 'Child delegation name.' },
                agent_name: { type: 'string', description: 'Resolved Attempt agent display name.' },
                status: { type: 'string', enum: ['completed', 'cancelled', 'error'] },
                terminal_message_id: { type: 'string' },
                response: { type: 'string' },
                artifacts_created: {
                  type: 'array',
                  items: {
                    type: 'object',
                    description: 'Finalized Artifact Version metadata.'
                  }
                },
                cancellation_reason: {
                  type: 'string',
                  enum: ['main_agent_stop', 'session_stop', 'runtime_interrupted']
                },
                error: {
                  type: 'object',
                  required: ['code', 'message'],
                  properties: {
                    code: { type: 'string' },
                    message: { type: 'string' }
                  }
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
    domain_error_code_exposed: false,
    conditions: [
      'Invalid requests or unavailable input/Specialist selections reject the call before dispatch.',
      'Insufficient capacity or an unavailable execution framework rejects the call before dispatch.',
      'Terminal execution failures are returned as result children with status "error" and an error object.'
    ]
  }
} as const

type DelegateRpcCall = Readonly<{
  request: Parameters<DurableDelegatedWork['delegate']>[1]
  options: Readonly<{ wait?: boolean }>
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseDelegateRpcCall = (params: Readonly<Record<string, unknown>>): DelegateRpcCall => {
  const request = params.request
  if (!isRecord(request) && !Array.isArray(request)) {
    throw new Error('host.delegate requires one request object or a non-empty request array.')
  }
  if (params.options !== undefined && !isRecord(params.options)) {
    throw new Error('host.delegate options must be an object.')
  }
  const requestedOptions = isRecord(params.options) ? params.options : {}
  if (requestedOptions.wait !== undefined && typeof requestedOptions.wait !== 'boolean') {
    throw new Error('host.delegate wait must be a boolean.')
  }
  return {
    // Semantic request validation remains in DelegatedWorkAdmissionPolicy so RPC callers retain
    // the existing domain errors for empty arrays, tasks, profiles, contexts, and input identities.
    request: request as DurableDelegateRequest | readonly DurableDelegateRequest[],
    options: typeof requestedOptions.wait === 'boolean' ? { wait: requestedOptions.wait } : {}
  }
}

export { DELEGATE_AGENT_CONTRACT, parseDelegateRpcCall }
export type { DelegateRpcCall }
