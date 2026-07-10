# Contributing to Open Science

Thanks for your interest in contributing! This document explains how to set up
the project, the workflow we follow, and the checks your change must pass before
it can be merged.

## Code of Conduct

Be respectful and constructive in all interactions. Assume good intent, keep
discussions focused on the technical merits, and help make this a welcoming
project for everyone.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended) and npm
- Git

### Setup

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
```

`npm install` runs a `postinstall` step that generates the Prisma client and
installs native Electron app dependencies.

### Run in development

```bash
npm run dev
```

## Project Structure

This is an Electron application built with electron-vite, React, and TypeScript.
The three process layers live under `src/`:

- `src/main/` — Electron main process (ACP runtime, session persistence,
  artifacts, notebook, projects, IPC handlers).
- `src/preload/` — preload bridge exposing a typed `window.api` to the renderer.
- `src/renderer/` — React UI (pages, stores, components).
- `src/shared/` — types and helpers shared across processes.

## Development Workflow

1. Create a branch off the default branch for your change.
2. Make your change, keeping it focused and self-contained.
3. Add or update tests that cover the behavior you changed.
4. Run the full check suite locally (see below) and make sure it passes.
5. Open a pull request with a clear description of the change and its motivation.

### Coding style

- Match the style of the surrounding code — naming, structure, and idioms.
- Formatting is handled by Prettier; run `npm run format` before committing.
- Linting is enforced by ESLint; run `npm run lint`.
- Keep user-facing strings, comments, and documentation in English.

## Required Checks

Before opening a pull request, run all of these and make sure they pass:

```bash
npm run typecheck   # TypeScript type checking (node + web)
npm run lint        # ESLint
npm run test        # Vitest unit tests
npm run format      # Prettier (writes formatting fixes)
```

Pull requests are expected to keep type checking, linting, and the test suite
green. New behavior should come with tests.

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): prefix
the subject with a type, e.g. `feat: add project sidebar filter`.

- Common types: `feat` (new feature), `fix` (bug fix), `docs`, `refactor`,
  `test`, `chore` (tooling/deps/housekeeping).
- Write the subject in imperative mood (`add`, not `added`/`adds`) and keep it
  concise; use the body to explain the *why* when it isn't obvious from the diff.
- Use `feat:` / `fix:` for user-visible changes — these are the ones that also
  need a `CHANGELOG.md` entry.

This is convention, not enforced by a hook yet; it keeps history readable and
lets us adopt automated releases later without rewriting it.

## Pull Requests

- Reference any related issue in the description.
- Describe what changed and why, and call out anything reviewers should focus on.
- Keep PRs reasonably small and scoped so they are easy to review.
- Ensure the required checks above pass.

## Reporting Issues

When filing a bug report, please include:

- What you expected to happen and what actually happened.
- Steps to reproduce.
- Your operating system and app version.
- Relevant logs or screenshots, if available.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license that covers this project.
