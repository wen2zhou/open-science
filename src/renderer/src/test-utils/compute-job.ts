import type { JobSummary } from '../../../shared/compute'

export const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-abc',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  status: 'running',
  intent: 'Run EDA',
  created_at: 1000,
  started_at: 1000,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: '/home/user/.openscience/jobs/job-abc',
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  ...overrides
})
