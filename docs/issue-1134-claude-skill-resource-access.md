# Issue 1134: Claude Skill Resource Access Rollback

Status: the first implementation was rolled back after local development exposed a cross-branch
persistence problem. The resource-access feature now fails closed: the unpublished
`host.skills.resource` and `host.skills.stage` methods are not exposed, and no native Skill result
creates a resource grant.

Issue: [aipoch/open-science#1134](https://github.com/aipoch/open-science/issues/1134)

## Incident

The first implementation appended a resource capability marker and unreleased host SDK usage text to
each Claude `SKILL.md` projection. Those projections live below the shared development storage root, not
inside a git worktree. Starting `npm run dev` from the issue branch therefore changed persistent files
that a different branch reused on its next start.

The source packages were not modified. The affected files were app-owned `os-*` projections under
`<storageRoot>/claude/skills`; Codex and OpenCode projections remained free of the injected notice. On
the audited development profile, 21 Claude projections contained the marker: 19 projected bundled
Skills and 2 projected Personal Skills (`handoff` and `referral-letter-generator`). No Imported Skill
source or projection was affected.

## Root Cause

The materializer treated the persistent projection as a suitable transport for runtime-only API
documentation and identity. Its version manifest is shared by every branch using the same data root,
so another branch could regard the modified projection as current even though that branch did not
contain the host implementation described in the file.

The marker also could not be a trustworthy grant authority. It was text returned through a
provider-controlled result envelope, and the same text could appear in a source document. Canonical
base-directory checking reduced path spoofing but did not make body text an authenticated identity.

## Rollback Design

- Materialization no longer inserts the resource marker, SDK instructions, or any other #1134
  capability text into `SKILL.md`.
- The REPL no longer exposes `host.skills.resource` or `host.skills.stage`.
- Resource broker dispatch, Session grant storage, native-result grant parsing, and the associated
  process sandbox changes were removed. With no safe runtime identity channel implemented, the new
  grant-scoped `resource`/`stage` access remains unavailable rather than silently broadening
  filesystem access. Existing `host.skills.read` behavior is unchanged, including its support for
  reading auxiliary files from installed Skills.
- Ordinary materialized `SKILL.md` files are checked byte-for-byte against their catalog source even
  when the compatibility/version manifest matches. This prevents one branch from accepting bytes
  persisted by a different development build.
- A startup sync recognizes the exact legacy capability marker only in an app-owned projection. If
  its trusted source does not contain that marker, the complete `os-*` projection is rebuilt from the
  source. Bundled, Imported, and Personal source directories are never edited.
- Existing compute-specific projection text remains outside this rollback. Compute projections are
  still rebuilt when the legacy #1134 marker is detected.

## Cleanup and Recovery

Do not edit Personal or Imported source directories to remove this incident. The safe recovery target
is only an app-owned `os-*` projection. A normal startup sync with the rollback code rebuilds each
affected projection from its current catalog source and preserves the source bytes.

For a manual recovery, first stop every Open Science process and make a recoverable copy of the
affected `<storageRoot>/claude/skills/os-*` directories. Then trigger the normal catalog
materialization; do not perform a broad recursive deletion of user Skill roots. The version manifest
alone is not evidence that a projection is clean.

When testing branch-specific persistence changes, start each dev worktree with its own absolute
`OPEN_SCIENCE_STORAGE_ROOT`. The override is supported only by unpackaged builds and isolates the
config database, settings, Claude projection, and Skill catalog. Do not change `HOME` to obtain this
isolation: on macOS that can disrupt keychain lookup. A per-worktree disposable root also makes
cleanup recoverable and prevents an unreleased projection format from leaking into another branch.

## Regression Coverage

The regression suite verifies that:

- a normal Skill's materialized `SKILL.md` is byte-identical to its source;
- a legacy marker and both unreleased SDK method names are removed by a same-version startup sync;
- the trusted source is unchanged during migration;
- a projection shared by two branch runs cannot preserve SDK text from the earlier run;
- the public REPL composer exposes neither unpublished method; and
- existing path, symlink, read-only projection, host composer, projector, and kernel tests continue to
  pass after the feature rollback.

## Future Reintroduction Criteria

Resource access should not be reintroduced through persistent Skill document mutation. A future
provider integration needs a runtime-only instruction channel and authenticated identity metadata
outside model-editable document text. At minimum, grant provenance must bind a provider-native load
to a canonical direct child of the app-owned Skill root and to an application catalog identity map.
If the provider cannot supply that boundary, the correct behavior remains fail closed.
