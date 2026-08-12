# Issue 1134: Scoped Claude Skill Resource Access

Status: implemented and verified against `origin/main` at `bdbda8041c0a8af65f7e1cb1b8ca18e9bef39179`.

Issue: [aipoch/open-science#1134](https://github.com/aipoch/open-science/issues/1134)

## Problem Verification

Claude could load an installed Skill's `SKILL.md` through its native Skill tool, but files referenced by that document were not available to the control REPL. Granting the REPL broad access to the plugin or application configuration directory would fix the immediate read failure while exposing unrelated installed Skills and application-owned data.

The verified requirement is therefore narrower: after Claude successfully loads one exact Skill through the provider-native tool, that Session may read or stage auxiliary files from the app-owned projection of that Skill. It must not gain access before the load, through a failed or synthetic event, to another Skill, or after the Session authority is cleared.

## Security Invariants

- Authority is bound to an application Session and an exact catalog Skill id.
- Only a completed Claude provider-native `Skill` result can create a grant.
- Model-controlled titles, raw input, partial results, and failed results do not grant access.
- The returned wrapper must contain exactly one app-injected id/name marker, one matching Skill wrapper name, and one canonical base directory that resolves to the expected protected projection.
- Resources are read from the protected materialized snapshot, never directly from bundled, personal, or imported source directories.
- `SKILL.md` remains the native tool's responsibility. The resource API serves auxiliary files only.
- Session replacement, context reset, specialist switch, and projector generation cleanup revoke grants.
- The control REPL cannot read protected application directories directly; access is mediated by the host service.
- Staged files are created inside the canonical workspace captured when the REPL starts, regardless of a later working-directory change.

No bearer token or reusable secret is embedded in a Skill document. The injected marker is an identity assertion whose provenance is independently checked against the canonical protected projection.

## Final Design

### Materialized Skill Identity

`src/main/skills/materializer.ts` injects an application-owned id/name marker and resource guidance into the protected Claude projection of `SKILL.md`. Codex and OpenCode keep their previous materialization behavior. Materialization also refuses source symlinks, avoids traversing projection symlinks while changing permissions, removes a projection-root symlink without following its target, and replaces unchanged targets that are not regular files.

The identity update uses a no-follow file descriptor and verifies file identity before truncating and writing. Cleanup remains limited to app-prefixed `os-*` projections, preserving unrelated user directories.

### Native Load Grant

`src/main/acp/session-update-projector.ts` observes provider updates. A grant is registered only when all of the following hold:

1. The routed framework is Claude Code.
2. The provider reports a completed native tool whose name is `Skill`.
3. The result has exactly one Skill content wrapper.
4. The wrapper name, injected id/name marker, and canonical protected base directory agree.

`src/main/skills/resource-capability.ts` stores the resulting Session-to-Skill authorization and provides targeted and generation-wide revocation. Runtime session composition and session replacement workflows call these lifecycle hooks.

### Resource Broker

`src/main/skills/host-skills-service.ts` adds two grant-gated operations:

- `resource` returns strict UTF-8 text, capped at 512 KiB.
- `stage` returns a bounded base64 payload, filename, and executable metadata. The main process does not choose or write a destination in the agent workspace.

Both operations resolve the exact catalog id and read only its protected Claude projection. Path handling rejects absolute paths, traversal, symbolic links, non-regular files, and canonical paths outside the Skill root. It opens with no-follow semantics where supported, verifies device/inode identity across lookup and open, and performs bounded reads through the verified descriptor. Installed auxiliary files are no longer reachable through the general `host.skills.read` operation.

`resources/notebook/repl_loop.js` implements the workspace side of staging. It decodes into a randomly created private directory under the startup workspace, creates the file exclusively, and preserves whether the source is executable while keeping staged permissions read-only.

### Process Boundary

The control REPL exposes native Node capabilities, so JavaScript API filtering cannot establish a complete filesystem boundary. `src/main/notebook/managed-runtime-guard.ts` therefore applies one macOS Seatbelt policy to the complete REPL process tree. The policy retains the existing managed-runtime write protection and denies reads and writes below protected application roots.

`src/main/notebook/kernel-executor.ts` supplies protected roots to this boundary. When protected roots are present, Linux and Windows fail closed because an equivalent native read sandbox is not implemented. If no protected roots are supplied, the existing runtime behavior remains unchanged. `nativeSandboxPlatform` is an explicit test seam separate from the existing simulated path/runtime platform.

## Independent Review History

Four independent security-focused code reviews shaped the implementation:

1. The initial readable-plugin-root approach was rejected because same-user permissions and Windows behavior did not provide a reliable read-only boundary, it exposed every Skill instead of the selected Skill, and symlink traversal or broad cleanup could affect data outside the projection. The approach was removed.
2. The first broker design was rejected because model-controlled update fields and replayable bearer material could grant authority; original catalog roots bypassed the intended snapshot; path lookup had time-of-check/time-of-use gaps; privileged staging selected a workspace path; executable metadata was lost; and unchanged materializations could retain a symlink. The final design uses exact native result provenance, Session grants without bearer material, protected snapshots, descriptor-based reads, payload-only staging, and hardened materialization.
3. A later review found that broker checks alone were insufficient because the Node control REPL could use other native APIs to read application configuration. It also found that an identity marker without canonical base-directory provenance could be forged or shadowed. The fix introduced the process-tree filesystem sandbox, fail-closed unsupported-platform behavior, canonical projection validation, and explicit grant revocation.
4. The final review identified one medium-priority staging issue: a mutable current working directory could redirect output after REPL startup. Staging now uses the canonical initial workspace. After that correction, the final review reported no remaining security findings.

## Verified Counterexamples

Regression tests cover the following rejected paths without relying on a single API-specific denylist:

- grants from incomplete, failed, non-native, malformed, duplicate, mismatched, or wrong-framework tool updates;
- marker content whose canonical base directory does not match the app-owned projection;
- resource access before native load, for a different Skill id, or after Session/generation cleanup;
- reads of `SKILL.md`, traversal paths, symlinked roots or descendants, oversized files, invalid UTF-8, and file replacement during open;
- direct protected-root access from the control REPL and its child processes;
- staging outside the startup workspace after changing the REPL working directory;
- materialization from symlinked sources or into symlinked/irregular projection targets; and
- cleanup that would remove unprefixed user directories.

These cases also document why JavaScript monkey-patching, filesystem permissions alone, a global readable root, and agent-chosen privileged destination paths are not acceptable substitutes for the boundary above.

## Validation

The final implementation was validated after updating the worktree to the recorded `origin/main` commit:

- `npm run typecheck:node`
- focused Vitest coverage for the projector, host service, materializer, runtime guard, kernel executor, and REPL integration: 277 passed, 11 skipped
- kernel-backed REPL integration: 48 passed
- full Vitest suite: 989 files passed, 15 skipped; 14,403 tests passed, 209 skipped
- focused ESLint and `git diff --check`

Primary tests are in:

- `src/main/acp/session-update-projector.test.ts`
- `src/main/skills/resource-capability.test.ts`
- `src/main/skills/host-skills-service.test.ts`
- `src/main/skills/materializer.test.ts`
- `src/main/notebook/managed-runtime-guard.test.ts`
- `src/main/notebook/kernel-executor.test.ts`
- `src/main/notebook/repl-loop.integration.test.ts`

## Platform Limits and Residual Risk

Protected-root control REPL access currently requires macOS Seatbelt. Linux and Windows intentionally reject that execution path until equivalent process-tree filesystem adapters exist. This is a compatibility limitation, not a silent weakening of the boundary.

The grant projector depends on the provider-native result envelope and the materialized Claude Skill format. Provider format changes should fail closed, but they can make legitimate resource loads unavailable until the parser and tests are updated. Seatbelt policy behavior also depends on the host operating system and should continue to be exercised on supported macOS release lanes.

## Suggested End-to-End Follow-up

Add a packaged-app macOS journey that installs a fixture Skill with text and executable auxiliary resources, loads it through the real Claude native Skill tool, reads and stages both resources, verifies executable metadata, and confirms revocation after context reset and specialist replacement. The same journey should verify that direct access to another Skill and protected application configuration is denied. Add Linux and Windows journeys when native sandbox adapters are implemented; until then, assert the documented fail-closed result on those platforms.
