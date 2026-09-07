# Background Result Delivery implementation

Status: implementation specification

## Decision

Keep one durable cross-source delivery ledger, rename it to `BackgroundResultDelivery`, and make it own only automatic-delivery workflow state. Notebook Run JSON and `ComputeJob` remain the execution authorities. Result summaries, output, file lists, terminal status, execution type, and host metadata must never be copied into the delivery table.

This replaces the unreleased `0032_agent_result_delivery` design. It does not add a compatibility layer or a second persistent read model.

## Scope

The delivery Module must:

- register accepted local Runs and Compute Jobs for automatic delivery;
- transition registered sources to pending when their authoritative outcome becomes deliverable;
- lease and batch pending outcomes per Session;
- correlate provider admission with a durable continuation message;
- suppress automatic delivery when the Agent observes a result directly;
- recover expired claims and already-saved continuations after restart;
- expose safe Session and Project activity projections;
- fence and remove rows when their Session or Project is deleted.

It must not:

- become an execution authority;
- persist any result payload or decrypted Compute data;
- backfill historical terminal Compute Jobs into automatic delivery;
- add scheduled TTL cleanup;
- add a separate activity table, delivery intent table, or payload encryption abstraction.

## Data model

```prisma
model BackgroundResultDelivery {
  id                    String   @id
  sourceKind            String
  sourceId              String
  projectId             String
  sessionId             String
  agentFrameId          String?
  state                 String
  attemptCount          Int      @default(0)
  claimToken            String?
  claimExpiresAt        DateTime?
  continuationMessageId String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@unique([sourceKind, sourceId])
  @@index([sessionId, state, createdAt, id])
  @@index([sourceKind, state, createdAt, id])
}
```

`id` remains an opaque stable delivery identifier. The Implementation may continue to generate `${sourceKind}:${sourceId}`, but SQLite must not enforce that representation.

`projectId` and `sessionId` are intentionally stored because they are delivery ownership and query keys. `agentFrameId` is retained only to resolve local delegated Runs. All other source facts are resolved from the authoritative source when needed.

### States

```text
waiting-result -> pending -> claimed -> dispatching -> consumed
                    ^          |           |
                    +----------+-----------+  retry / expired lease
                               |
                               +-> needs-attention

waiting-result | pending | claimed | needs-attention -> consumed
    when the Agent observes the source result directly
```

The closed state set is:

- `waiting-result`
- `pending`
- `claimed`
- `dispatching`
- `consumed`
- `needs-attention`

`consumed` deliberately covers both direct observation and committed automatic delivery. A non-null `continuationMessageId` identifies the latter. They have identical future behavior and do not justify separate states.

### Database constraints

Add only constraints that protect identity, idempotency, or crash recovery:

1. `UNIQUE(sourceKind, sourceId)`.
2. `sourceKind IN ('local-run', 'compute-job')`.
3. `state` is in the six-value set above.
4. `id`, `sourceId`, `projectId`, and `sessionId` are non-empty after trimming.
5. `attemptCount >= 0`.
6. `claimToken` and `claimExpiresAt` are both present exactly in `claimed` and `dispatching`, and both absent in every other state; a present token is non-empty.
7. A present `continuationMessageId` is non-empty; `dispatching` requires one and `waiting-result` forbids one.

Do not constrain the ID string format, `agentFrameId` by source kind, `waiting-result` attempt count, or timestamp ordering. Those are Implementation details or harmless states, not database safety invariants.

Add partial indexes owned by `prisma/sqlite-check-constraints.json`:

```sql
CREATE INDEX "BackgroundResultDelivery_project_visible_idx"
ON "BackgroundResultDelivery"("projectId", "updatedAt" DESC, "id")
WHERE "state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'needs-attention');

CREATE INDEX "BackgroundResultDelivery_recoverable_claim_idx"
ON "BackgroundResultDelivery"("claimExpiresAt", "id")
WHERE "state" IN ('claimed', 'dispatching');
```

## Module and seams

`BackgroundResultDeliveryOwner` is the external Module. Compute, Notebook, IPC, and deletion callers must not know repository claim primitives.

Its Interface consists of domain operations:

```ts
register(sourceRef)
enqueue(sourceRef)
acknowledgeObserved(sourceRef)
recover()
prepareSessionDeletion(projectId, sessionId)
commitSessionDeletion(projectId, sessionId)
abortSessionDeletion(projectId, sessionId)
prepareProjectDeletion(projectId)
commitProjectDeletion(projectId)
abortProjectDeletion(projectId)
```

Claiming, continuation preparation, dispatch transitions, attempt limits, timers, and repository operations remain private Implementation.

`BackgroundResultSourceResolver` is one internal Seam with two real Adapters:

- Notebook Adapter groups references by Session and batches exact Run lookups within the Notebook query limit.
- Compute Adapter batch-loads the referenced jobs through the existing Compute repository and its existing sensitive-data decryption path.

The resolver is one internal coordination function plus two source mappers, not a class hierarchy. It returns an in-memory source snapshot with a safe activity projection and, only for a deliverable terminal source, a transient prompt outcome. It distinguishes terminal, active/not-ready, missing, and temporarily unavailable sources. It never persists a snapshot.

The safe activity projection permits `executionType`, `title`, and `lane` to be absent when the authority is missing. The renderer falls back to `sourceKind` and `sourceId`; missing presentation data must never be backfilled into the ledger.

The existing IPC projection remains a small Adapter over the ledger and resolver. Do not create a separate `BackgroundActivityReadModel` class or table.

## Source behavior

### Compute Job

- On accepted submission, `register` creates `waiting-result`.
- A terminal notification calls `enqueue`; it transitions only an existing `waiting-result` row. Old terminal history is not enrolled.
- Direct result observation calls `acknowledgeObserved`; it may upsert a `consumed` tombstone so later replay is suppressed.
- A result is deliverable only after the authoritative terminal/harvest finalization represented by the existing Compute notification path.

### Notebook Run

- Background admission calls `register`.
- Terminal replay calls `enqueue` and may create the row as `pending`, covering admission/terminal callback races.
- Direct result observation may upsert `consumed`.
- The resolver uses the exact Run identity and optional `agentFrameId`; it does not scan unrelated workspaces.

## Delivery and recovery

The first delivery drain must wait for both Notebook and Compute authority recovery barriers. Delivery recovery may restore expired leases before those barriers, but it must not claim or resolve pending rows until both authorities are ready.

After selecting a Session batch, resolve its source records before consuming an attempt and preparing the continuation:

- terminal rows proceed to one continuation;
- active/not-ready or temporarily unavailable rows remain `pending` without incrementing `attemptCount`;
- a positively confirmed missing source or an actual dispatch failure consumes an attempt and becomes `needs-attention` after the normal maximum of three attempts;
- one unresolved source must not block resolved rows from the same claim.

Preserve the current durable continuation attribution. If a row already has a correlation after a crash, check whether that exact continuation and delivery set were saved before sending again. Mark it consumed when saved; otherwise retry with the same correlation.

Provider admission and Turn completion are separate promises. The per-Session deletion/dispatch critical section covers source preflight, Session resume, `dispatching`, and provider admission only. Turn completion is awaited outside that section so a delivery Turn can query its own result without deadlocking; deletion may cancel an admitted Turn, after which normal saved-attribution recovery decides whether to consume or retry.

Prompt text is built from transient resolver results and is never written to SQLite. Renderer projections contain no result output, ciphertext, command, remote path, or file manifest.

Remove `projectRevision = MAX(updatedAt)` and remove revision from the project activity event and snapshot. It is not monotonic. Renderer request sequencing already rejects older overlapping responses; change events are invalidations carrying only `projectId`.

## Deletion and retention

The delivery Module participates in existing Session and Project deletion protocols; it does not introduce a new durable deletion record.

Prepare establishes an in-memory target fence, cancels timers, and waits for that target's provider-admission critical section. Abort removes the fence and reschedules pending rows. Commit hard-deletes all target rows and retains the process-local fence.

For Session deletion, the outer `SessionDeletionOwner` installs the delivery fence before detaching runtime. Abort occurs only after Session authority is proven live; commit occurs after authority deletion. For Project deletion, delivery fencing joins `restoreProjectDeletion`, which is intentionally called before the durable deletion intent is created. `abortProjectDeletion` removes that fence when intent creation fails, and commit removes rows by `projectId` after authority deletion.

Startup recovery must reconcile delivery rows against a complete authoritative Session catalog before recovering claims. Rows whose target no longer exists are deleted. An incomplete or unreadable catalog must not interpret omitted Sessions as deleted. This repairs a crash after authority deletion but before delivery cleanup without creating false deletions.

Consumed rows remain while their source Session/Project exists because they are replay tombstones. Session/Project deletion hard-deletes them. There is no scheduled cleanup: row size is bounded and independent of execution output, while a TTL would permit retained Notebook Runs to be delivered again.

Update the owned-data catalog from retained history to coordinator hard-delete.

## Migration

Rewrite the unreleased migration as `0032_background_result_delivery`; do not add 0033. Update the migration manifest, checksum, verifiers, runtime schema, schema-generation inputs, and ledger smoke expectations.

The branch-local data root `/tmp/os-background-tasks` has already applied the obsolete `0032_agent_result_delivery` and currently contains 36 delivery rows. Repair it explicitly after the new migration is generated:

1. confirm no process has `/tmp/os-background-tasks/open-science.db` open for writing;
2. use SQLite `.backup` to make a timestamped, WAL-safe copy in the same directory;
3. record the obsolete row count and state distribution;
4. in `BEGIN IMMEDIATE`, drop only `AgentResultDelivery` and delete exactly the `0032_agent_result_delivery` ledger row, then commit;
5. invoke the real migration path with `npx tsx --eval`, constructing a `PrismaClient` for `file:/tmp/os-background-tasks/open-science.db?connection_limit=1` and calling `migrateApplicationDatabase(client, { databasePath: '/tmp/os-background-tasks/open-science.db' })`;
6. attach the backup read-only and insert the 36 rows into `BackgroundResultDelivery`, projecting only the final columns. Preserve state, attempts, claims, continuation correlation, and timestamps; any historical row with `dismissedAt IS NOT NULL` maps to `consumed`;
7. run `PRAGMA integrity_check`, verify the final table DDL/indexes, verify the final ledger checksum, and verify all 36 projected rows are present;
8. retain the backup and report its path. Do not delete or recreate the whole data root.

## Implementation order

1. Finalize schema, checks, indexes, 0032 migration, generated runtime schema, and migration tests.
2. Replace shared context-bearing types with source references and safe projections.
3. Implement the payload-free repository and state transitions; remove the dead dismiss repository/IPC/shared contract surface.
4. Implement the resolver and adapt Notebook/Compute event paths.
5. Update the owner to resolve on dispatch and keep recovery semantics.
6. Adapt IPC, preload, application events, stores, and current UI changes without reintroducing delivery-specific presentation complexity.
7. Integrate Session/Project deletion and update the ownership catalog.
8. Repair `/tmp/os-background-tasks` through the final migration path.
9. Run focused, schema, typecheck, and full regression tests; perform Standards and Spec reviews; fix all actionable findings; commit.

## Acceptance criteria

- SQLite rejects invalid source/state values, empty owner identity, negative attempts, half-claims, claims on non-claim states, dispatch without correlation, and waiting rows with correlation.
- Raw delivery rows never contain Compute or Notebook output or metadata payloads.
- Historical terminal Compute Jobs are not automatically enrolled.
- Admission/terminal races create one delivery obligation.
- Concurrent claimers cannot own the same row.
- Direct observation and automatic dispatch result in at most one Agent delivery.
- Every provider-admission crash point recovers through saved continuation attribution.
- Target deletion fences late callbacks and cleanup is restart-repairable.
- Project listing, Session claim, source recovery, and expired lease queries use their intended indexes at large row counts without a duplicate full recovery index.
- Existing project/session activity behavior and the current uncommitted UI simplification remain intact.
- `/tmp/os-background-tasks` passes integrity, contains the final migration/table, and preserves all 36 legacy delivery identities and states through payload-free projection.
- `npm run db:schema:check`, focused Vitest suites, `npm run typecheck:node`, `npm run typecheck:web`, and the repository test suite pass.
