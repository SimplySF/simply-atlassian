# 0009 — Jira agile boards and sprints

**Status:** Implemented (PR #14)
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-08

## Problem

The CLI can read and write Jira issues but cannot show the agile boards and sprints that organize
those issues, or move an existing issue into a sprint.

## Decision

Add board and sprint commands backed by Jira's shared `/rest/agile/1.0` API. The client owns
pagination and the 50-issue write limit. Board and sprint IDs are accepted as numeric IDs only;
resolving names would require an extra policy and is deferred. Issue tables reuse the issue-search
columns so the same result is readable in either context.

## Behavior

| Command                               | Behavior                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `jira board list`                     | Lists boards; `--project`, `--type`, and `--limit` filter the result.                                       |
| `jira sprint list <board>`            | Lists a numeric board's sprints; `--state` defaults to `active,future`, and `--limit` caps output.          |
| `jira sprint issues <sprint>`         | Lists issues in a numeric sprint; `--fields` controls requested fields and `--limit` caps output.           |
| `jira sprint add <sprint> <issue...>` | Posts `{ issues: [...] }` to the sprint, chunking lists over 50. `--dry-run` prints the target and payload. |

Read commands print tables and return the aggregate response for `--json`. The add command is a
write for the central `ATLASSIAN_READ_ONLY` guard, but does not require `--confirm` because moving
an issue into a sprint is reversible.

Jira's own error is surfaced for unsupported agile endpoints or non-agile projects; the CLI does
not attempt to predict instance-specific availability.

## Alternatives considered

- Resolve board and sprint names automatically: rejected for v1 because the command would need
  ambiguity handling and a second lookup policy; numeric IDs are explicit and discoverable from the
  list commands.
- Put paging in each command: rejected because Cloud and Server/DC pagination details belong in the
  client, as they do for issue search.
- Add sprint creation and lifecycle transitions: deferred as a separate write surface with more
  state and permission concerns.

## Implementation plan

- Extend `src/core/jira-client.ts` with paginated board, sprint, and sprint-issue reads and chunked
  sprint writes.
- Add `board/list.ts` and `sprint/{list,issues,add}.ts`.
- Share issue-search table columns through `src/shared/issue-table.ts`.
- Add client and command tests, then regenerate the package README/build artifacts.

## Testing

The local HTTP harness verifies agile paths, query parameters, `values` pagination, and 50-item
write chunking. Command tests verify rendering inputs, numeric-id validation, dry-run behavior, and
the read-only write guard.

## Operational verification

Completed 2026-09-08 against a live Jira Cloud site, using a company-managed **Scrum** project
created for this purpose (key `CST`, board id 4 `type: scrum`, auto-created sprint id 2
"CST Sprint 1"). The site's pre-existing projects are team-managed and cannot enable Sprints
("Requires Backlog"), so a company-managed Scrum project is the canonical board this feature
targets. All four commands and both guards were exercised end to end:

| Exercise                  | Command                                           | Result                                                                          |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Boards                    | `jira board list`                                 | Lists boards; `CST board` reports `type: scrum`.                                |
| Sprints                   | `jira sprint list 4 --state active,future,closed` | Lists "CST Sprint 1" (future).                                                  |
| Sprint issues (empty)     | `jira sprint issues 2`                            | "No issues in sprint 2."                                                        |
| Add (dry run)             | `jira sprint add 2 CST-2 --dry-run`               | Prints target + `{ issues: ["CST-2"] }`; sends nothing.                         |
| Add (write)               | `jira sprint add 2 CST-2`                         | "Added 1 issue(s) to sprint 2 (chunk 1/1)."                                     |
| Sprint issues (non-empty) | `jira sprint issues 2`                            | Lists `CST-2`, confirming the response is parsed from the API's `issues` array. |
| Read-only guard           | `ATLASSIAN_READ_ONLY=1 jira sprint add 2 CST-3`   | Refused with `ConfigError` (exit 2); no write performed.                        |
| JSON passthrough          | `jira sprint issues 2 --json`                     | Raw aggregate `{ values, total, pages, complete }` with the one issue.          |

The unsupported-endpoint path was also observed live: `jira sprint list` against a team-managed
board returns Jira's own `400 The board does not support sprints` through `HttpError`, as intended.
The add-to-sprint exercise is reversible (the issue can be moved back to the backlog); `CST-2`
was left in the sprint in the disposable test project.
