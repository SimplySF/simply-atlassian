# 0007 — MCP server wrapping the CLI

**Status:** Draft
**Package:** `packages/simply-atlassian-mcp` (new)
**Date:** 2026-09-08

## Problem

The CLI was designed with an AI agent as its dominant caller (see [0002](0002-output-conventions-first-jira-commands.md)),
but today that agent has to be one that can run shell commands, discover flags from `--help`, and
parse `--json` output itself. Agents in Claude Desktop, Cursor, and similar hosts don't get a shell;
they get [Model Context Protocol](https://modelcontextprotocol.io/) tools. Anyone wanting to give
such an agent Jira or Confluence access currently reaches for a third-party MCP server with its own
auth model, its own opinions about writes, and none of the safety layers this CLI already has.

## Decision

_To be agreed._ Add `@simplysf/simply-atlassian-mcp`, a stdio MCP server in this monorepo that
exposes the CLI's capabilities as MCP tools, reusing the CLI's configuration, clients, error
mapping, and write-safety behavior rather than reimplementing them. The package is scaffolded
(builds, lints, tests, announces itself over stdio) with no tools registered; everything below is
what this doc has to settle before the first tool lands.

## Behavior

_To be written once the open questions are decided._

## Alternatives considered

_To be written._ At minimum this section should record the decision on each open question below
and what was rejected.

## Implementation plan

_To be written._

## Testing

_To be written._ The scaffold establishes the pattern: drive the server through the SDK's
`InMemoryTransport` with a real `Client` so tests cover schema validation and serialization, not
just handler bodies.

## Open questions

1. **Wrap the binary or import the library?** The package name says "wraps the CLI", and the CLI
   package already exports its config resolution, `JiraClient`, `ConfluenceClient`, and error
   classes from `src/index.ts`. Spawning `simply atlassian … --json` per tool call gives exact
   behavioral parity (including `--dry-run`, `ATLASSIAN_READ_ONLY`, credential scrubbing, exit
   codes) at the cost of a process per call and a dependency on the binary being installed.
   Importing the library is faster and type-safe but means re-deriving the command layer's
   behavior (flag defaults, output curation, write guards) in a second place, or extracting it into
   a shared module first. _[0012](0012-simply-atlassian-core.md) does that extraction: the client
   layer moved to `@simplysf/simply-atlassian-core` in its phase 1, and the command layer follows
   in phase 2 so this server can import rather than spawn._
2. **Tool granularity.** One tool per CLI command (21 today) mirrors the CLI exactly and keeps
   `--help` text reusable as tool descriptions, but is a large tool list for a host to present. A
   smaller set of composite tools (`jira_issue` with an `action` argument) is friendlier to hosts
   with tool-count limits but hides the CLI's per-command safety flags behind a discriminator.
3. **Credentials.** The CLI takes flags, environment, or `-e/--env-file`. An MCP server is
   launched by the host with an environment block, so env-only is the natural minimum. Whether to
   also accept an env-file path as a server argument, and whether a tool call may name a
   _different_ credential file (the two-file read/write arrangement from the write-safety guide),
   decides how a person, rather than the agent, authorizes writes.
4. **Write safety in an MCP shape.** `--dry-run` and `--confirm` are flags on individual commands;
   `ATLASSIAN_READ_ONLY` is an env var. Options: a server-level read-only mode that simply doesn't
   register write tools; write tools that require an explicit `confirm: true` argument; a
   `dryRun` argument on every write tool; some combination. MCP tool annotations
   (`readOnlyHint`, `destructiveHint`) should be set either way.
5. **Output shape.** `--json` is the raw API payload, which is large. Tools can return the raw
   payload as text, a curated subset (the CLI's human view has already chosen one), or both via
   structured content. The `--fields` knob matters here for the same token reasons it does in
   the CLI.
6. **Error mapping.** The CLI's exit codes (2 config, 3 auth, 1 other) need an MCP equivalent —
   probably `isError: true` results with the CLI's scrubbed message, plus a stable machine-readable
   code in structured content.
7. **Transport.** Stdio only for the first version, or also Streamable HTTP for a shared,
   long-running deployment? HTTP brings auth of its own and is a different product; stdio is the
   scaffold's default.
8. **Publishing.** The scaffold is `private: true` with version `0.0.0`. Flipping that is part of
   whichever PR ships the first usable tool set, and the docs site should gain a page for the
   server at the same time.
