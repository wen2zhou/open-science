# Compute Job cleanup — real SSH certification

This certification exercises the product `submitJob` → `getJobResult` → `cleanupJob` lifecycle on
one real SSH Compute Host. It is disabled by default and is not run in CI.

## Prerequisites

- Configure a dedicated, non-production SSH alias in `~/.ssh/config`.
- Confirm the account can create files below its Open Science scratch root and has enough space for
  several small Job workspaces.
- Ensure no other process modifies `.openscience/jobs/<job-id>` while certification is running.
- Do not use a shared administrator account or a Host containing irreplaceable data.

Run only after reviewing the alias:

```bash
RUN_COMPUTE_JOB_CLEANUP=1 \
COMPUTE_JOB_CLEANUP_SSH_ALIAS=my-dedicated-test-host \
npx vitest run src/main/compute/compute-job-cleanup.real-ssh.integration.test.ts
```

Without both variables the file is collected but all real-host tests are skipped. Merely setting an
alias does not authorize a connection.

## Certified behavior

The suite creates UUID-scoped Project, Session, Job, invocation, and owner-marker identities. It
checks:

- full removal after output and complete-log harvest while the local result remains readable;
- an active sibling Job, later submission, and direct command on the same Provider continue to work;
- a remote-resident producer output is partially cleaned and protected by an active managed
  downstream reference;
- replay of the same invocation returns the same receipt, while a new invocation after the consumer
  terminates re-evaluates the retained reasons;
- deterministic connection-seam faults project unreachable and caller-timeout attempts as
  `indeterminate`, and a later real-connection retry converges;
- receipt outcomes, stable reason codes, retry conditions, counts, and disposition remain sufficient
  for an Agent without inspecting database internals or issuing a raw deletion command.

The current public seam has no operation that releases an explicitly remote-resident
`left_on_remote` object. After the managed consumer reaches a terminal state, certification expects
`active_downstream_reference` to disappear but `only_remote_copy` to remain. This is not reported as
full reclamation. A future retention-release API must add a certification step before claiming that
the producer workspace can be completely removed after downstream completion.

## Evidence record

Record one JSON object per run. Do not include SSH usernames, hostnames, absolute remote paths,
commands containing research data, file contents, credentials, or raw stderr. Use this shape:

```json
{
  "run_at": "2026-09-02T12:00:00Z",
  "commit": "<git commit>",
  "platform": "darwin-arm64",
  "ssh_alias_label": "dedicated-test-host",
  "tests": {
    "workspace_removed": "pass",
    "local_result_preserved": "pass",
    "downstream_protection_released": "pass",
    "provider_reused": "pass",
    "unreachable_retry": "pass",
    "timeout_retry": "pass"
  },
  "receipts": [
    {
      "scenario": "full-removal",
      "outcome": "workspace_removed",
      "workspace_removed": true,
      "deleted_object_count": 7,
      "retained_object_counts": {},
      "retained_object_count_unknown": false,
      "retry_recommended": false,
      "retry_conditions": [],
      "disposition": "The verified remote Job workspace was removed."
    }
  ],
  "unexpected_findings": []
}
```

Counts and receipts must be copied from the product result, but Job IDs and paths must be replaced
with scenario labels. Store evidence only in an approved release record; this repository document is
the procedure, not a place for environment-specific data.

## Safe teardown

The test tracks each exact product-created workdir together with its random owner marker. Teardown
does nothing unless the exact path is still a normal directory and `.openscience-owner` is still a
normal file whose contents match that Job's marker. It then removes only that exact workdir. It never
deletes a scratch root, `.openscience`, `jobs`, a Project/Session prefix, a glob, or a set of paths
assembled into one broad command.

If teardown reports `refused`, stop and inspect that exact fixture manually. Do not replace the guard
with a broad `rm`, and do not claim certification complete until every created fixture is either
product-cleaned or independently verified and safely removed.
