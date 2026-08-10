import { COLLECT_AGENT_CONTRACT, DELEGATE_AGENT_CONTRACT } from './delegate-contract'

type HostSdkHelpContext = Readonly<{
  callerRole: 'main' | 'delegate'
  capabilities: Readonly<Record<string, boolean>>
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
    'Dispatch can be rejected before execution when capacity, framework, Specialist, or input admission is unavailable.',
    'Each child receives only its task, explicit context, and declared immutable inputs.',
    'An explicit timeout_seconds starts after every admitted child establishes launch and returns observations without stopping running children.',
    'wait:false cannot be combined with timeout_seconds; omitting timeout_seconds preserves all-settled waiting.',
    'Use the returned frame_id values with await host.collect(frame_ids) after an asynchronous dispatch.'
  ],
  examples: [
    {
      title: 'Wait for one Subagent',
      code: "const outcome = await host.delegate({ task: 'Verify the statistical assumptions' })"
    },
    {
      title: 'Select a Specialist discovered from the public catalog',
      code: "const [specialist] = await host.agents.list()\nconst outcome = await host.delegate({ task: 'Verify the statistical assumptions', profile: specialist.id })"
    },
    {
      title: 'Observe an atomic fan-out for a bounded time',
      code: "globalThis.delegation = await host.delegate([{ task: 'Search trial registries' }, { task: 'Audit the analysis' }], { timeout_seconds: 30 })"
    },
    {
      title: 'Dispatch in parallel, continue, then collect',
      code: "const dispatched = await host.delegate([{ task: 'Search trial registries' }, { task: 'Audit the analysis' }], { wait: false })\nconst results = await host.collect(dispatched.children.map(child => child.frame_id))"
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
    if (!capabilities.delegation) {
      return {
        status: 'unavailable',
        reason: 'Delegated Work is not provisioned for this Session.'
      }
    }
    return { status: 'available' }
  }
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
      code: "globalThis.pendingDelegation = await host.delegate({ task: 'Trace sources' }, { wait: false })"
    },
    {
      title: 'Cell 2 — collect pinned Attempts',
      code: 'await host.collect(globalThis.pendingDelegation.children.map(({ frame_id, attempt_id }) => ({ frame_id, attempt_id })), { timeout_seconds: 30 })'
    }
  ],
  errors: COLLECT_AGENT_CONTRACT.errors,
  resolveAvailability: DELEGATE_DESCRIPTOR.resolveAvailability
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
  resolveAvailability: ({ callerRole, capabilities }) =>
    callerRole === 'delegate' && capabilities.delegation
      ? { status: 'available' }
      : { status: 'unavailable', reason: 'Only a delegated child Attempt can submit output.' }
}

const MESSAGE_AVAILABILITY = DELEGATE_DESCRIPTOR.resolveAvailability
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
  returns: {
    type: 'delivery_receipt',
    direction: ['to_child', 'to_parent'],
    disposition: ['message', 'continued'],
    status: ['queued', 'accepted', 'failed', 'uncertain']
  },
  constraints: [
    'Receipt is delivery evidence, never a reply.',
    'Same request_id and payload recover one durable command; a different payload conflicts.',
    'uncertain is never automatically retried.'
  ],
  examples: [
    {
      title: 'Ask a child',
      code: "await host.send_message(child.frame_id, 'Which source supports this?', { kind: 'question', request_id: 'source-question-1' })"
    }
  ],
  errors: { thrown_type: 'Error', domain_error_code_exposed: false },
  resolveAvailability: MESSAGE_AVAILABILITY
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
  returns: { type: 'delivery_receipt', status: ['queued', 'accepted', 'failed', 'uncertain'] },
  constraints: [
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
  resolveAvailability: MESSAGE_AVAILABILITY
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
  returns: { type: 'delivery_receipt', status: ['uncertain'], resolution: ['acknowledged'] },
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
  resolveAvailability: ({ callerRole, capabilities }) =>
    callerRole === 'main'
      ? MESSAGE_AVAILABILITY({ callerRole, capabilities })
      : { status: 'unavailable', reason: 'Only root Main can resolve uncertain delivery.' }
}

// Adding another documented Host SDK operation only requires registering its descriptor here.
const OPERATION_DESCRIPTORS: readonly HostSdkHelpOperationDescriptor[] = [
  COLLECT_DESCRIPTOR,
  DELEGATE_DESCRIPTOR,
  MESSAGE_RECEIPT_DESCRIPTOR,
  RESOLVE_MESSAGE_DESCRIPTOR,
  SEND_MESSAGE_DESCRIPTOR,
  SUBMIT_OUTPUT_DESCRIPTOR
]
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

export { hostSdkHelp }
export type { HostSdkHelpContext, HostSdkHelpRegistry, HostSdkHelpResult }
