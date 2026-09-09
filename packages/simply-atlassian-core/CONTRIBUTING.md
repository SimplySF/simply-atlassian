# Contributing to @simplysf/simply-atlassian-core

Configuration, authentication, HTTP clients, and shared logic for working with Atlassian products. This package is part of the [`simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # compile + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run lint
```

## This is a library, not a CLI

There are no commands, no `command-snapshot.json`, and no `pnpm run readme` here. The public
surface is whatever [`src/index.ts`](src/index.ts) re-exports; anything not exported from there is
internal and can change freely. Adding to the public surface means adding an export to
`src/index.ts` **and** documenting it in [`README.md`](README.md)'s `## API` section — the README is
the API reference for this package. `test/index.test.ts` asserts the exported-key list; update it
deliberately when the surface changes, so an accidental removal fails loudly instead of shipping
quietly.

Both `@simplysf/simply-atlassian` (the CLI) and `@simplysf/simply-atlassian-mcp` (the MCP server)
are built on this package, and it is also meant to be installed and imported directly by scripts and
tooling that want Jira or Confluence access without shelling out to the CLI. Hold its README,
versioning, and dependency footprint to that bar: it has no runtime dependencies today, and adding
one is a design-doc decision.

## Nothing here touches a terminal or a process

The rule that decides what belongs in this package, from
[design doc 0012](https://github.com/SimplySF/simply-atlassian/blob/main/docs/design/0012-simply-atlassian-core.md):
no `@oclif/core`, no `node:child_process`, nothing reads `process.argv`, nothing writes to stdout
or stderr. `process.env` is read only through an injectable `env` parameter that defaults to it
(see `resolveJiraConfig` and `loadEnvFile`). The repo's ESLint config enforces the import side of
this; the rest is review. Anything that needs a flag, a prompt, a log line, or a spawned process
belongs in the CLI or MCP package.

## Tests

No pull request is accepted without tests covering the change. Tests live in [`test/`](test),
mirroring the `src/` layout, and run under [Vitest](https://vitest.dev/). HTTP behaviour is tested
against the tiny local server in `test/support.ts` rather than against mocks of `fetch`, so the
retry, timeout, and error-triage paths are exercised end to end.

## Reporting issues

Please [open an issue](https://github.com/SimplySF/simply-atlassian/issues) rather than sending a pull request for anything non-trivial without prior discussion.
