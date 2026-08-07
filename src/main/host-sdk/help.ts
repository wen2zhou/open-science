import { DELEGATE_AGENT_CONTRACT } from './delegate-contract'

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
  summary: 'Dispatch one Subagent or an atomic fan-out and optionally wait for completion.',
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
    'A request array is admitted atomically and must be non-empty.',
    'Dispatch can be rejected before execution when capacity, framework, Specialist, or input admission is unavailable.',
    'Each child receives only its task, explicit context, and declared immutable inputs.',
    'Use the returned frame_id values with await host.collect(frame_ids) after an asynchronous dispatch.'
  ],
  examples: [
    {
      title: 'Wait for one Subagent',
      code: "const outcome = await host.delegate({ task: 'Verify the statistical assumptions' })"
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

// Adding another documented Host SDK operation only requires registering its descriptor here.
const OPERATION_DESCRIPTORS: readonly HostSdkHelpOperationDescriptor[] = [DELEGATE_DESCRIPTOR]
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
