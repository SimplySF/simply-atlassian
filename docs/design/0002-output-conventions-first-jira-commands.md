# 0002 — Output conventions and first Jira read commands

**Status:** Draft
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

| Flag                    | Env fallback            | Notes                    |
| ----------------------- | ----------------------- | ------------------------ |
| `--jira-url`            | `JIRA_URL`              | Base URL of the instance |
| `--jira-username`       | `JIRA_USERNAME`         | Cloud only               |
| `--jira-api-token`      | `JIRA_API_TOKEN`        | Cloud only               |
| `--jira-personal-token` | `JIRA_PERSONAL_TOKEN`   | Server/DC only           |
| `--no-ssl-verify`       | `JIRA_SSL_VERIFY=false` | Disables TLS validation  |

Flags beat env (already the 0001 contract). Passing secrets as flags works but the README
documents env vars as the recommended path — flags land in shell history.

### Output contract

- **Default:** human-friendly. Single entities render as aligned key-value lines; lists render
  as compact tables (key, status, assignee, summary). Only a curated subset of fields is shown.
- **`--json`:** the raw, unmodified API payload — the full response, not the curated subset —
  so the CLI is scriptable with `jq` from day one. Provided by oclif's `enableJsonFlag`, which
  also suppresses `this.log` noise automatically.
- **Errors:** `CliError` subclasses map to `this.error(message, { exit: error.exitCode })` —
  config errors exit 2, auth errors exit 3, other HTTP failures exit 1, never a stack trace.
  With `--json`, oclif renders the error as JSON on stderr.

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

1. `src/lib/base-command.ts` — `JiraCommand extends Command`: `enableJsonFlag`, shared
   connection flags (`static baseFlags`), `resolveConfig(flags)` bridging flags→0001 overrides,
   and a `catch()` override mapping `CliError` to oclif exits.
2. `src/lib/output.ts` — `formatKeyValue(pairs)` and `formatTable(rows, columns)`; no
   dependencies.
3. `src/commands/jira/whoami.ts`
4. `src/commands/jira/issue/view.ts`
5. `src/commands/jira/issue/search.ts` (adds a small `searchAll(options, limit)` helper to
   `JiraClient` that loops `searchIssues` pages)
6. Regenerate `command-snapshot.json` (`pnpm run build`) and the README (`pnpm run readme`);
   commit both.

## Testing

- **base-command:** flag-over-env precedence reaches `resolveJiraConfig`; `ConfigError`/
  `AuthError` map to exits 2/3.
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
