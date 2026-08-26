# Figure Skills Manual Acceptance Checklist

Use this short checklist on a packaged or development build after automated checks pass.

- [ ] Open **Skills** and **Settings**. Confirm `figure-style`, `figure-composer`, and
      `paper-narrative` are visible as built-in helpers with no duplicate or stale entries.
- [ ] In a Notebook, run `figure-style`. Confirm the result visibly applies the requested styling
      and produces a usable figure artifact.
- [ ] Run `figure-composer` with multiple figure inputs. Confirm each input has an independent panel
      and the combined output is rendered correctly.
- [ ] Request a revision to one composer panel. Confirm only the targeted panel changes and the
      other panels remain stable.
- [ ] Run `paper-narrative`. Confirm the Notebook shows a coherent narrative based on the selected
      figures rather than unrelated or placeholder content.
- [ ] Open the produced Artifact's provenance details. Confirm inputs, producer, helper identity,
      source evidence, and supporting-code evidence are visible and correspond to the execution.
- [ ] Reconstruct the artifact in a fresh session. Confirm replay succeeds and its PNG is visually
      equivalent to the original; after restarting or starting a new epoch, confirm a new helper
      generation is used without reusing stale initialization.
- [ ] Exercise a missing Python dependency. Confirm the app reports which dependency is unavailable
      and gives safe installation or recovery guidance without exposing an unsafe command or stack.
