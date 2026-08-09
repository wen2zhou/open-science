import type {
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateRequest,
  DurableDelegatedWork
} from '../delegated-work/durable-delegated-work'

const COLLECT_AGENT_CONTRACT = {
  selectors: {
    type: 'array',
    minItems: 1,
    items: {
      oneOf: [
        { type: 'string', minLength: 1 },
        {
          type: 'object',
          required: ['frame_id', 'attempt_id'],
          properties: { frame_id: { type: 'string' }, attempt_id: { type: 'string' } }
        }
      ]
    }
  },
  options: {
    type: 'object',
    properties: {
      timeout_seconds: { type: 'number', minimum: 0, maximum: 1800, default: 30 }
    }
  },
  returns: { type: 'array', items: { oneOf: ['terminal_result', 'running_observation'] } },
  errors: {
    thrown_type: 'Error',
    message_prefix: 'host.collect: ',
    domain_error_code_exposed: false
  }
} as const

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
        'Stable Specialist id or unique exact public name from await host.agents.list(). Omit to inherit the authenticated parent Specialist; a Main Agent parent uses Main Agent.'
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
    },
    timeout_seconds: {
      type: 'number',
      minimum: 0,
      maximum: 1800,
      description: 'Bounded observation wait after every admitted child has established launch.'
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
        description: 'Returned when options.timeout_seconds is explicit.',
        type: 'object',
        required: ['kind', 'children'],
        optional: [],
        properties: {
          kind: { type: 'string', enum: ['observations'] },
          children: { type: 'array', items: { oneOf: ['terminal_result', 'running_observation'] } }
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
  options: Readonly<{ wait?: boolean; timeoutSeconds?: number }>
}>

type CollectRpcCall = Readonly<{
  selectors: readonly DurableCollectSelector[]
  options: DurableCollectOptions
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
  const timeoutSeconds = requestedOptions.timeout_seconds
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== 'number' ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > 1800)
  ) {
    throw new Error('host.delegate timeout_seconds must be a finite number from 0 through 1800.')
  }
  if (requestedOptions.wait === false && timeoutSeconds !== undefined) {
    throw new Error('host.delegate wait:false cannot be combined with timeout_seconds.')
  }
  return {
    // Semantic request validation remains in DelegatedWorkAdmissionPolicy so RPC callers retain
    // the existing domain errors for empty arrays, tasks, profiles, contexts, and input identities.
    request: request as DurableDelegateRequest | readonly DurableDelegateRequest[],
    options: {
      ...(typeof requestedOptions.wait === 'boolean' ? { wait: requestedOptions.wait } : {}),
      ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {})
    }
  }
}

const parseCollectRpcCall = (params: Readonly<Record<string, unknown>>): CollectRpcCall => {
  if (!Array.isArray(params.selectors) || params.selectors.length === 0) {
    throw new Error('host.collect requires a non-empty selectors array.')
  }
  const selectors = params.selectors.map((selector) => {
    if (typeof selector === 'string' && selector.trim()) return selector
    if (
      isRecord(selector) &&
      typeof selector.frame_id === 'string' &&
      selector.frame_id.trim() &&
      typeof selector.attempt_id === 'string' &&
      selector.attempt_id.trim()
    ) {
      return { frameId: selector.frame_id, attemptId: selector.attempt_id }
    }
    throw new Error('host.collect selectors must be frame ids or Frame/Attempt handles.')
  })
  if (params.options !== undefined && !isRecord(params.options)) {
    throw new Error('host.collect options must be an object.')
  }
  const requestedOptions = isRecord(params.options) ? params.options : {}
  const timeoutSeconds = requestedOptions.timeout_seconds
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== 'number' ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > 1800)
  ) {
    throw new Error('host.collect timeout_seconds must be a finite number from 0 through 1800.')
  }
  return {
    selectors,
    options: timeoutSeconds === undefined ? {} : { timeoutSeconds }
  }
}

export {
  COLLECT_AGENT_CONTRACT,
  DELEGATE_AGENT_CONTRACT,
  parseCollectRpcCall,
  parseDelegateRpcCall
}
export type { CollectRpcCall, DelegateRpcCall }
