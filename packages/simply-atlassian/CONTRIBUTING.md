# Contributing to @simplysf/simply-atlassian

Command-line interface for working with Atlassian products. This package is part of the [`simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # compile + lint + regenerate command-snapshot.json
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run lint
```

## Trying a command locally

Run this package's dev binary without installing it:

```sh
./bin/dev.js --help          # macOS/Linux
./bin/dev.cmd --help         # Windows
```

Or link it so `atlassian` picks it up from anywhere:

```sh
npm link
```

## Command help text

Summaries, descriptions, and examples currently live as static properties on the command class
itself (see `src/commands/hello/world.ts`) — there's no externalized `messages/*.md` convention wired
up yet (see the note in the root `CLAUDE.md`). After adding or changing a command, regenerate the
README command reference:

```sh
pnpm run readme
```

Commit the regenerated `README.md`.

## Command snapshot

`command-snapshot.json` records every command and flag so that accidental breaking changes surface in review. It regenerates as part of `pnpm run build` — commit whatever changes. CI re-verifies with `git diff --exit-code`, so a stale snapshot fails the build.

## Tests

No pull request is accepted without tests covering the change. Tests live in [`test/`](test), mirroring the `src/` layout, and run under [Vitest](https://vitest.dev/).

## Reporting issues

Please [open an issue](https://github.com/SimplySF/simply-atlassian/issues) rather than sending a pull request for anything non-trivial without prior discussion.
