# Independent Code Review — Specialist Contribution Channels

## Review Target

- Branch: `codex/specialist-contribution-channels`
- Base SHA: `b414b6db0ed3db45708b4cc5e44d5499e8cc1fb2`
- Base tree: `233ce0a72332ae2b63dbbe95207e444838ad5838`
- Candidate SHA: `fc42e53f68b3c9663df4347503a45681a63e5d99`
- Candidate tree: `3fc300fb3a2565c4cb90b92e896ce9d7eec58b11`
- Diff: 72 files, 9,467 insertions, 108 deletions
- Dependency audit: `NOT APPLICABLE: dependency inputs unchanged`

## Executive Summary

The candidate has strong ZIP hardening, structured diagnostics, recovery journaling, renderer-safe package previews, and extensive automated coverage. However, four P1 correctness/atomicity defects remain:

- A package transaction can silently erase an unrelated concurrent Specialist mutation.
- Package Skill installation is not serialized with ordinary Skill imports/deletes.
- Imported profiles bypass protected-name and uniqueness invariants.
- Builtin compatibility identities are coupled to the application version, breaking valid cross-version imports.

Three P2 issues affect import validation, versioned export usability, and renderer path isolation.

| Priority | Count |
|---|---:|
| P0 | 0 |
| P1 | 4 |
| P2 | 3 |
| P3 | 0 |

## Findings

### [P1] Blind document replacement can erase concurrent Specialist changes

Classification: Actionable

Locations:

- `src/main/specialist/package/transaction.ts:120-194`
- `src/main/specialist/package/transaction.ts:205-218`
- `src/main/specialist/repository.ts:300-317`

Impact:

A package install or rollback can silently lose a concurrent create, update, enable/disable, or delete performed through `ProfileService`.

Evidence:

The transaction reads a complete document snapshot at `transaction.ts:122`, constructs `after` from that snapshot, performs asynchronous Skill preparation and journal writes, then commits using `repository.replaceAll(after)`. `replaceAll()` blindly writes the precomputed document. The repository queue serializes the physical writes, but it does not keep the original read and subsequent replacement in one critical section.

Concrete failure scenario:

1. Package install reads Specialist document A.
2. Installation pauses in `skillPort.prepare()`.
3. A Settings or SDK request updates unrelated Specialist B and commits successfully.
4. Package install calls `replaceAll(after)`, where `after` was derived from document A.
5. B's committed change disappears.

The rollback path has the same failure mode because it unconditionally restores `before`. Existing guards do not catch this: the revision check covers only the package target before the asynchronous gap, and `SpecialistPackageTransaction.queue` serializes only package transactions.

Recommended fix:

Expose an owner-level repository transaction/CAS Interface that holds the same mutation lock across read, validation, and commit. Check the document digest or generation immediately before commit and abort on any intervening mutation. Rollback must also be conditional so it cannot overwrite newer unrelated state.

Add barrier-controlled tests that perform a concurrent `ProfileService.create()` and `update()` while package Skill preparation is paused and assert that the package operation either preserves them or fails without changing durable state.

---

### [P1] Package Skill commits race with ordinary Skill imports and deletions

Classification: Actionable

Locations:

- `src/main/specialist/package/service.ts:616-629`
- `src/main/specialist/package/transaction.ts:182-189`
- `src/main/skills/specialist-package-adapter.ts:185-238`
- `src/main/skills/specialist-package-adapter.ts:296-325`
- `src/main/settings/service.ts:539-541`
- `src/main/skills/user-skill-repository.ts:356-367`
- `src/main/skills/user-skill-repository.ts:541-554`

Impact:

A concurrent Settings Skill operation can leave an installed Specialist with a missing dependency or allow a package to silently overwrite a conflicting standalone Skill.

Evidence:

Package installation revalidates a catalog snapshot before entering the transaction, but the package adapter does not participate in `UserSkillRepository`'s private mutation lock. The transaction also excludes `reuse-standalone` dependencies from `skillPort.prepare()`.

The package adapter's commit blindly moves any existing live directory to backup and replaces it.

Concrete failure scenarios:

- A `reuse-standalone` dependency is present during validation. Direct deletion passes its guard before the new Specialist is durable, deletes the Skill, and package installation then commits a Specialist referencing the missing ID.
- Validation sees a Skill ID as absent. A normal import creates that ID with different content before package commit. The package adapter backs it up and installs its staged version, bypassing the declared same-ID conflict rule.

The direct-deletion guard is outside the Skill repository's exclusive section, and the future Specialist reference is invisible while that guard runs.

Recommended fix:

Provide one Skill-owner mutation Interface shared by package and ordinary operations. Hold its reservation/lock from live disposition revalidation through commit, and make deletion guard plus deletion atomic. Revalidate ID, version, content digest, ownership, and all `reuse-standalone` dependencies immediately before durable Specialist commit.

Add controlled concurrency tests covering ordinary ZIP/GitHub import and direct deletion during package prepare/commit.

---

### [P1] Package imports bypass Specialist name and protected-identity invariants

Classification: Actionable

Locations:

- `src/main/specialist/package/validator.ts:363-385`
- `src/main/specialist/package/transaction.ts:132-172`
- `src/main/specialist/repository.ts:224-235`
- `src/main/specialist/service.ts:219-226`
- `src/main/specialist/service.ts:253-259`

Impact:

An imported package can create duplicate custom names or use a builtin/Reviewer name. Name-based runtime resolution checks custom profiles first, allowing an imported custom profile to shadow a readonly builtin identity.

Evidence:

Package validation accepts any non-empty trimmed string. Installation constructs a `StoredSpecialist` directly and calls `replaceAll()`, bypassing:

- `ProfileService.assertCreatableName()`, which rejects Reviewer and builtin names.
- `SpecialistRepository.insert()`, which rejects duplicate names.
- The shared public-name validator.

The package catalog contains protected Specialist IDs but no protected or existing names.

Concrete failure scenario:

A ZIP uses a new custom ID but gives the payload the exact name of a builtin Specialist. Import succeeds. `resolveRunnableByName()` returns the custom profile before searching builtins, so name-based session or SDK behavior selects the attacker-controlled imported profile.

Recommended fix:

Extend the validation snapshot with normalized existing and protected names, and run the same shared name rules during preview and again under the repository commit lock. Reject case-normalized builtin/Reviewer collisions and duplicate custom names.

Add import tests for duplicate custom names, case variants of Reviewer, builtin-name collisions, invalid public characters, and resolution after rejected imports.

---

### [P1] Builtin compatibility identities change with every application release

Classification: Actionable

Locations:

- `src/main/ipc.ts:519-527`
- `src/main/ipc.ts:547-555`
- `src/main/specialist/package/service.ts:461-467`
- `src/main/specialist/package/validator.ts:768-785`

Impact:

A package exported by one compatible application version cannot be imported by another application version, even when its declared `requires_app` range is satisfied and the builtin Skill is unchanged.

Evidence:

Production composition assigns each builtin `compatibility: app:${appVersion}:${skill.id}`. Export stores that string, while import requires exact equality. Therefore an export from `0.9.2` records `app:0.9.2:reader`; application `0.9.3` produces `app:0.9.3:reader` and rejects it.

The validator's unit test correctly demonstrates cross-version compatibility with a stable `sha256:stable` identity, but production and release-certification fixtures use the app-version-coupled form.

Recommended fix:

Derive compatibility from stable builtin Skill content, a declared Skill version, or a canonical resource digest. Keep `app_version` as provenance only. Add a production-composition test exporting at one application version and importing at a different version inside the allowed range, plus a changed-content rejection test.

---

### [P2] Imported profile fields bypass the shared size and public-name limits

Classification: Actionable

Locations:

- `src/main/specialist/package/validator.ts:363-438`
- `src/shared/specialist.ts:306-309`
- `src/shared/specialist.ts:381-410`
- `src/shared/specialist-package.ts:18-24`
- `src/main/specialist/service.ts:119-140`
- `src/renderer/src/pages/settings/SpecialistEditor.tsx:106-121`

Impact:

An untrusted ZIP may install a profile with a system prompt approaching the 25 MB per-file archive limit, despite the normal 32,768-character domain limit. Every Settings listing then transfers that prompt over IPC, and opening the editor copies it into React state, causing avoidable memory pressure, UI stalls, or renderer termination.

Evidence:

The package validator checks only that description and system prompt are strings. It does not apply the shared limits:

- Name: 80
- Display name: 80
- Description: 200
- System prompt: 32,768

Repository sanitization also preserves arbitrary string lengths.

Recommended fix:

Apply the shared Specialist field validators during package validation, including public-name and display-name checks. Add explicit bounded validation for capability arrays and pattern fields. Add tests at each maximum and one character beyond, plus a large-but-archive-valid payload rejection test.

---

### [P2] Users cannot explicitly change a custom Specialist's package version

Classification: Actionable

Locations:

- `src/shared/specialist.ts:267-280`
- `src/main/specialist/service.ts:364-390`
- `src/renderer/src/pages/settings/SpecialistEditor.tsx:38-53`
- `src/renderer/src/pages/settings/SpecialistEditor.tsx:340-399`
- `src/renderer/src/pages/settings/SpecialistEditor.tsx:488-497`
- `src/main/specialist/package/service.ts:389-398`
- `src/main/specialist/package/service.ts:505-518`

Acceptance evidence:

- `.scratch/specialist-contribution-channels/design.md:74-75`
- `.scratch/specialist-contribution-channels/PRD.md:132`

Impact:

After editing imported or local content, export warns that content changed without a version bump, but the application provides no supported way to perform that bump. Subsequent exports keep the same manifest version and filename indefinitely.

Evidence:

`UpdateSpecialistInput`, the service update patch, and editor `FormState` contain no `packageVersion`. The editor displays the imported version as read-only provenance. Export always uses the stored unchanged version.

Recommended fix:

Add an editable SemVer package-version field for custom Specialists while keeping the immutable ID read-only. Validate it in the shared boundary and main service, persist it through optimistic concurrency, and test the journey from unchanged-version warning to explicit bump and updated manifest/filename.

---

### [P2] Saving a diagnostics report exposes an absolute filesystem path to the renderer

Classification: Actionable

Locations:

- `src/shared/specialist-package.ts:30-32`
- `src/main/specialist/package/electron-adapter.ts:64-77`
- `src/main/specialist/ipc.ts:207-214`

Impact:

The renderer receives the absolute save destination, exposing user directory names and filesystem topology without a functional need. This contradicts the feature's main-owned file-dialog boundary; the UI only consumes whether saving succeeded.

Evidence:

`saveSpecialistPackageReport()` returns `{ saved: true, filePath: selected.filePath }`, and the IPC handler forwards that result unchanged. Template and package export results already use the safer `{ saved: boolean }` contract.

Recommended fix:

Change `SpecialistPackageReportSaveResult` to `{ saved: boolean }`, retain the selected path exclusively in main, and update tests to assert that no path crosses IPC.

## Verification Evidence

Passed:

- `npm test -- --exclude '.scratch/**'`
  - 706 test files passed, 15 skipped
  - 10,314 tests passed, 190 skipped
- `npm run typecheck`
  - Node and web TypeScript checks passed
- ESLint over every changed `.ts` and `.tsx` file
  - Passed
- Focused Specialist package/IPC/renderer/build suite
  - 16 files, 291 tests passed

Tests and contracts inspected included:

- `src/main/specialist/package/validator.test.ts`
- `src/main/specialist/package/service.test.ts`
- `src/main/specialist/package/release-certification.test.ts`
- `src/main/specialist/package/adapters.test.ts`
- `src/main/specialist/package/electron-adapter.test.ts`
- `src/main/skills/specialist-package-adapter.test.ts`
- `src/main/specialist/builtin-registry.test.ts`
- `src/main/specialist/service.test.ts`
- `src/main/specialist/ipc.test.ts`
- `src/renderer/src/stores/specialist-store.test.ts`
- `src/renderer/src/pages/settings/SpecialistsPanel.render.test.tsx`
- `src/preload/index.test.ts`
- `src/build/packaging.test.ts`
- Design, PRD, prototype approval, and issues 01–12 acceptance documents

## Residual Risks

- The live sprint workspace contains ignored `.scratch/**/worktrees` with copied tests and dependency trees. Plain Vitest discovery enters those copies because `vitest.config.ts` excludes `.worktree/**` and `.worktrees/**`, but not `.scratch/**`. Candidate-owned tests pass when that session-artifact directory is excluded; the exact unmodified `npm test` command should be confirmed in a clean checkout.
- This review did not run packaged Electron save-dialog journeys or platform-specific ZIP tests on Windows.
- Builtin runtime behavior is exercised with fixtures; there is currently no shipped builtin Specialist contribution providing an end-to-end packaged-resource specimen.

## Final Verdict

**FAIL**

Four actionable P1 findings affect durability, dependency atomicity, protected identity, and cross-version package compatibility. The candidate should not be finalized until those issues are corrected and independently reverified.
