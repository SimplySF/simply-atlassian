# Contributing

Thanks for your interest in contributing to Simply Atlassian! This document covers the repo structure, how to get set up, and how to submit changes.

1. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).
2. Create a new issue before starting significant work so we can keep track of what you're trying to add or fix, offer suggestions, and avoid duplicate effort.
3. Fork this repository.
4. [Set up your environment](#setup) and make sure you can build and test the affected package(s) locally.
5. Create a topic branch in your fork.
6. For a new command, a user-visible flag/output/error change, or a new shared module, write a design document in [`docs/design/`](docs/design/README.md) and get it agreed on before you start implementing.
7. Make your change, following the [commit message format](#commit-messages) below.
8. Write tests for your change. No pull request will be accepted without tests covering the change.
9. Open a pull request against `main`. We'll review your code, suggest any needed changes, and merge it in.

## Repository Structure

This repository is a Lerna monorepo holding the CLI package, the library package it is built on, and an MCP server package; more will be added as Atlassian
product coverage (Jira, Confluence, ...) grows. Every package has its own `CONTRIBUTING.md` covering
what's specific to it — read this file first, then that one.

| Package                                                             | Description                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`@simplysf/simply-atlassian`](packages/simply-atlassian)           | The `atlassian` CLI                                                                     |
| [`@simplysf/simply-atlassian-core`](packages/simply-atlassian-core) | Configuration, auth, HTTP clients, and shared logic the CLI and MCP server are built on |
| [`@simplysf/simply-atlassian-mcp`](packages/simply-atlassian-mcp)   | MCP server exposing the CLI to AI agents (scaffold, unpublished)                        |

Tooling:

- **Package manager:** pnpm workspaces
- **Task orchestration:** Lerna v10 (independent versioning) + Wireit (per-package build caching)
- **Language:** TypeScript (ESM)
- **CLI framework:** [oclif](https://oclif.io/)
- **Node:** ^22.13.0 || ^24.0.0 || ^26.0.0 (required by Lerna 10; the published CLI itself only requires >=22.0.0)

There's also a top-level [`site/`](site) directory — the [Astro Starlight](https://starlight.astro.build/) documentation site, deployed to GitHub Pages. It's part of the pnpm workspace (so `pnpm install` at the root sets it up too), but it's not a `packages/*` entry, so Lerna never versions, publishes, or runs `build`/`test`/`lint` scripts against it. See [Documentation Site](#documentation-site) below for how to work on it.

## Setup

This repo pins its pnpm version via the `packageManager` field in `package.json`. Use [Corepack](https://nodejs.org/api/corepack.html) (bundled with Node.js) to install that exact version rather than installing pnpm globally:

```sh
corepack enable
git clone git@github.com:SimplySF/simply-atlassian.git
cd simply-atlassian
corepack install   # installs the pnpm version pinned in package.json
pnpm install
pnpm run build
pnpm test
```

`corepack enable` only needs to be run once per machine. After that, Corepack transparently uses whatever version of pnpm is pinned in `package.json`, so every contributor and CI job runs the same version.

`pnpm install` at the root installs and links every workspace package and sets up git hooks automatically via husky.

To try your changes without installing the package globally, run its local dev binary from inside the package directory:

```sh
cd packages/simply-atlassian
./bin/dev.js --help
```

or link it so you can run `atlassian` from anywhere:

```sh
cd packages/simply-atlassian
npm link
```

## Common Commands

Run from the repo root to target all packages:

```sh
pnpm run build       # lerna run build (compile + lint)
pnpm run compile     # lerna run compile
pnpm run lint        # lerna run lint
pnpm run test        # lerna run test
pnpm run test:only   # lerna run test:only
pnpm run format      # lerna run format
pnpm run reset       # clear node_modules, the lockfile, and all wireit/TS/ESLint caches
pnpm run reset:install  # same as reset, then reinstall dependencies
```

Run inside a single package directory to target just that package:

```sh
cd packages/simply-atlassian
pnpm run build
pnpm test
```

## Adding a Dependency

To add a dependency to a specific package:

```sh
pnpm add <package> --filter @simplysf/simply-atlassian
```

To add a root-level devDependency (e.g., a shared build tool):

```sh
pnpm add -w -D <package>
```

## Documentation Site

The [docs site](https://simplysf.github.io/simply-atlassian/) lives in [`site/`](site) — an [Astro Starlight](https://starlight.astro.build/) site, deployed to GitHub Pages by `.github/workflows/docs.yml` on every push to `main` that touches `site/**` or any package's `README.md` or `package.json`.

```sh
pnpm --filter site run dev     # local preview at http://localhost:4321/simply-atlassian/
pnpm --filter site run build   # production build to site/dist, run before opening a PR that touches site/
```

Every page under `site/src/content/docs/reference/` is generated by `site/scripts/sync-command-reference.mjs` from the oclif command block in `packages/simply-atlassian/README.md` — one page per command topic, grouped by the `GROUPS` table at the top of that script. The directory is gitignored and the script runs automatically before `astro dev`/`astro build`, so nothing under `reference/` is hand-edited or committed; if a command's page is wrong, fix the command's summary/description/examples in `src/`, run `pnpm run readme` in the package, and the site follows. A new command topic (a new `simply atlassian <product> <noun>` subtree) needs a new `GROUPS` entry, placed before any entry whose prefix it extends.

Everything else under `site/src/content/docs/` is hand-authored: the landing page, Get Started, and the guides (credentials, write safety, scripting). Keep a guide in sync with the behavior it describes when you change that behavior — a guide that no longer matches `--help` is worse than no guide.

## Commit Messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint on commit). Once release automation is wired up, Lerna will use your commit types to decide which packages get versioned and how their `CHANGELOG.md` is generated — so it's worth getting right now even though nothing consumes it yet.

```text
feat: add support for X
fix: correct handling of Y
docs: update README
chore: bump a dependency
```

If your change only affects one package, scope the commit to it, e.g. `feat(simply-atlassian): add jira issue view command`.

## Pull Requests

- Keep pull requests focused on a single change where possible.
- If the change has a design document in [`docs/design/`](docs/design/README.md), update it to match what actually shipped, including its `Status` line and its row in the index. A design doc that quietly disagrees with the code is worse than none.
- Make sure `pnpm run build` and `pnpm test` pass before opening the PR. CI runs both across every package; the pre-push hook runs the same checks but scoped to packages changed since the last release tag (see [Git Hooks](#git-hooks)), so a passing push doesn't guarantee a passing PR if your branch touches a root-level config file (e.g. `tsconfig.json`, `eslint.config.mjs`) that no single package's directory reflects.
- Aim for high test coverage on new code.
- Update the relevant package's README/command docs if you changed a command's flags or behavior: run `pnpm run readme` in that package and commit the result. The docs site's command reference regenerates from that README, so this is also what keeps the site current.
- If the change affects credentials, write safety, or the `--json`/exit-code contract, update the matching hand-written guide under `site/src/content/docs/guides/` (see [Documentation Site](#documentation-site)).
- `command-snapshot.json` (used to flag accidental breaking changes to commands/flags) regenerates automatically as part of each package's `pnpm run build` — just commit whatever changes. CI re-verifies with `git diff --exit-code` after `pnpm run build`, so a stale, uncommitted snapshot fails the build.

## Versioning and Publishing

Versioning uses Lerna's independent mode — each package has its own version and can release separately. Release automation (npm publishing, GitHub releases) isn't wired up yet — this repo is still framework-only. See [`docs/design/`](docs/design/README.md) for where that's expected to be designed before it's built.

## CI

| Workflow   | Trigger                                                                                  | What it does                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `test.yml` | Push to non-main branches                                                                | Runs `pnpm run build` + `pnpm test` on Linux (lts/_, lts/-1) and Windows (lts/_)              |
| `docs.yml` | Push/PR touching `site/**` or a package's `README.md`/`package.json`, or manual dispatch | Builds the docs site, checks for broken internal links, and deploys to GitHub Pages on `main` |

## Git Hooks

| Hook         | Command                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` — runs `prettier --write` on staged files                                       |
| `commit-msg` | `commitlint` — enforces conventional commit format                                            |
| `pre-push`   | `lerna run build --since --include-dependents && lerna run test --since --include-dependents` |

`pre-push` only builds/tests packages changed since the last release tag (plus their transitive
dependents) to keep the hook fast locally — CI (`test.yml`) always runs `pnpm run build` + `pnpm test`
across every package, so nothing changed here reduces what actually gates a merge.

Hooks are installed automatically on `pnpm install` via the `prepare: husky` script.

## Reporting Issues

Please report bugs or request features by [opening an issue](https://github.com/SimplySF/simply-atlassian/issues) rather than submitting a PR without prior discussion for anything non-trivial.
