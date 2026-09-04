# 0002 — Output conventions and first Jira read commands

**Status:** Implemented (PR #3)
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-03

## Problem

The client core (0001) can talk to Jira, but the CLI still only says hello. Users can't verify
their credentials, look at an issue, or run a search. And before _any_ command ships, the repo
needs a decision every later command inherits: how output works — because retrofitting output
conventions across a grown command surface is exactly the kind of churn design docs exist to
prevent.

## Decision

Three read-only commands — `atlassian jira whoami`, `atlassian jira issue view`,
`atlassian jira issue search` — built on two small shared modules: a `JiraCommand` base class
(connection flags, config resolution, error mapping) and an output helper (key-value and table
rendering). JSON output uses oclif's native `--json` support (`enableJsonFlag`): each command's
`run()` returns the raw API payload, oclif prints it verbatim when `--json` is passed, and the
human-friendly rendering only happens otherwise.

## Behavior

### Shared connection flags (every Jira command)

| Flag                      | Env fallback          | Notes                                                |
| ------------------------- | --------------------- | ---------------------------------------------------- |
| `-e`, `--env-file <path>` | —                     | Loads credentials from a `.env` file before anything |
| `--jira-url`              | `JIRA_URL`            | Base URL of the instance                             |
| `--jira-username`         | `JIRA_USERNAME`       | Cloud only                                           |
| `--jira-api-token`        | `JIRA_API_TOKEN`      | Cloud only                                           |
| `--jira-personal-token`   | `JIRA_PERSONAL_TOKEN` | Server/DC only                                       |

There is no TLS-verification opt-out: 0001 removed it, and an instance behind an internal CA is
served by `NODE_EXTRA_CA_CERTS` instead.

Flags beat env (already the 0001 contract). Passing secrets as flags works but the README
documents env vars as the recommended path — flags land in shell history.

**`--env-file` is how the tool is actually driven in practice**, so it is a first-class global
flag rather than a convenience: credentials live in a `.env` file and every invocation names it
(`atlassian -e .env jira issue search ...`), matching the muscle memory and agent command
templates already in use with the previous tooling. Resolution order is therefore explicit
flags, then the real environment, then the `--env-file` contents — the file never clobbers a
variable already set in the environment. A file named explicitly but missing or unreadable is a
`ConfigError`, not a silent skip: an agent that mistypes the path must be told, not left
wondering why its credentials vanished.

**Only Atlassian connection variables are applied from the file** (`JIRA_*` and `CONFLUENCE_*`
URL, username, API token, personal token, and `SSL_VERIFY`); every other entry is ignored. The
user chooses the path, but the file's contents may come from a repository, a shared drive, or
an agent — so an unrestricted loader would let a file that nobody audited set
`NODE_TLS_REJECT_UNAUTHORIZED=0` and silently undo the certificate verification 0001
guarantees, handing the token to whoever answered. `*_SSL_VERIFY` stays on the list so that
setting it still produces 0001's explanatory error rather than silence.

### Output contract

- **Default:** human-friendly. Single entities render as aligned key-value lines; lists render
  as compact tables (key, status, assignee, summary). Only a curated subset of fields is shown.
- **`--json`:** the raw, unmodified API payload — the full response, not the curated subset —
  so the CLI is scriptable with `jq` from day one. Provided by oclif's `enableJsonFlag`, which
  also suppresses `this.log` noise automatically.
  - **The one exception is any command that follows pages.** `jira issue search` makes several
    requests, so there is no single response to hand back; it returns an envelope instead:
    `{ issues, total?, pages, complete }`. `issues` holds the raw issue objects exactly as the
    instance returned them — the passthrough guarantee applies to the elements, not the
    wrapper. `complete: false` means the caller's `--limit` cut the results short, which a
    caller must be able to detect without counting rows. `total` is present only when the
    instance reports one (Server/DC does; Cloud's `/search/jql` does not).
- **Errors:** `CliError` subclasses map to stable exit codes — config 2, auth 3, everything
  else 1 — with no stack trace. Under `--json` the failure is written as one JSON object on
  **stderr**, and stdout stays empty.

  The base command must intercept _every_ error, not only its own: oclif's default `--json`
  error path serializes its whole parse context, including the raw argv, to stdout — so a run
  that fails before the command body executes would print the value of `--jira-api-token` to
  the stream the calling agent captures. Error messages are additionally scrubbed of any known
  credential value and of terminal control characters before being emitted.

### Untrusted text

Issue summaries, descriptions, and display names are chosen by whoever filed the ticket or
named their account — a low-privilege position on a shared instance — and this CLI prints them
to a terminal and into an agent's context. Human-mode rendering therefore strips C0/C1 control
characters (ESC, BEL, backspace) from every server-supplied string, including error text
quoting a response body. Without that, an escape sequence in a summary can erase or overwrite
lines already printed, so the table on screen shows a different status or assignee than the API
actually returned. The `--json` path needs no such handling, since `JSON.stringify` escapes
control characters itself.

Natural-language injection ("ignore your previous instructions…" inside a summary) is not
solvable by escaping and is inherent to showing ticket text to an agent; the mitigation belongs
in how the agent frames the data, not here.

### Agent consumption (a first-class requirement)

The CLI's dominant real-world caller is an AI agent running it as shell commands, so:

- **Every command supports `--json`, no exceptions**, and its payload shape is treated as a
  public contract (raw API passthrough keeps that contract Atlassian's, not ours).
- **Never interactive.** No prompts, no confirmations that block on stdin — a destructive
  command that wants a safety check takes an explicit flag (designed in its own doc), because
  a hung prompt is a hung agent.
- **Errors are machine-readable**: with `--json`, oclif emits the error as JSON on stderr;
  exit codes are stable (2 config / 3 auth / 1 other) so an agent can branch without parsing
  prose.
- **`--fields` matters more than it looks**: raw Jira issue payloads are enormous, and agents
  pay for output tokens. Field selection is the knob that keeps responses small.
- **Help is discovery.** Agents read `--help`; oclif generates it from the command classes, so
  summaries, flag descriptions, and examples are written to be self-sufficient.

### Commands

**`atlassian jira whoami`** — calls `GET /myself`; prints display name, account/user ID, and
email. The cheapest possible check that URL + credentials + network all work.

**`atlassian jira issue view <issue-key>`** — one issue. Flags: `--fields <csv>` (curated
default), `--expand <csv>`. Human output: key, summary, status, type, assignee, reporter,
created/updated, description (plain text).

**`atlassian jira issue search`** — flags: `--jql <query>` (required), `--limit <n>` (total
issues to fetch, default 50; the command follows `nextPageToken`/`startAt` pages internally
until the limit or the last page), `--fields <csv>`. Human output: table of key, status,
assignee, summary, plus a `Showing N of M` footer when the instance reports a total.

## Alternatives considered

- **A custom `--format json|table|markdown` flag** (what `kaichen/atlassian-cli` does) — more
  modes up front, but it fights oclif's built-in `--json` convention (which SimplySF users
  already know from the Salesforce CLIs) and drags markdown rendering into scope before
  Confluence needs it. Markdown gets designed where it earns its keep (the Confluence page doc).
- **Curated JSON output** (reshaping the payload) — friendlier-looking, but it turns every
  Atlassian schema change into our breaking change, and scripts lose access to fields we didn't
  anticipate. Raw payload is the stable contract.
- **`@oclif/table` for list rendering** — attractive, but it pulls in ink/React at runtime.
  A ~40-line column formatter covers our needs; revisit if tables get complex.
- **Built-in cross-product "context" commands** (e.g. one call returning an issue plus
  related Confluence pages) — tempting for agent efficiency, but today the agent composes
  individual calls itself and does the synthesis better than we could hard-code. Revisit as an
  optimization doc if round-trip volume becomes a real cost.
- **Auto-fetching every search page by default** — dangerous default against a large instance;
  an explicit `--limit` keeps the blast radius visible.

## Implementation plan

1. `src/core/env-file.ts` — `loadEnvFile(path)`: parses a `.env` file (`KEY=value`, `#`
   comments, optional `export` prefix, single/double quotes) and applies it without overwriting
   variables already present in the environment. Raises `ConfigError` when the named file is
   missing or unreadable.
2. `src/shared/base-command.ts` (not `src/lib/` — the repo's `no-restricted-imports` rule reserves `lib` for build artifacts) — `JiraCommand extends Command`: `enableJsonFlag`, shared
   connection flags (`static baseFlags`, including `-e/--env-file`), `resolveConfig(flags)`
   bridging flags→0001 overrides after the env file is applied, and a `catch()` override
   mapping `CliError` to oclif exits.
3. `src/shared/output.ts` — `formatKeyValue(pairs)` and `formatTable(rows, columns)`; no
   dependencies.
4. `src/commands/jira/whoami.ts`
5. `src/commands/jira/issue/view.ts`
6. `src/commands/jira/issue/search.ts` (adds a small `searchAll(options, limit)` helper to
   `JiraClient` that loops `searchIssues` pages)
7. Regenerate `command-snapshot.json` (`pnpm run build`) and the README (`pnpm run readme`);
   commit both.

## Testing

- **env-file:** parses comments, blank lines, `export` prefixes, and quoted values; never
  overwrites a variable already set in the environment; a missing path raises `ConfigError`.
- **base-command:** `--env-file` is applied before config resolution; flag-over-env precedence
  reaches `resolveJiraConfig`; `ConfigError`/`AuthError` map to exits 2/3.
- **whoami:** happy path against the 0001 mock server; bad credentials exit 3.
- **issue view:** curated human output; `--json` emits the raw payload; unknown key exits 1
  with the API's error message.
- **issue search:** `--limit 3` against a mock returning two pages fetches exactly two pages
  and renders three rows; Cloud (`nextPageToken`) and Server (`startAt`) variants; `--jql`
  required.

## Open questions

- **Field curation for human output** — the proposed default set (key, summary, status, type,
  assignee, reporter, dates) is a taste call; cheap to adjust after first real use.
- **Accepting a browse URL (`https://.../browse/PROJ-123`) as the issue argument** — nice
  ergonomics, small utility; include here or defer to its own micro-doc?
