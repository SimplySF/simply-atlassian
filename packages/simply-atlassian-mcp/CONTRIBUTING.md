# Contributing to @simplysf/simply-atlassian-mcp

Model Context Protocol server exposing Jira and Confluence to AI agents, built on `@simplysf/simply-atlassian-core`. This package is part of the [`simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # compile + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run lint
```

Every task that runs vitest first compiles `../simply-atlassian-core`, because the server resolves
that package through its compiled `lib/`.

## This is an MCP server, not a CLI plugin

There is no oclif here: no commands, no `command-snapshot.json`, no `pnpm run readme`. The
package's public surface is the set of MCP tools the server registers (see `src/tools.ts`), plus
the small programmatic API in `src/index.ts`. Adding, renaming, or changing the input schema of a
tool is a user-visible change and needs a design doc per the root `AGENTS.md`.

## One tool per CLI command, with no logic of its own

`test/tools.test.ts` asserts that the catalogue matches the CLI package's `command-snapshot.json`
exactly, so a command added to the CLI fails this package's tests until it has a tool. When you
add one, the handler should be a few lines that call the same core functions the command calls
(request building, dry-run, deletes with their consent checks) and return what the command
returns under `--json`. If you find yourself writing logic in a handler that the command also has,
move it into `@simplysf/simply-atlassian-core` and call it from both — that is the whole point of
[design doc 0012](https://github.com/SimplySF/simply-atlassian/blob/main/docs/design/0012-simply-atlassian-core.md).

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
`JIRA_USERNAME`, `JIRA_API_TOKEN`, and so on); export them before launching the inspector, or pass
`--env-file`.

## Tests

No pull request is accepted without tests covering the change. Tests live in [`test/`](test),
mirroring the `src/` layout, and run under [Vitest](https://vitest.dev/). Drive the server through
the SDK's `InMemoryTransport` with a real `Client`, against the fake Atlassian instance from
`@simplysf/simply-atlassian-core/testing`, as `test/server.test.ts` does — that exercises the
schema validation, serialisation, core operation, and HTTP request a real call makes, rather than
a handler body in isolation.

## Reporting issues

Please [open an issue](https://github.com/SimplySF/simply-atlassian/issues) rather than sending a pull request for anything non-trivial without prior discussion.
