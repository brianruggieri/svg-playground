# Contributing

Thanks for wanting to contribute to svg-playground! This document explains the project's workflow, commit conventions, and the local developer tooling (pre-commit hooks and staged checks) so your contributions are high-quality and easy to review.

Table of contents

- Getting started
- Local checks and hooks
- Run commands
- Commit message conventions (Conventional Commits)
- Branch & PR workflow
- Troubleshooting & bypassing hooks
- Checklist for PRs
- Code of conduct

---

## Getting started

Requirements

- Node.js: This project targets Node >= 20.17.0 (see `package.json > engines`).
- A modern Git client.

Install dependencies

```bash
# from repository root (svg-playground)
npm install
```

Prepare local Git hooks

```bash
# This is usually run once after `npm install`
npm run prepare
```

`prepare` will install local Git hooks so the pre-commit checks run automatically on every commit.

---

## Local checks and hooks

The repository uses a pre-commit hook to run staged linters/formatters automatically before committing. The workflow is:

- `pre-commit` hook (installed into `.husky/pre-commit`)
  - Runs the staged-file pipeline (configured in `package.json` under `lint-staged`):
    - For JS/TS files: `eslint --fix` and `prettier --write`
    - For JSON/Markdown/CSS/HTML: `prettier --write`

This ensures code style consistency and reduces friction during reviews.

Important npm scripts

- `npm run format` — formats repository files using Prettier.
- `npm run lint` — runs ESLint across the JS/TS sources.
- `npm run lint:fix` — runs ESLint with `--fix` to automatically apply fixable rules.
- `npm run typecheck` — runs TypeScript type checks (`tsc --noEmit`).

Recommended local workflow

1. Make changes in a feature branch.
2. Run typecheck and lint locally periodically:
   ```bash
   npm run typecheck
   npm run lint
   npm run format
   ```
3. Stage your changes and commit. The pre-commit hook will run automatically for staged files.

---

## Run commands

Useful commands from `svg-playground` root:

- Start dev server:

  ```bash
  npm run dev
  ```

- Build for production:

  ```bash
  npm run build
  ```

- Preview production build locally:

  ```bash
  npm run preview
  ```

- Format codebase (Prettier):

  ```bash
  npm run format
  ```

- Lint:

  ```bash
  npm run lint
  npm run lint:fix
  ```

- Type check:
  ```bash
  npm run typecheck
  ```

---

## Commit message conventions

We follow the Conventional Commits format to keep history readable and to support automation (releases, changelogs).

Format:

```
<type>(<scope>): <short summary>
```

Optional body (one or more paragraphs) and footer(s) (for issues, breaking changes).

- `type`: one of
  - `feat` — new feature
  - `fix` — bug fix
  - `docs` — changes to documentation
  - `style` — formatting, missing semi-colons, etc. (no code change)
  - `refactor` — code change that neither fixes a bug nor adds a feature
  - `perf` — performance improvements
  - `test` — adding or updating tests
  - `chore` — build process or auxiliary tools and libraries
  - `ci` — continuous integration related changes
  - `revert` — reverts a previous commit
- `scope` (optional): a noun describing the section of the codebase, e.g., `glow`, `audio`, `app`, `build`
- `short summary`: imperative, present tense, ≤ 72 characters recommended

Examples:

```
feat(glow): add debug panel control for extreme blur values

fix(audio): avoid NaN when audioCtx.sampleRate is missing

docs: add contributing guide and pre-commit instructions
```

If your change closes an issue, add in the footer:

```
Closes #123
```

For breaking changes, include a `BREAKING CHANGE:` line in the body or footer and describe how users should adapt.

---

## Branch & PR workflow

- Create a descriptive feature branch from `main`:
  ```bash
  git checkout -b feat/glow-controls
  ```
- Work, commit frequently with clear messages (use the Conventional Commits format).
- Push your branch and open a Pull Request (PR) against `main`.
- PRs should include:
  - A short description of what changed and why.
  - Screenshots/gifs for UI changes.
  - Any manual testing steps if applicable.
- Address review feedback and squash/fixup commits as requested by maintainers.

---

## Troubleshooting & bypassing hooks

If hooks fail locally:

- First, run the failing scripts locally to see diagnostics:
  ```bash
  npm run lint
  npm run format
  npm run typecheck
  ```
- Fix reported issues, format, re-stage and commit.

If you absolutely must bypass hooks (not recommended), you can skip them:

```bash
git commit --no-verify -m "chore: bypass pre-commit for emergency"
```

Use `--no-verify` only for exceptional cases and include a rationale in the commit message or PR.

---

## Checklist for PRs

Before requesting review:

- [ ] Code is linted and formatted (`npm run lint` and `npm run format`).
- [ ] Type checks pass (`npm run typecheck`).
- [ ] Tests (if any) pass.
- [ ] Commit messages follow the Conventional Commits format.
- [ ] PR description explains the change and includes screenshots if UI was modified.

---

## Code of conduct

By participating in this project, you agree to abide by respectful, inclusive behavior. Be considerate in code reviews and maintain a collaborative tone.

---

If you have questions about the hooks, commit style, or local setup, ping a maintainer or open an issue and label it `help wanted`. Thanks for contributing — high quality contributions make this project better for everyone!
