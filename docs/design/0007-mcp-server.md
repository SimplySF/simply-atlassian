# 0007 — MCP server on the core library

**Status:** Implemented (scaffold PR #10; in-process tools on the core library PR #18; Markdown bodies and `append` PR #21)
Supersedes the spawn-the-CLI design of PR #11, which never merged.
**Package:** `packages/simply-atlassian-mcp`, on `packages/simply-atlassian-core`
**Date:** 2026-09-08, revised 2026-09-09

## Problem

The CLI was designed with an AI agent as its dominant caller (see [0002](0002-output-conventions-first-jira-commands.md)),
but today that agent has to be one that can run shell commands, discover flags from `--help`, and
parse `--json` output itself. Agents in Claude Desktop, Cursor, and similar hosts don't get a shell;
they get [Model Context Protocol](https://modelcontextprotocol.io/) tools. Anyone wanting to give
such an agent Jira or Confluence access currently reaches for a third-party MCP server with its own
auth model, its own opinions about writes, and none of the safety layers this CLI already has.

## Decision

`@simplysf/simply-atlassian-mcp` is a stdio MCP server with **one tool per CLI command**, named
`<product>_<noun>_<verb>`, that calls **`@simplysf/simply-atlassian-core` in-process**. Each tool
handler is a few lines: build the request with the same core function the command calls, send it
with the same client, return what the command returns under `--json`. The server owns exactly
three things: the tool catalogue (names, descriptions, input schemas), the write gate, and the
mapping of a failure onto a tool result. Everything else — credential precedence, request
assembly, `dryRun` previews, the read-only guard, credential redaction, the search envelope,
mention and link-direction resolution — is the core package's, shared with the CLI by
construction rather than by re-implementation.

The server is **read-only by default**: write and destructive tools exist only when it is started
with `--allow-writes`, and even then a write is refused when the environment carries
`ATLASSIAN_READ_ONLY`, exactly as the CLI refuses it.

## Behavior

### Server

| Option              | Effect                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| (none)              | Registers the 20 read tools.                                                                                      |
| `--allow-writes`    | Also registers the 10 write and 3 destructive tools. `ATLASSIAN_READ_ONLY` in the environment still refuses each. |
| `--env-file <path>` | A `.env` file loaded once at startup. Precedence is the CLI's: environment > file. A missing file exits 2.        |
| `--help`            | Prints options and the tool list to **stderr** (stdout is the protocol stream) and exits 0.                       |

Connection settings are the CLI's environment variables (`JIRA_URL`, `JIRA_USERNAME`,
`JIRA_API_TOKEN`, `JIRA_PERSONAL_TOKEN`, `CONFLUENCE_*`). They are resolved per tool call, not at
startup, so a missing setting is reported by the tool that needed it and a server configured for
one product still serves that product. The server announces `name: simply-atlassian` and the
package version, and supplies MCP `instructions` summarising the above for the host's model.

### Tools

One per CLI command; `test/tools.test.ts` asserts the catalogue equals the CLI's
`command-snapshot.json`, so a new command cannot ship unexposed. Kinds and annotations:

| Kind          | Tools                                                                                                                                                                                                                                                                                                                                                                                                                             | Annotations                      | Extra inputs        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------- |
| `read`        | `jira_whoami`, `jira_user_search`, `jira_user_view`, `jira_open`, `jira_issue_search`, `jira_issue_view`, `jira_issue_history`, `jira_issue_transitions`, `jira_issue_comment_list`, `jira_issue_link_list`, `jira_issue_link_types`, `jira_board_list`, `jira_sprint_list`, `jira_sprint_issues`, `confluence_open`, `confluence_page_get`, `confluence_page_search`, `confluence_page_children`, `confluence_page_comment_list` | `readOnlyHint`, `idempotentHint` | —                   |
| `write`       | `jira_issue_create`, `jira_issue_update`, `jira_issue_transition`, `jira_issue_comment_add`, `jira_issue_comment_edit`, `jira_issue_link_create`, `jira_issue_link_delete`, `jira_sprint_add`, `confluence_page_create`, `confluence_page_update`, `confluence_page_comment_add`                                                                                                                                                  | neither                          | `dryRun`            |
| `destructive` | `jira_issue_delete`, `jira_issue_comment_delete`, `confluence_page_delete`                                                                                                                                                                                                                                                                                                                                                        | `destructiveHint`                | `dryRun`, `confirm` |

`destructive` is exactly the set of CLI commands that take `--confirm`. `jira_issue_link_delete`
is a write, not destructive, because the CLI does not demand `--confirm` for it; the server does
not add safety the CLI doesn't have, for the reason 0004 gives — training callers to pass `confirm`
everywhere protects nothing. By the same rule `confluence_page_delete` demands `confirm` only
with `purge: true`: trashing a page is reversible and the CLI trashes without `--confirm`.

Inputs are the command's arguments and flags in camel case, with arrays where the CLI takes a
repeatable or comma-separated flag (`labels`, `fields`, `expand`, `mentions`, `issues`) and an
object where it takes JSON (`body`). `--body-file` is not exposed: an agent has no file to point
at, and `body` covers the same need. The two `open` tools return the URL rather than launching a
browser, which a server cannot do.

### The confirm gate

A destructive call that needs consent, with neither `confirm: true` nor `dryRun: true`, is
answered with `code: "confirm-required"` **before** any lookup. The core operation would refuse
it too; gating here saves a round trip and gives the agent a message that names the input to
add. `dryRun` is exempt because previewing needs no consent.

### Results

| Outcome                    | Tool result                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| success                    | one `text` block: what the command returns under `--json`, serialised (`null` if nothing)      |
| `ConfigError`              | `isError`, `{ code: "config", name, message, exitCode: 2 }`                                    |
| `AuthError`                | `isError`, `{ code: "auth", name, message, exitCode: 3, status }`                              |
| `HttpError`                | `isError`, `{ code: "error", name, message, exitCode: 1, status, body }` with `body` sanitised |
| any other error            | `isError`, `{ code: "error", name, message, exitCode }`                                        |
| confirm missing            | `isError`, `{ code: "confirm-required", name: "ConfirmRequired", message, exitCode: 2 }`       |
| input fails the zod schema | `isError` from the SDK, nothing runs                                                           |

The error object is the CLI's `--json` stderr line, field for field, produced by the same
redaction and control-stripping: a credential from the environment never reaches the message or
the body. No `structuredContent`/`outputSchema`: the payload shape is Atlassian's and varies by
instance, so declaring a schema would either be `{}` or wrong.

## Alternatives considered

**Spawn the CLI per call (PR #11).** The first implementation, and the right call at the time:
the behaviour agents depend on lived in the command layer, and re-deriving it in a server meant
two sources of truth. [0012](0012-simply-atlassian-core.md) moved that behaviour into the core
package, which removed the reason. Spawning cost a Node process and an oclif `Config.load()` per
tool call, made the MCP package install oclif, and parsed stdout and stderr back into objects the
library already had. Its catalogue, kinds, gate, and result shape are kept here unchanged; only
`cli.ts` and the `--timeout` option went, the latter because there is no child process to kill
and the transport already deadlines each request.

**Fewer, composite tools (`jira_issue` with an `action` discriminator).** Rejected: it hides
per-command safety (which actions take `confirm`, which are read-only) behind a string, defeats
MCP tool annotations, and makes input schemas unions a host renders poorly. Thirty-three tools is
within what hosts handle; a host with a tool budget can be pointed at a read-only server.

**Generate the catalogue from `oclif.manifest.json` at runtime.** Rejected: the server no longer
depends on the CLI package at all, the manifest's flag descriptions are written for `--help`
rather than for a tool-picking model, and camel-case input names plus array/object shapes need
per-flag judgement anyway. A hand-written catalogue with a snapshot cross-check test is explicit
and cannot silently fall behind.

**Write tools always registered, with `dryRun` defaulting to true.** Rejected: a host lists every
tool to its model, and "present but previewing" still invites the model to plan writes. Absence is
the clearer signal, and `--allow-writes` is a deliberate act by the person configuring the host.

**Resolve connection settings at startup and fail fast.** Rejected: a server configured for Jira
only would refuse to start over a missing `CONFLUENCE_URL`, and the CLI's contract is that a
setting is reported by the command that needed it. `--env-file` is the one exception, because a
missing file is a configuration mistake with nothing to wait for.

**Per-call credential selection (an `envFile` input on write tools).** Deferred. The two-file
read/write arrangement from 0004 maps cleanly onto two server entries in the host config, one
read-only and one `--allow-writes`, which is also what keeps the write server's tools out of the
agent's default loop.

**Streamable HTTP transport.** Deferred; stdio is what every desktop host uses to launch a local
server, and HTTP brings its own auth story that would need its own design.

## Implementation plan

As built:

1. `src/context.ts`: `ServerOptions` and `ToolContext` — the environment (with `--env-file`
   loaded into it) and clients built from it per call.
2. `src/tools.ts`: `ToolSpec` with a typed `run(context, input)`, the `TOOLS` catalogue with zod
   schemas, descriptions, and `requiresConfirm` for the one tool whose consent rule is conditional.
3. `src/server.ts`: `selectTools`, `createServer(options)`, `invokeTool` (gate, read-only guard,
   result wrapping), `mapError` onto the CLI's error object using core's redaction.
4. `bin/run.js`: `parseArgs` for `--allow-writes`, `--env-file`, `--help` (to stderr); a startup
   failure is printed to stderr with the error's exit code.
5. `package.json`: `private` dropped; `@simplysf/simply-atlassian-core` as `workspace:^`; every
   wireit task that runs vitest depends on core's compile (the lesson of PR #17).
6. Docs: package README (options, tool tables, error codes), the docs-site guide page, root tables.

## Testing

All unit, driven through the SDK's `InMemoryTransport` with a real `Client`, against the fake
Atlassian instance from `@simplysf/simply-atlassian-core/testing` — so every case exercises the
schema validation, the serialisation, the core operation, and the HTTP request that reaches the
instance.

| Suite                 | Pins down                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/tools.test.ts`  | catalogue equals `command-snapshot.json`; unique snake-case names; write kinds carry `dryRun`, destructive carry `confirm`; the destructive set; page delete's conditional consent                                                                                                                                                                                                                                                     |
| `test/server.test.ts` | handshake metadata; read-only vs `--allow-writes` registration and annotations; exposed JSON schema; a read round trip with the bearer header; typed inputs reaching the query string; open tools; env-file loading and precedence; per-tool config errors; dry run sends nothing; a write round trip; `ATLASSIAN_READ_ONLY`; the confirm gate incl. page trash vs purge; auth and HTTP error mapping with redaction; schema rejection |

## Open questions

- **Per-call credentials** and **HTTP transport**, both deferred above; revisit on a concrete ask.
- **Docs-site coverage.** The site's command reference is generated from the CLI README; the MCP
  server has a hand-written guide page. If the tool catalogue grows a description surface worth
  publishing, generate a reference page from `TOOLS` the same way.
- **Curated text output.** Tools return the raw payload, as `--json` does. The core package now
  exposes the CLI's formatters, so a `format: "text"` input that returns the human view is a
  small addition if hosts turn out to want it.
