# 0011 — Jira issue history

**Status:** Implemented
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-08

## Problem

The CLI can show an issue's current state but not how it got there. Jira keeps a changelog for
each issue, which answers questions such as when an issue moved to Done, who reassigned it, and
when a fix version was added.

## Decision

Add `atlassian jira issue history <issue>` as a read-only command. It follows the complete history
up to `--limit` entries, optionally selects entries that touched `--field <name>`, and renders each
entry as a timestamp/author header followed by its field changes. Human output is oldest first so
the timeline reads chronologically; `--json` returns an envelope with the original `rawEntries`,
including server-specific author details and history metadata, plus `total` and `complete` so
machine consumers cannot mistake a capped or limit-truncated history for a complete audit trail.

The Jira client owns the deployment difference:

| Deployment | Request | Paging |
| --- | --- | --- |
| Cloud | `GET /rest/api/3/issue/{key}/changelog` | `startAt` and `maxResults`; response `values`/`isLast` |
| Server/DC | `GET /rest/api/2/issue/{key}?expand=changelog` | One expanded issue response with `changelog.histories`, `startAt`, `maxResults`, and `total` |

Both paths normalize to `JiraChangelogEntry[]` for terminal rendering, while retaining the original
entries for JSON. A normalized entry has an id, display-name author, creation timestamp, and
field-change items. Items retain both string and id forms so the command can prefer readable
`fromString`/`toString` values and fall back to `from`/`to`.

## Safety and output

The command is read-only and uses the shared Jira command base. Human-mode timestamps, authors,
field names, and values pass through `logSafe`, which strips terminal control characters. JSON
keeps the original server entries without human-output sanitization. Unknown issues use the
existing typed HTTP error mapping.

## Testing

- Cloud client paging is covered through two `/changelog` responses and its `values`/`isLast`
  cursor.
- Server/DC retrieval is covered through an expanded issue response containing
  `changelog.histories` and its `startAt`, `maxResults`, and `total` metadata.
- Command tests cover grouped output, case-insensitive field selection, entry limits, JSON-shaped
  raw output (including author details and history metadata) with completeness metadata for both
  limit-truncated Cloud and capped Server/DC histories, id fallback, and control-character removal.

## Verification boundary

The worktree has no configured live Jira Cloud or Server/DC instance, so live verification against
a real issue and a target Server/DC version remains for the review/deployment environment. The
automated tests pin the documented REST response shapes.
