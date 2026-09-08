# 0007 — MCP server wrapping the CLI

**Status:** Implemented (scaffold PR #10; tools PR #11)
**Package:** `packages/simply-atlassian-mcp`
**Date:** 2026-09-08

## Problem

The CLI was designed with an AI agent as its dominant caller (see [0002](0002-output-conventions-first-jira-commands.md)),
but today that agent has to be one that can run shell commands, discover flags from `--help`, and
parse `--json` output itself. Agents in Claude Desktop, Cursor, and similar hosts don't get a shell;
they get [Model Context Protocol](https://modelcontextprotocol.io/) tools. Anyone wanting to give
such an agent Jira or Confluence access currently reaches for a third-party MCP server with its own
auth model, its own opinions about writes, and none of the safety layers this CLI already has.

## Decision

Add `@simplysf/simply-atlassian-mcp`, a stdio MCP server that exposes the CLI as tools by
**spawning the CLI itself**, one `simply atlassian … --json` process per tool call, with the CLI
package as a workspace dependency so the binary is always the matching version and never looked
up on PATH. One tool per CLI command, named `<product>_<noun>_<verb>`. The server is **read-only
by default**: write and destructive tools exist only when it is started with `--allow-writes`, and
the child CLI additionally runs with `ATLASSIAN_READ_ONLY=1` when it isn't. Tool results are the
CLI's `--json` output verbatim; failures are `isError` results carrying the CLI's own scrubbed
error and a stable code derived from its exit code.

The organising principle is that the CLI stays the single source of truth for behaviour. The
server owns exactly three things: the tool catalogue (names, descriptions, input schemas, and how
each input becomes argv), the write gate, and the result/error mapping. Everything else —
credential precedence, `--dry-run`, the read-only guard, credential redaction, exit codes, output
shape — is the CLI's, inherited by construction.

## Behavior

### Server

| Option              | Effect                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| (none)              | Registers the 12 read tools. Every CLI call runs with `ATLASSIAN_READ_ONLY=1` added to the inherited environment. |
| `--allow-writes`    | Also registers the 7 write and 2 destructive tools; the read-only variable is not added.                          |
| `--env-file <path>` | Appended to every CLI call as `--env-file <path>`. Precedence is the CLI's: flags > environment > file.           |
| `--timeout <ms>`    | Per-call ceiling; default 60 000. Overrun → SIGTERM, then SIGKILL after 2 s, reported as `code: "timeout"`.       |
| `--help`            | Prints options and the tool list to **stderr** (stdout is the protocol stream) and exits 0.                       |

The server announces `name: simply-atlassian` and the package version, and supplies MCP
`instructions` summarising the above for the host's model.

### Tools

One per CLI command; `test/tools.test.ts` asserts the catalogue equals the CLI's
`command-snapshot.json` so a new command cannot ship unexposed. Kinds and annotations:

| Kind          | Tools                                                                                                                                                                                                                                                                          | Annotations                      | Extra inputs        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------- |
| `read`        | `jira_whoami`, `jira_user_search`, `jira_user_view`, `jira_issue_search`, `jira_issue_view`, `jira_issue_transitions`, `jira_issue_comment_list`, `jira_issue_link_list`, `jira_issue_link_types`, `confluence_page_get`, `confluence_page_search`, `confluence_page_children` | `readOnlyHint`, `idempotentHint` | —                   |
| `write`       | `jira_issue_create`, `jira_issue_update`, `jira_issue_transition`, `jira_issue_comment_add`, `jira_issue_comment_edit`, `jira_issue_link_create`, `jira_issue_link_delete`                                                                                                     | neither                          | `dryRun`            |
| `destructive` | `jira_issue_delete`, `jira_issue_comment_delete`                                                                                                                                                                                                                               | `destructiveHint`                | `dryRun`, `confirm` |

`destructive` is exactly the set of CLI commands that take `--confirm`. `jira_issue_link_delete`
is a write, not destructive, because the CLI does not demand `--confirm` for it; the server does
not add safety the CLI doesn't have, for the reason 0004 gives — training callers to pass `confirm`
everywhere protects nothing.

Input mapping, implemented once in `buildArgs`:

| Input shape         | Argv                                                   | Example                                     |
| ------------------- | ------------------------------------------------------ | ------------------------------------------- |
| positional (string) | in declared order, before any flag                     | `issue: "P-1"` → `P-1`                      |
| string / number     | `--flag value`                                         | `limit: 5` → `--limit 5`                    |
| `true`              | `--flag`                                               | `byName: true` → `--by-name`                |
| `false`, negatable  | `--no-flag`                                            | `verify: false` → `--no-verify`             |
| `false`, other      | omitted                                                | `byName: false` → nothing                   |
| array, joined       | `--flag a,b`                                           | `fields: ["a","b"]` → `--fields a,b`        |
| array, repeated     | `--flag a --flag b`                                    | `labels: ["a","b"]` → `--label a --label b` |
| object              | `--flag <JSON>`                                        | `body: {…}` → `--body '{…}'`                |
| `dryRun: true`      | `--dry-run` (appended by the server, any write kind)   |                                             |
| `confirm: true`     | `--confirm` (appended by the server, destructive only) |                                             |

Every call ends with `--json` and, if configured, `--env-file <path>`. `--body-file` is not
exposed: an agent has no file to point at, and `body` covers the same need.

### The confirm gate

A destructive call with neither `confirm: true` nor `dryRun: true` is answered with
`code: "confirm-required"` **before** the CLI is spawned. The CLI would refuse it too; gating
here saves a process and gives the agent a message that names the input to add. `dryRun` is exempt
because previewing needs no consent.

### Results

| CLI outcome                | Tool result                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| exit 0                     | one `text` block: stdout trimmed, verbatim (`null` if empty)      |
| exit 2                     | `isError`, `{ code: "config", name, message, exitCode: 2 }`       |
| exit 3                     | `isError`, `{ code: "auth", name, message, exitCode: 3, status }` |
| any other exit             | `isError`, `{ code: "error", name, message, exitCode, status? }`  |
| stderr not the JSON line   | same codes; `message` is the raw stderr (or "exited with code N") |
| timeout                    | `isError`, `{ code: "timeout", message }`                         |
| spawn failure              | `isError`, `{ code: "server", message }`                          |
| input fails the zod schema | `isError` from the SDK, CLI never spawned                         |

No `structuredContent`/`outputSchema`: the payload shape is Atlassian's and varies by instance,
so declaring a schema would either be `{}` or wrong.

## Alternatives considered

**Import the CLI's library exports instead of spawning.** `@simplysf/simply-atlassian` exports
`JiraClient`, `ConfluenceClient`, config resolution, and the error classes, so an in-process server
is possible and would save the ~300 ms process start per call. Rejected: the behaviour agents
depend on — `--dry-run` request previews, the read-only guard, credential redaction, the search
envelope, `--fields` handling, mention resolution, link-direction resolution — lives in the command
layer, not the client layer. Reimplementing it means two sources of truth that drift; extracting it
first is a larger refactor of the CLI for a latency gain that doesn't matter at agent speeds.

**Fewer, composite tools (`jira_issue` with an `action` discriminator).** Rejected: it hides
per-command safety (which actions take `confirm`, which are read-only) behind a string, defeats
MCP tool annotations, and makes input schemas unions a host renders poorly. Twenty-one tools is
within what hosts handle; a host with a tool budget can be pointed at a read-only server.

**Generate the catalogue from `oclif.manifest.json` at runtime.** Rejected: the manifest is not
reachable through the CLI package's `exports`, its flag descriptions are written for `--help`
rather than for a tool-picking model, and camel-case input names plus array/object shapes need
per-flag judgement anyway. A hand-written catalogue with a snapshot cross-check test is explicit
and cannot silently fall behind.

**Write tools always registered, with `dryRun` defaulting to true.** Rejected: a host lists every
tool to its model, and "present but previewing" still invites the model to plan writes. Absence is
the clearer signal, and `--allow-writes` is a deliberate act by the person configuring the host.

**Per-call credential selection (an `envFile` input on write tools).** Deferred. The two-file
read/write arrangement from 0004 maps cleanly onto two server entries in the host config, one
read-only and one `--allow-writes`, which is also what keeps the write server's tools out of the
agent's default loop.

**Streamable HTTP transport.** Deferred; stdio is what every desktop host uses to launch a local
server, and HTTP brings its own auth story that would need its own design.

**`confirm` as a required schema property on destructive tools.** Rejected: required-and-must-be-
true has to be enforced in code anyway, and a required property invites a host UI to prefill it.
Optional in the schema, enforced by the gate, described as required.

## Implementation plan

Implemented in the order below; the scaffold (PR #10) did step 1.

1. `package.json`, `bin/run.js`, `src/index.ts`, `src/server.ts` skeleton, in-memory handshake test.
2. `src/cli.ts`: `resolveCliBin` (dependency-relative, `SIMPLY_ATLASSIAN_BIN` override), `createCliRunner`
   (spawn with `process.execPath`, closed stdin, timeout with SIGTERM/SIGKILL).
3. `src/tools.ts`: `ToolSpec`, `buildArgs`, the `TOOLS` catalogue with zod schemas and descriptions.
4. `src/server.ts`: `selectTools`, `createServer(options)` registering tools with annotations, the
   confirm gate, `mapCliError`, result mapping, `instructions`.
5. `bin/run.js`: `parseArgs` for `--allow-writes`, `--env-file`, `--timeout`, `--help` (to stderr).
6. `package.json`: drop `private`, add `@simplysf/simply-atlassian` as `workspace:^`.
7. Docs: package README (options, tool tables, error codes), a docs-site guide page, root tables.

## Testing

All unit, driven through the SDK's `InMemoryTransport` with a real `Client` unless noted.

| Suite                 | Pins down                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/tools.test.ts`  | catalogue equals `command-snapshot.json`; unique snake-case names; every mapped input exists in its schema; write kinds carry `dryRun`, destructive carry `confirm`; `buildArgs` for each input shape                           |
| `test/server.test.ts` | handshake metadata; read-only vs `--allow-writes` registration and annotations; exposed JSON schema; argv for search/env-file/dry-run/confirm; confirm gate; error mapping for exit 3, timeout, spawn failure; schema rejection |
| `test/cli.test.ts`    | **real process**: binary resolves inside the dependency; env override; exit 2 + JSON error line with no config; `ATLASSIAN_READ_ONLY` refuses a write; timeout kills a call                                                     |

The real-process suite relies on the CLI package being built first, which `pnpm run build` does
before `pnpm test` both locally and in CI.

## Open questions

- **Per-call credentials** and **HTTP transport**, both deferred above; revisit on a concrete ask.
- **Docs-site coverage.** The site's command reference is generated from the CLI README; the MCP
  server has a hand-written guide page. If the tool catalogue grows a description surface worth
  publishing, generate a reference page from `TOOLS` the same way.
