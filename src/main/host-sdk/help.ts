import { COLLECT_AGENT_CONTRACT, DELEGATE_AGENT_CONTRACT } from './delegate-contract'

const HOST_SDK_SUBAGENT_OPERATION_IDS = [
  'host.children',
  'host.collect',
  'host.delegate',
  'host.message_receipt',
  'host.resolve_message',
  'host.send_message',
  'host.stop_child',
  'host.submit_output'
] as const

type HostSdkSubagentOperation =
  (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number] extends `host.${infer Operation}`
    ? Operation
    : never

type HostSdkHelpContext = Readonly<{
  callerRole: 'main' | 'delegate'
  capabilities: Readonly<Record<HostSdkSubagentOperation, boolean>>
}>

type HostSdkAvailability =
  Readonly<{ status: 'available' }> | Readonly<{ status: 'unavailable'; reason: string }>

type HostSdkHelpOperationDescriptor = Readonly<{
  kind: 'operation'
  id: string
  path: string
  aliases: readonly string[]
  summary: string
  call_forms: readonly Readonly<{ signature: string; accepts: string }>[]
  request: Readonly<Record<string, unknown>>
  options: Readonly<Record<string, unknown>>
  returns: Readonly<Record<string, unknown>>
  constraints: readonly string[]
  examples: readonly Readonly<{ title: string; code: string }>[]
  errors: Readonly<Record<string, unknown>>
  resolveAvailability(context: HostSdkHelpContext): HostSdkAvailability
}>

type HostSdkHelpOperation = Omit<HostSdkHelpOperationDescriptor, 'resolveAvailability'> &
  Readonly<{ availability: HostSdkAvailability }>

type HostSdkHelpCatalog = Readonly<{
  kind: 'catalog'
  coverage: 'registered_topics_only'
  topics: readonly Readonly<{
    id: string
    kind: 'operation'
    path: string
    aliases: readonly string[]
    summary: string
    availability: HostSdkAvailability
  }>[]
  hint: string
}>

type HostSdkHelpNotFound = Readonly<{
  kind: 'not_found'
  query: string
  suggestions: readonly string[]
}>

type HostSdkHelpResult = HostSdkHelpCatalog | HostSdkHelpOperation | HostSdkHelpNotFound

type HostSdkHelpRegistry = Readonly<{
  query(query: unknown, context: HostSdkHelpContext): HostSdkHelpResult
}>

const unavailableProvisioning = (operation: HostSdkSubagentOperation): HostSdkAvailability => ({
  status: 'unavailable',
  reason: `host.${operation} is not provisioned for this Session.`
})

const rootOnlyAvailability =
  (
    operation: HostSdkSubagentOperation,
    delegateReason: string
  ): HostSdkHelpOperationDescriptor['resolveAvailability'] =>
  ({ callerRole, capabilities }) => {
    if (callerRole === 'delegate') return { status: 'unavailable', reason: delegateReason }
    return capabilities[operation] ? { status: 'available' } : unavailableProvisioning(operation)
  }

const DELEGATE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.delegate',
  path: 'host.delegate',
  aliases: ['delegate'],
  summary: 'Dispatch one Subagent or an atomic fan-out and optionally observe for a bounded time.',
  call_forms: [
    {
      signature: 'await host.delegate(request, options?)',
      accepts: 'request_object'
    },
    {
      signature: 'await host.delegate(requests, options?)',
      accepts: 'non_empty_request_array'
    }
  ],
  request: DELEGATE_AGENT_CONTRACT.request,
  options: DELEGATE_AGENT_CONTRACT.options,
  returns: DELEGATE_AGENT_CONTRACT.returns,
  constraints: [
    'Only the Main/root Agent can call host.delegate; nested delegation is unsupported.',
    'Call await host.agents.list() to discover Specialist profile ids and public names.',
    'Set profile to a stable id or unique exact public name returned by host.agents.list().',
    'Omitting profile inherits the authenticated parent Specialist; a Main Agent parent still selects Main Agent.',
    'A request array is admitted atomically and must be non-empty.',
    'Every request must provide a 1–48-code-point non-emoji name without newlines or control characters. On the current active root Message Branch, running and terminal child names must be unique after NFC normalization, Unicode whitespace collapse, and lowercase comparison; names are never derived or automatically renamed.',
    'Dispatch can be rejected before execution when capacity, framework, Specialist, or input admission is unavailable.',
    'Write a complete, self-contained task. Each child receives only that task and its declared immutable inputs.',
    'Immutable inputs are staged as read-only copies under ./inputs/ and announced in the child’s initial prompt.',
    'An explicit timeout_seconds starts after every admitted child establishes launch and returns observations without stopping running children.',
    'wait:false cannot be combined with timeout_seconds; omitting timeout_seconds preserves all-settled waiting.',
    'After asynchronous dispatch, use host.children for current inventory recovery and host.collect for exact observation contracts.',
    'Use host.stop_child to stop direct children; use host.send_message and host.message_receipt for delivery and observation.',
    'When output_schema is admitted, the child uses host.submit_output; a child cannot nested-delegate or manage siblings.',
    'Query each named exact Help topic for its complete parameters, results, constraints, and errors.'
  ],
  examples: [
    {
      title: 'Wait for one Subagent',
      code: "const outcome = await host.delegate({ name: 'Statistical audit', task: 'Verify the statistical assumptions' })"
    },
    {
      title: 'Select a Specialist discovered from the public catalog',
      code: "const [specialist] = await host.agents.list()\nconst outcome = await host.delegate({ name: 'Statistical audit', task: 'Verify the statistical assumptions', profile: specialist.id })"
    },
    {
      title: 'Observe an atomic fan-out for a bounded time',
      code: "globalThis.delegation = await host.delegate([{ name: 'Registry search', task: 'Search trial registries' }, { name: 'Analysis audit', task: 'Audit the analysis' }], { timeout_seconds: 30 })"
    },
    {
      title: 'Dispatch in parallel, continue, then collect',
      code: "const dispatched = await host.delegate([{ name: 'Registry search', task: 'Search trial registries' }, { name: 'Analysis audit', task: 'Audit the analysis' }], { wait: false })\nconst results = await host.collect(dispatched.children.map(child => child.frame_id))"
    }
  ],
  errors: DELEGATE_AGENT_CONTRACT.errors,
  resolveAvailability: ({ callerRole, capabilities }) => {
    if (callerRole === 'delegate') {
      return {
        status: 'unavailable',
        reason: 'Nested delegation is unsupported for Delegate agents.'
      }
    }
    if (!capabilities.delegate) return unavailableProvisioning('delegate')
    return { status: 'available' }
  }
}

const CHILDREN_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.children',
  path: 'host.children',
  aliases: ['children'],
  summary: 'List current direct-child Attempts on the active Message Branch.',
  call_forms: [
    { signature: 'await host.children()', accepts: 'no_arguments' },
    { signature: 'await host.children(frame_ids)', accepts: 'frame_id_array' }
  ],
  request: {
    type: 'array',
    description:
      'An optional array of Frame ids. Omit it to list all accessible current direct-child Attempts.',
    items: { type: 'string', minLength: 1 }
  },
  options: {},
  returns: {
    type: 'array',
    order: 'durable_admission_order_active_branch_subsequence',
    items: {
      type: 'object',
      required: ['frame_id', 'attempt_id', 'name', 'agent_name', 'status'],
      optional: ['title'],
      properties: {
        frame_id: { type: 'string' },
        attempt_id: { type: 'string' },
        title: { type: 'string' },
        name: { type: 'string' },
        agent_name: { type: 'string' },
        status: { type: 'string', enum: ['running', 'completed', 'cancelled', 'error'] }
      }
    }
  },
  constraints: [
    'Root Main only; lists current Attempts for direct children on the active Message Branch.',
    'The result preserves durable admission order restricted to the active-branch subsequence.',
    'It does not recover historical Attempt handles or original delegation batch correlation.',
    'Legacy children whose origin cannot be proven are unavailable.'
  ],
  examples: [
    { title: 'Recover current handles', code: 'const current = await host.children()' },
    {
      title: 'Inspect selected current children',
      code: 'await host.children(current.map(({ frame_id }) => frame_id))'
    }
  ],
  errors: {
    thrown_type: 'Error',
    message_prefix: 'host.children: ',
    domain_error_code_exposed: false
  },
  resolveAvailability: rootOnlyAvailability(
    'children',
    'Delegate agents cannot inspect or manage child inventory.'
  )
}

const COLLECT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.collect',
  path: 'host.collect',
  aliases: ['collect'],
  summary: 'Observe pinned Subagent Attempts until all settle or a bounded deadline expires.',
  call_forms: [
    {
      signature: 'await host.collect(selectors, options?)',
      accepts: 'non_empty_selector_array'
    }
  ],
  request: COLLECT_AGENT_CONTRACT.selectors,
  options: COLLECT_AGENT_CONTRACT.options,
  returns: COLLECT_AGENT_CONTRACT.returns,
  constraints: [
    'timeout_seconds defaults to 30 and must be a finite number from 0 through 1800.',
    'A string pins the current Attempt; a frame_id/attempt_id handle can select history.',
    'Expiry returns running observations and never stops or cancels a Subagent.',
    'Only direct children on the active Message Branch are discoverable and collectible.'
  ],
  examples: [
    {
      title: 'Cell 1 — preserve handles',
      code: "globalThis.pendingDelegation = await host.delegate({ name: 'Source trace', task: 'Trace sources' }, { wait: false })"
    },
    {
      title: 'Cell 2 — collect pinned Attempts',
      code: 'await host.collect(globalThis.pendingDelegation.children.map(({ frame_id, attempt_id }) => ({ frame_id, attempt_id })), { timeout_seconds: 30 })'
    }
  ],
  errors: COLLECT_AGENT_CONTRACT.errors,
  resolveAvailability: rootOnlyAvailability(
    'collect',
    'Delegate agents cannot collect child Attempts.'
  )
}

const STOP_CHILD_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.stop_child',
  path: 'host.stop_child',
  aliases: ['stop_child'],
  summary: 'Stop one or more direct-child Frames without changing terminal children.',
  call_forms: [
    {
      signature: 'await host.stop_child(frame_ids)',
      accepts: 'non_empty_frame_id_array'
    }
  ],
  request: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  options: {},
  returns: {
    type: 'array',
    items: {
      type: 'object',
      required: ['frame_id', 'status'],
      optional: [],
      properties: {
        frame_id: { type: 'string' },
        status: { type: 'string', enum: ['cancelled', 'already_terminal'] }
      }
    }
  },
  constraints: [
    'Root Main only; every target must be an authorized direct child on the active Message Branch.',
    'The array must be non-empty; results correspond to the requested Frame ids.',
    'A terminal child is preserved and reported as already_terminal.',
    'Each target can succeed independently; there is no all-or-nothing rollback.'
  ],
  examples: [
    {
      title: 'Stop current children',
      code: 'await host.stop_child(current.map(({ frame_id }) => frame_id))'
    }
  ],
  errors: {
    thrown_type: 'Error',
    message_prefix: 'host.stop_child: ',
    domain_error_code_exposed: false
  },
  resolveAvailability: rootOnlyAvailability(
    'stop_child',
    'Delegate agents cannot stop or manage child Frames.'
  )
}

const SUBMIT_OUTPUT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.submit_output',
  path: 'host.submit_output',
  aliases: ['submit_output'],
  summary: 'Submit the authenticated child Attempt structured JSON value.',
  call_forms: [{ signature: 'await host.submit_output(value)', accepts: 'json_value' }],
  request: { description: 'A JSON value validated against the schema admitted for this Attempt.' },
  options: {},
  returns: {
    type: 'object',
    required: ['accepted'],
    properties: { accepted: { type: 'boolean', enum: [true] } }
  },
  constraints: [
    'Available only to a running child Attempt that was delegated with output_schema.',
    'The first valid value is durable; an equal retry is idempotent and a different retry is rejected.',
    'Submission does not end the Attempt and does not replace text or Artifact output.'
  ],
  examples: [
    { title: 'Submit a validated result', code: 'await host.submit_output({ answer: 42 })' }
  ],
  errors: {
    thrown_type: 'Error',
    message_prefix: 'host.submit_output: ',
    domain_error_code_exposed: false
  },
  resolveAvailability: ({ callerRole, capabilities }) => {
    if (callerRole !== 'delegate') {
      return { status: 'unavailable', reason: 'Only a delegated child Attempt can submit output.' }
    }
    return capabilities.submit_output
      ? { status: 'available' }
      : unavailableProvisioning('submit_output')
  }
}

const messageAvailability =
  (
    operation: 'send_message' | 'message_receipt'
  ): HostSdkHelpOperationDescriptor['resolveAvailability'] =>
  ({ capabilities }) =>
    capabilities[operation] ? { status: 'available' } : unavailableProvisioning(operation)

const DELIVERY_RECEIPT_SCHEMA = {
  type: 'delivery_receipt',
  allOf: [
    {
      type: 'object',
      required: [
        'request_id',
        'message_id',
        'source_frame_id',
        'target_frame_id',
        'queued_at',
        'same_request_safe'
      ],
      optional: ['reply_to_message_id'],
      properties: {
        request_id: { type: 'string' },
        message_id: { type: 'string' },
        source_frame_id: { type: 'string' },
        target_frame_id: { type: 'string' },
        reply_to_message_id: { type: 'string' },
        queued_at: { type: 'number' },
        same_request_safe: { type: 'boolean', enum: [true] }
      }
    },
    {
      discriminator: { propertyName: 'direction' },
      oneOf: [
        {
          type: 'object',
          required: ['direction', 'disposition', 'target_attempt_id'],
          forbidden: ['source_attempt_id', 'continuation_attempt_id', 'root_prompt_message_id'],
          properties: {
            direction: { enum: ['to_child'] },
            disposition: { enum: ['message'] },
            target_attempt_id: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['direction', 'disposition', 'continuation_attempt_id'],
          forbidden: ['source_attempt_id', 'target_attempt_id', 'root_prompt_message_id'],
          properties: {
            direction: { enum: ['to_child'] },
            disposition: { enum: ['continued'] },
            continuation_attempt_id: { type: 'string' }
          }
        },
        {
          type: 'object',
          required: ['direction', 'disposition', 'source_attempt_id', 'root_prompt_message_id'],
          forbidden: ['target_attempt_id', 'continuation_attempt_id'],
          properties: {
            direction: { enum: ['to_parent'] },
            disposition: { enum: ['message'] },
            source_attempt_id: { type: 'string' },
            root_prompt_message_id: { type: 'string' }
          }
        }
      ]
    },
    {
      discriminator: { propertyName: 'status' },
      oneOf: [
        {
          type: 'object',
          required: ['status', 'new_request_retry_safe'],
          optional: ['dispatch_started_at'],
          properties: {
            status: { enum: ['queued'] },
            dispatch_started_at: { type: 'number' },
            new_request_retry_safe: { enum: [false] }
          }
        },
        {
          type: 'object',
          required: ['status', 'accepted_at', 'evidence', 'new_request_retry_safe'],
          properties: {
            status: { enum: ['accepted'] },
            accepted_at: { type: 'number' },
            evidence: { enum: ['provider_prompt_accepted', 'provider_prompt_completed'] },
            new_request_retry_safe: { enum: [false] }
          }
        },
        {
          type: 'object',
          required: ['status', 'failed_at', 'error', 'new_request_retry_safe'],
          properties: {
            status: { enum: ['failed'] },
            failed_at: { type: 'number' },
            error: {
              type: 'object',
              required: ['code', 'message', 'retryable', 'delivery_may_have_occurred'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retryable: { type: 'boolean' },
                delivery_may_have_occurred: { enum: [false] }
              }
            },
            new_request_retry_safe: {
              type: 'boolean',
              description: 'Equals error.retryable.'
            }
          }
        },
        {
          type: 'object',
          required: [
            'status',
            'uncertain_at',
            'delivery_may_have_occurred',
            'resolution',
            'new_request_retry_safe'
          ],
          properties: {
            status: { enum: ['uncertain'] },
            uncertain_at: { type: 'number' },
            delivery_may_have_occurred: { enum: [true] },
            resolution: { enum: ['pending', 'acknowledged'] },
            new_request_retry_safe: { enum: [false] }
          }
        }
      ]
    }
  ]
} as const

const RESOLVED_DELIVERY_RECEIPT_SCHEMA = {
  type: 'delivery_receipt',
  allOf: [
    DELIVERY_RECEIPT_SCHEMA.allOf[0],
    DELIVERY_RECEIPT_SCHEMA.allOf[1],
    {
      discriminator: { propertyName: 'status' },
      oneOf: [
        {
          type: 'object',
          required: [
            'status',
            'uncertain_at',
            'delivery_may_have_occurred',
            'resolution',
            'new_request_retry_safe'
          ],
          properties: {
            status: { enum: ['uncertain'] },
            uncertain_at: { type: 'number' },
            delivery_may_have_occurred: { enum: [true] },
            resolution: { enum: ['acknowledged'] },
            new_request_retry_safe: { enum: [false] }
          }
        }
      ]
    }
  ]
} as const
const SEND_MESSAGE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.send_message',
  path: 'host.send_message',
  aliases: ['send_message'],
  summary: 'Durably queue a reliable message to a direct child or its root parent.',
  call_forms: [
    {
      signature: 'await host.send_message(target, message, options?)',
      accepts: 'target_message_options'
    }
  ],
  request: { target: { type: 'string' }, message: { type: 'string', minLength: 1 } },
  options: {
    kind: { enum: ['info', 'question'], default: 'info' },
    request_id: { type: 'string' },
    reply_to_message_id: { type: 'string' }
  },
  returns: DELIVERY_RECEIPT_SCHEMA,
  constraints: [
    'Main targets one authorized direct-child Frame; a Delegate can target only the literal "parent".',
    'Receipt is delivery evidence, never a reply.',
    'Same request_id and payload recover one durable command; a different payload conflicts.',
    'uncertain is never automatically retried.'
  ],
  examples: [
    {
      title: 'Ask a child',
      code: "await host.send_message(child.frame_id, 'Which source supports this?', { kind: 'question', request_id: 'source-question-1' })"
    },
    {
      title: 'Ask the root parent from a Delegate',
      code: "await host.send_message('parent', 'Which cohort should I use?', { kind: 'question', request_id: 'cohort-question-1' })"
    }
  ],
  errors: { thrown_type: 'Error', domain_error_code_exposed: false },
  resolveAvailability: messageAvailability('send_message')
}
const MESSAGE_RECEIPT_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.message_receipt',
  path: 'host.message_receipt',
  aliases: ['message_receipt'],
  summary: 'Observe an owned delivery receipt for a bounded time.',
  call_forms: [
    {
      signature: 'await host.message_receipt(message_id_or_request_id, options?)',
      accepts: 'selector_options'
    }
  ],
  request: { selector: { type: 'string' } },
  options: { timeout_seconds: { type: 'number', minimum: 0, maximum: 1800, default: 30 } },
  returns: DELIVERY_RECEIPT_SCHEMA,
  constraints: [
    'The selector is a message_id or caller-owned request_id; a Delegate cannot observe another source principal command.',
    'Authorization is revalidated for every observation.',
    'Timeout returns the latest receipt and changes no delivery state.'
  ],
  examples: [
    {
      title: 'Observe',
      code: 'await host.message_receipt(receipt.message_id, { timeout_seconds: 30 })'
    }
  ],
  errors: { thrown_type: 'Error', domain_error_code_exposed: false },
  resolveAvailability: messageAvailability('message_receipt')
}
const RESOLVE_MESSAGE_DESCRIPTOR: HostSdkHelpOperationDescriptor = {
  kind: 'operation',
  id: 'host.resolve_message',
  path: 'host.resolve_message',
  aliases: ['resolve_message'],
  summary: 'Acknowledge an uncertain delivery risk and release its lane fence.',
  call_forms: [
    {
      signature: "await host.resolve_message(message_id, { action: 'acknowledge_uncertain' })",
      accepts: 'message_resolution'
    }
  ],
  request: { message_id: { type: 'string' } },
  options: { action: { enum: ['acknowledge_uncertain'] } },
  returns: RESOLVED_DELIVERY_RECEIPT_SCHEMA,
  constraints: [
    'Root Main only.',
    'Does not mark accepted or failed and does not retry the payload.'
  ],
  examples: [
    {
      title: 'Release fence',
      code: "await host.resolve_message(receipt.message_id, { action: 'acknowledge_uncertain' })"
    }
  ],
  errors: { thrown_type: 'Error', domain_error_code_exposed: false },
  resolveAvailability: rootOnlyAvailability(
    'resolve_message',
    'Only root Main can resolve uncertain delivery.'
  )
}

// Adding another documented Host SDK operation only requires registering its descriptor here.
const OPERATION_DESCRIPTORS: readonly HostSdkHelpOperationDescriptor[] = [
  CHILDREN_DESCRIPTOR,
  COLLECT_DESCRIPTOR,
  DELEGATE_DESCRIPTOR,
  MESSAGE_RECEIPT_DESCRIPTOR,
  RESOLVE_MESSAGE_DESCRIPTOR,
  SEND_MESSAGE_DESCRIPTOR,
  STOP_CHILD_DESCRIPTOR,
  SUBMIT_OUTPUT_DESCRIPTOR
]

const registeredOperationIds = [...OPERATION_DESCRIPTORS]
  .map(({ id }) => id)
  .sort() as (typeof HOST_SDK_SUBAGENT_OPERATION_IDS)[number][]
if (JSON.stringify(registeredOperationIds) !== JSON.stringify(HOST_SDK_SUBAGENT_OPERATION_IDS)) {
  throw new Error('Host SDK Subagent Help registry does not match its published operation ids.')
}
const MAX_HELP_QUERY_CHARS = 128
const MAX_HELP_RESULT_CHARS = 16_000

const normalizeTopic = (value: string): string => value.trim().toLowerCase()

const toBoundedJsonResult = <T extends HostSdkHelpResult>(result: T): T => {
  const serialized = JSON.stringify(result)
  if (serialized.length > MAX_HELP_RESULT_CHARS) {
    throw new Error('Host SDK help result exceeds its size limit.')
  }
  return JSON.parse(serialized) as T
}

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

const entries = [...OPERATION_DESCRIPTORS].sort((left, right) => left.id.localeCompare(right.id))
const topics = new Map<string, HostSdkHelpOperationDescriptor>()
for (const descriptor of entries) {
  for (const topic of [descriptor.id, descriptor.path, ...descriptor.aliases]) {
    const normalizedTopic = normalizeTopic(topic)
    const existing = topics.get(normalizedTopic)
    if (existing && existing !== descriptor) {
      throw new Error(`Host SDK help topic "${normalizedTopic}" is registered more than once.`)
    }
    topics.set(normalizedTopic, descriptor)
  }
}

const hostSdkHelp: HostSdkHelpRegistry = Object.freeze({
  query(query, context) {
    if (query === undefined) {
      return toBoundedJsonResult({
        kind: 'catalog',
        coverage: 'registered_topics_only',
        topics: entries.map((descriptor) => ({
          id: descriptor.id,
          kind: descriptor.kind,
          path: descriptor.path,
          aliases: descriptor.aliases,
          summary: descriptor.summary,
          availability: descriptor.resolveAvailability(context)
        })),
        hint: "Query an exact topic, for example await host.help('delegate')."
      })
    }
    if (typeof query !== 'string') throw new Error('host.help query must be a string.')
    if (query.length > MAX_HELP_QUERY_CHARS) {
      throw new Error(`host.help query must be at most ${MAX_HELP_QUERY_CHARS} characters.`)
    }
    const normalizedQuery = normalizeTopic(query)
    const descriptor = topics.get(normalizedQuery)
    if (!descriptor) {
      const suggestions = entries
        .map((candidate) => ({
          id: candidate.id,
          score: Math.min(
            ...[candidate.id, candidate.path, ...candidate.aliases].map((topic) =>
              editDistance(normalizedQuery, normalizeTopic(topic))
            )
          )
        }))
        .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
        .slice(0, 3)
        .map(({ id }) => id)
      return toBoundedJsonResult({ kind: 'not_found', query, suggestions })
    }
    const { resolveAvailability, ...contract } = descriptor
    return toBoundedJsonResult({
      ...contract,
      availability: resolveAvailability(context)
    })
  }
})

export { HOST_SDK_SUBAGENT_OPERATION_IDS, hostSdkHelp }
export type { HostSdkHelpContext, HostSdkHelpRegistry, HostSdkHelpResult }
