// Release certification for per-Job cleanup on a real SSH Compute Host. Disabled by default.
//
// RUN_COMPUTE_JOB_CLEANUP=1 \
// COMPUTE_JOB_CLEANUP_SSH_ALIAS=my-host \
// npx vitest run src/main/compute/compute-job-cleanup.real-ssh.integration.test.ts

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ComputeJobStatus, JobSummary } from '../../shared/compute'
import { computeProviderId } from '../../shared/compute'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { ArtifactRepository } from '../artifacts/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { getNotebookSessionRoot } from '../notebook/repository'
import { SessionRepository } from '../session-persistence/repository'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeService } from './compute-service'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { harvestJob } from './harvest-engine'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeJobRepository } from './job-repository'
import { buildJobNotificationSummary, emitJobNotification } from './job-notifier'
import { JobPoller } from './job-poller'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import { ComputeHostRepository } from './repository'
import { SystemScpRunner } from './scp-runner'
import { SystemSshRunner } from './ssh-runner'

const alias = process.env['COMPUTE_JOB_CLEANUP_SSH_ALIAS'] ?? ''
const enabled = process.env['RUN_COMPUTE_JOB_CLEANUP'] === '1' && alias.length > 0
const describeIf = enabled ? describe : describe.skip
const terminalStatuses = new Set<ComputeJobStatus>(['success', 'failed', 'timeout', 'error'])
const pollDeadlineMs = 180_000
const pollPauseMs = 1_000

type RemoteFixture = Readonly<{ workdir: string; ownerMarker: string }>

const approvalBroker = (): ComputeApprovalBroker => {
  let generatedId = ''
  const approval = new ComputeApprovalBroker({
    broadcast: () => undefined,
    generateId: () => {
      generatedId = `cleanup-cert-${randomUUID()}`
      return generatedId
    },
    timeoutMs: 5_000
  })
  const original = approval.requestWithContext.bind(approval)
  approval.requestWithContext = async (info, context, signal) => {
    const pending = original(info, context, signal)
    const requestId = generatedId
    setImmediate(() => approval.respond(requestId, 'once'))
    return pending
  }
  return approval
}

const waitForTerminal = async (
  poller: JobPoller,
  service: ComputeService,
  jobId: string
): Promise<void> => {
  const deadline = Date.now() + pollDeadlineMs
  while (true) {
    const status = await service.getJobStatus(jobId)
    if (terminalStatuses.has(status.status)) return
    if (Date.now() > deadline) {
      throw new Error(`Real SSH cleanup fixture did not finish; last status was ${status.status}.`)
    }
    await poller.tick()
    await new Promise((resolve) => setTimeout(resolve, pollPauseMs))
  }
}

const exactFixtureTeardownCommand = (fixture: RemoteFixture): string => {
  const workdir = quoteRemotePath(fixture.workdir)
  const expectedMarker = shellSingleQuote(fixture.ownerMarker)
  return [
    'set -f',
    `workdir_input=${workdir}`,
    'case "$workdir_input" in "~/"*) workdir=$HOME/${workdir_input#??} ;; *) workdir=$workdir_input ;; esac',
    'marker=$workdir/.openscience-owner',
    'if [ ! -e "$workdir" ] && [ ! -L "$workdir" ]; then',
    "  printf '%s' absent",
    'elif [ -d "$workdir" ] && [ ! -L "$workdir" ] && [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(cat "$marker" 2>/dev/null || :)" = ' +
      expectedMarker +
      ' ]; then',
    '  rm -rf -- "$workdir"',
    "  printf '%s' removed",
    'else',
    "  printf '%s' refused",
    'fi'
  ].join('\n')
}

describeIf('Compute Job cleanup real SSH certification', () => {
  const suiteMarker = randomUUID()
  const projectId = `cleanup-cert-project-${suiteMarker}`
  const sessionId = `cleanup-cert-session-${suiteMarker}`
  const scope = {
    projectId,
    sessionId,
    providerId: computeProviderId(alias)
  }
  const fixtures: RemoteFixture[] = []
  let storageRoot = ''
  let client: ReturnType<typeof createProjectDbClient>
  let hostRepository: ComputeHostRepository
  let jobRepository: ComputeJobRepository
  let operationRepository: ComputeJobOperationRepository
  let connectionBroker: SshConfigComputeConnectionBroker
  let service: ComputeService
  let poller: JobPoller

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'compute-job-cleanup-real-ssh-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    hostRepository = new ComputeHostRepository(() => Promise.resolve(client))
    jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    operationRepository = new ComputeJobOperationRepository(() => Promise.resolve(client))
    const runner = new SystemSshRunner()
    const scpRunner = new SystemScpRunner()
    connectionBroker = new SshConfigComputeConnectionBroker({
      getHost: (providerId) => hostRepository.get(providerId),
      runner,
      scpRunner
    })
    if (!(await hostRepository.get(scope.providerId))) {
      await hostRepository.create({ sshAlias: alias, displayName: `cleanup-cert-${alias}` })
    }
    service = new ComputeService({
      runner,
      scpRunner,
      repository: hostRepository,
      approvalBroker: approvalBroker(),
      jobRepository,
      operationRepository,
      storageRoot,
      connectionBroker
    })
    poller = new JobPoller({ connectionBroker, hostRepository, jobRepository, storageRoot })
  })

  afterAll(async () => {
    const refused: string[] = []
    let teardownError: unknown
    try {
      if (connectionBroker && scope.providerId) {
        const connection = await connectionBroker.acquire(scope.providerId, {
          intent: 'job_cleanup'
        })
        for (const fixture of fixtures.reverse()) {
          const result = await connection.run(exactFixtureTeardownCommand(fixture), {
            timeoutMs: 30_000,
            loginShell: false,
            maxOutputBytes: 64
          })
          if (result.exitCode !== 0 || !['absent', 'removed'].includes(result.stdout)) {
            refused.push(fixture.workdir)
          }
        }
      }
    } catch (error) {
      teardownError = error
    } finally {
      await client?.$disconnect()
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    }
    if (refused.length > 0) {
      throw new Error(`Exact marker-verified teardown refused ${refused.length} fixture(s).`)
    }
    if (teardownError) throw teardownError
  })

  const recordFixture = async (jobId: string): Promise<void> => {
    const job = await jobRepository.get(jobId)
    if (!job?.remote_workdir || !job.owner_marker) {
      throw new Error('Submitted cleanup fixture is missing its owned remote identity.')
    }
    fixtures.push({ workdir: job.remote_workdir, ownerMarker: job.owner_marker })
  }

  const submit = async (
    command: string,
    options: Parameters<ComputeService['submitJob']>[3]
  ): Promise<Awaited<ReturnType<ComputeService['submitJob']>>> => {
    const submitted = await service.submitJob(
      scope.providerId,
      `cleanup certification ${suiteMarker}`,
      command,
      options,
      { sessionId, projectId }
    )
    await recordFixture(submitted.job_id)
    return submitted
  }

  const harvest = async (jobId: string): Promise<void> => {
    await waitForTerminal(poller, service, jobId)
    const job = await jobRepository.get(jobId)
    if (!job) throw new Error('Completed cleanup fixture disappeared before harvest.')
    await harvestJob(job, { connectionBroker, hostRepository, jobRepository, storageRoot })
  }

  const assertWorkspaceAbsent = async (workdir: string): Promise<void> => {
    const observed = await service.callCommand(
      scope.providerId,
      `if [ -e ${quoteRemotePath(workdir)} ] || [ -L ${quoteRemotePath(workdir)} ]; then printf present; else printf absent; fi`,
      'observe exact cleanup certification fixture',
      false,
      30,
      { sessionId, projectId }
    )
    expect(observed).toMatchObject({ exit_code: 0, stdout: 'absent' })
  }

  it('removes a fully harvested workspace without disturbing an active sibling or Provider reuse', async () => {
    const inputName = `cleanup-input-${suiteMarker}.txt`
    await writeFile(join(storageRoot, inputName), 'published artifact from staged input\n')
    const completed = await submit(
      `printf 'cleanup stdout\\n'; printf 'cleanup stderr\\n' >&2; cat ${shellSingleQuote(inputName)} > result.txt`,
      {
        inputs: [{ src: inputName, dst_filename: inputName }],
        workspaceCwd: storageRoot,
        outputManifest: JSON.stringify(['result.txt']),
        timeoutSeconds: 60
      }
    )
    await harvest(completed.job_id)
    const before = await service.getJobResult(completed.job_id, scope)
    expect(before).toMatchObject({ status: 'success', harvest_error: undefined })
    expect(before.output_files).toHaveLength(1)
    const localOutput = join(
      getNotebookSessionRoot(storageRoot, projectId, sessionId),
      before.output_files[0]!
    )
    await expect(readFile(localOutput, 'utf8')).resolves.toBe(
      'published artifact from staged input\n'
    )

    const artifactRepository = new ArtifactRepository(storageRoot)
    const artifactRunId = `cleanup-cert-run-${suiteMarker}`
    const artifactMessageId = `cleanup-cert-message-${suiteMarker}`
    await artifactRepository.writePendingFile({
      projectId,
      sessionId,
      runId: artifactRunId,
      filename: 'certified-result.txt',
      mimeType: 'text/plain',
      source: { kind: 'localPath', path: localOutput }
    })
    await artifactRepository.finalizeRunArtifacts({
      projectId,
      sessionId,
      runId: artifactRunId,
      messageId: artifactMessageId
    })
    const artifactBefore = await artifactRepository.listMessageFiles({
      projectId,
      sessionId,
      messageId: artifactMessageId
    })
    expect(artifactBefore).toHaveLength(1)
    await expect(readFile(artifactBefore[0]!.path, 'utf8')).resolves.toBe(
      'published artifact from staged input\n'
    )

    const notificationProjection: JobSummary[] = []
    const harvestedJob = await jobRepository.get(completed.job_id)
    if (!harvestedJob) throw new Error('Harvested cleanup fixture disappeared before notification.')
    await emitJobNotification(harvestedJob, {
      jobRepository,
      hostRepository,
      storageRoot,
      broadcast: (summary) => notificationProjection.push(summary)
    })
    expect(notificationProjection).toHaveLength(1)
    expect(notificationProjection[0]).toMatchObject({
      job_id: completed.job_id,
      status: 'success',
      featured_file_count: 1,
      harvest_error: undefined
    })
    const analysisMessageId = `cleanup-cert-analysis-${suiteMarker}`
    const analysisResponseId = `cleanup-cert-analysis-response-${suiteMarker}`
    const analysisCreatedAt = Date.now()
    const analysisPrompt: PersistedChatMessage = {
      id: analysisMessageId,
      role: 'user',
      content: 'Analyze the completed cleanup certification Job.',
      attribution: {
        kind: 'application',
        feature: 'compute',
        purpose: 'job-completion-analysis',
        deliveryKey: `compute_done:${sessionId}:${completed.job_id}`,
        jobIds: [completed.job_id]
      },
      status: 'complete',
      eventIds: [],
      createdAt: analysisCreatedAt,
      completedAt: analysisCreatedAt,
      updatedAt: analysisCreatedAt
    }
    const sessionRepository = new SessionRepository(storageRoot)
    const pendingAnalysisSession = (await sessionRepository.saveSession({
      id: sessionId,
      projectId,
      title: 'Compute cleanup certification',
      cwd: storageRoot,
      status: 'idle',
      messages: [analysisPrompt],
      conversationGraph: createLinearConversationGraph({
        sessionId,
        messages: [analysisPrompt],
        createdAt: analysisCreatedAt,
        updatedAt: analysisCreatedAt
      }),
      createdAt: analysisCreatedAt,
      updatedAt: analysisCreatedAt
    })) satisfies PersistedChatSession
    await jobRepository.transitionAnalysis({
      sessionId,
      jobIds: [completed.job_id],
      messageId: analysisMessageId,
      state: 'dispatched'
    })
    const analysisResponse: PersistedChatMessage = {
      id: analysisResponseId,
      role: 'agent',
      content: 'The completed Job produced one readable published result.',
      responseToMessageId: analysisMessageId,
      status: 'complete',
      eventIds: [],
      createdAt: analysisCreatedAt + 1,
      completedAt: analysisCreatedAt + 1,
      updatedAt: analysisCreatedAt + 1
    }
    const analysisMessages = [analysisPrompt, analysisResponse]
    await sessionRepository.saveSession({
      ...pendingAnalysisSession,
      messages: analysisMessages,
      conversationGraph: createLinearConversationGraph({
        sessionId,
        messages: analysisMessages,
        createdAt: analysisCreatedAt,
        updatedAt: analysisCreatedAt + 1
      }),
      updatedAt: analysisCreatedAt + 1
    })
    await jobRepository.transitionAnalysis({
      sessionId,
      jobIds: [completed.job_id],
      messageId: analysisMessageId,
      state: 'succeeded'
    })
    const lifecycleBefore = await jobRepository.get(completed.job_id)
    expect(lifecycleBefore).toMatchObject({
      notified_at: expect.any(Number),
      notification_consumed_at: expect.any(Number),
      analysis_state: 'succeeded',
      analysis_message_id: analysisMessageId,
      analysis_updated_at: expect.any(Number)
    })
    const notificationBefore = await buildJobNotificationSummary(lifecycleBefore!, {
      hostRepository,
      storageRoot
    })
    expect(notificationBefore).toMatchObject({
      job_id: completed.job_id,
      featured_files: notificationProjection[0]!.featured_files,
      featured_file_count: 1,
      notification_consumed_at: lifecycleBefore!.notification_consumed_at
    })
    const analysisBefore = await sessionRepository.loadSession(projectId, sessionId)
    expect(analysisBefore?.messages).toEqual(analysisMessages)
    expect(analysisBefore?.conversationGraph?.messages).toHaveLength(2)

    const sibling = await submit("sleep 20; printf 'sibling survived\\n' > sibling.txt", {
      outputManifest: JSON.stringify(['sibling.txt']),
      timeoutSeconds: 60
    })
    const receipt = await service.cleanupJob(completed.job_id, scope, `full-remove-${suiteMarker}`)
    expect(receipt).toMatchObject({ outcome: 'workspace_removed', workspace_removed: true })
    expect(receipt.deleted_object_count).toBeGreaterThan(0)
    expect(receipt.disposition).toBe('The verified remote Job workspace was removed.')
    await assertWorkspaceAbsent(completed.remote_workdir)

    const after = await service.getJobResult(completed.job_id, scope)
    expect(after.output_files).toEqual(before.output_files)
    expect(after.stdout_tail).toEqual(before.stdout_tail)
    expect(after.stderr_tail).toEqual(before.stderr_tail)
    expect(after.last_cleanup).toEqual(receipt)
    await expect(readFile(localOutput, 'utf8')).resolves.toBe(
      'published artifact from staged input\n'
    )
    const artifactAfter = await artifactRepository.listMessageFiles({
      projectId,
      sessionId,
      messageId: artifactMessageId
    })
    expect(artifactAfter).toEqual(artifactBefore)
    await expect(readFile(artifactAfter[0]!.path, 'utf8')).resolves.toBe(
      'published artifact from staged input\n'
    )
    const lifecycleAfter = await jobRepository.get(completed.job_id)
    expect(lifecycleAfter).toMatchObject({
      notified_at: lifecycleBefore!.notified_at,
      notification_consumed_at: lifecycleBefore!.notification_consumed_at,
      analysis_state: lifecycleBefore!.analysis_state,
      analysis_message_id: lifecycleBefore!.analysis_message_id,
      analysis_updated_at: lifecycleBefore!.analysis_updated_at
    })
    await expect(
      buildJobNotificationSummary(lifecycleAfter!, { hostRepository, storageRoot })
    ).resolves.toEqual(notificationBefore)
    await expect(sessionRepository.loadSession(projectId, sessionId)).resolves.toEqual(
      analysisBefore
    )
    const duplicateNotifications: JobSummary[] = []
    await emitJobNotification(lifecycleAfter!, {
      jobRepository,
      hostRepository,
      storageRoot,
      broadcast: (summary) => duplicateNotifications.push(summary)
    })
    expect(duplicateNotifications).toEqual([])

    await harvest(sibling.job_id)
    await expect(service.getJobResult(sibling.job_id, scope)).resolves.toMatchObject({
      status: 'success'
    })
    const direct = await service.callCommand(
      scope.providerId,
      `printf ${shellSingleQuote(`provider-reused-${suiteMarker}`)}`,
      'verify Provider reuse after cleanup',
      false,
      30,
      { sessionId, projectId }
    )
    expect(direct).toMatchObject({ exit_code: 0, stdout: `provider-reused-${suiteMarker}` })
    const followup = await submit("printf 'followup\\n' > followup.txt", {
      outputManifest: JSON.stringify(['followup.txt']),
      timeoutSeconds: 60
    })
    await harvest(followup.job_id)
    await expect(service.getJobResult(followup.job_id, scope)).resolves.toMatchObject({
      status: 'success'
    })
  }, 360_000)

  it('re-evaluates a partial cleanup after the managed downstream protection is released', async () => {
    const producer = await submit(
      "printf 'published\\n' > published.txt; printf 'retained\\n' > retained.txt",
      {
        outputManifest: JSON.stringify([
          'published.txt',
          { glob: 'retained.txt', residency: 'remote' }
        ]),
        timeoutSeconds: 60
      }
    )
    await harvest(producer.job_id)
    const producerResult = await service.getJobResult(producer.job_id, scope)
    expect(producerResult.left_on_remote).toHaveLength(1)
    const retainedUri = producerResult.left_on_remote[0]!.uri

    const consumer = await submit('cat retained.txt > consumed.txt; sleep 20', {
      inputs: [{ remote_path: retainedUri, dst_filename: 'retained.txt' }],
      outputManifest: JSON.stringify(['consumed.txt']),
      timeoutSeconds: 60
    })
    const invocation = `protected-${suiteMarker}`
    const protectedReceipt = await service.cleanupJob(producer.job_id, scope, invocation)
    expect(protectedReceipt).toMatchObject({
      outcome: 'partially_cleaned',
      retained_object_counts: {
        active_downstream_reference: 1,
        only_remote_copy: 1
      },
      retry_recommended: true,
      retry_conditions: ['downstream_terminal']
    })
    expect(protectedReceipt.disposition.length).toBeGreaterThan(0)
    await expect(service.cleanupJob(producer.job_id, scope, invocation)).resolves.toEqual(
      protectedReceipt
    )

    await harvest(consumer.job_id)
    const rechecked = await service.cleanupJob(producer.job_id, scope, `released-${suiteMarker}`)
    expect(rechecked.retained_object_counts).not.toHaveProperty('active_downstream_reference')
    expect(rechecked.retained_object_counts).toMatchObject({ only_remote_copy: 1 })
    expect(rechecked.retry_conditions).toEqual([])
    expect(rechecked.retry_recommended).toBe(false)
    expect(rechecked.disposition.length).toBeGreaterThan(0)
    expect(rechecked).not.toEqual(protectedReceipt)
  }, 300_000)

  it('projects a caller timeout through the real SSH broker as indeterminate and converges on retry', async () => {
    const submitted = await submit("printf 'timeout retry\\n' > result.txt", {
      outputManifest: JSON.stringify(['result.txt']),
      timeoutSeconds: 60
    })
    await harvest(submitted.job_id)
    const expiredSignal = AbortSignal.timeout(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(expiredSignal.aborted).toBe(true)

    const uncertain = await service.cleanupJob(
      submitted.job_id,
      scope,
      `timeout-${suiteMarker}`,
      expiredSignal
    )
    expect(uncertain).toMatchObject({
      outcome: 'indeterminate',
      workspace_removed: false,
      retained_object_counts: { remote_state_uncertain: 1 },
      retained_object_count_unknown: true,
      retry_recommended: true,
      retry_conditions: ['host_reachable']
    })
    expect(uncertain.disposition.length).toBeGreaterThan(0)
    await expect(service.getJobStatus(submitted.job_id, scope)).resolves.toMatchObject({
      last_cleanup: uncertain
    })
    await expect(
      service.cleanupJob(submitted.job_id, scope, `timeout-retry-${suiteMarker}`)
    ).resolves.toMatchObject({
      outcome: 'workspace_removed',
      workspace_removed: true
    })
  }, 360_000)
})
