# Contributing to @simplysf/simply-atlassian-mcp

Model Context Protocol server wrapping the `simply-atlassian` CLI. This package is part of the [`simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # compile + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run lint
```

## This is an MCP server, not a CLI plugin

There is no oclif here: no commands, no `command-snapshot.json`, no `pnpm run readme`. The
package's public surface is the set of MCP tools the server registers (see `src/server.ts`), plus
the small programmatic API in `src/index.ts`. Adding, renaming, or changing the input schema of a
tool is a user-visible change and needs a design doc per the root `CLAUDE.md`.

## Stdout is the protocol

Over stdio, the MCP transport owns stdout. Nothing under `src/` may write to it — no `console.log`,
no stray `process.stdout.write` — or the client sees a corrupted stream. The repo's `no-console`
lint rule catches the obvious cases; diagnostics that must be emitted go to stderr.

## Trying the server locally

Build it, then drive it with the MCP Inspector, which launches the binary over stdio and gives you a
UI to list and call tools:

```sh
pnpm run compile
npx @modelcontextprotocol/inspector node ./bin/run.js
```

Connection settings are the same environment variables the CLI reads (`JIRA_URL`,
`JIRA_USERNAME`, `JIRA_API_TOKEN`, and so on); export them before launching the inspector.

## Tests

No pull request is accepted without tests covering the change. Tests live in [`test/`](test),
mirroring the `src/` layout, and run under [Vitest](https://vitest.dev/). Drive the server through
the SDK's `InMemoryTransport` with a real `Client`, as `test/server.test.ts` does, rather than
calling handler functions directly — that exercises the same schema validation and serialization a
real client hits.

## Reporting issues

Please [open an issue](https://github.com/SimplySF/simply-atlassian/issues) rather than sending a pull request for anything non-trivial without prior discussion.
