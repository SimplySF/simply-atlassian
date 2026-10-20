# 0019 — Confluence page history

**Status:** Implemented
**Package:** `packages/simply-atlassian-core`, `packages/simply-atlassian`, `packages/simply-atlassian-mcp`
**Date:** 2026-10-20

## Problem

`page get` shows a page as it is now. Nothing shows how it got there: who edited it, when, and
what they said about the change. Those are the questions people ask before trusting a page ("is this
still maintained?") and after something on it goes wrong ("who changed the runbook last week?").
Jira has an equivalent in `issue history` (0011); Confluence has nothing.

## Decision

Add `atlassian confluence page history <page>`, a read-only command that lists a page's versions
newest first, up to `--limit`. Retrieval lives in `ConfluenceClient.getAllPageVersions` in core and
is exposed through the CLI command and an MCP tool `confluence_page_history`.

The two deployments do not share an endpoint for this, which is the first time the Confluence client
has to branch on deployment (0003 noted it had not needed to so far):

| Deployment                                     | Request                                                                                               | Paging                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cloud                                          | `GET /wiki/api/v2/pages/{id}/versions?sort=-modified-date`                                            | Opaque `cursor` taken from `_links.next`; `limit` ≤ 250 |
| Server/DC                                      | `GET /rest/experimental/content/{id}/version`                                                         | `start`/`limit`; stop when `_links.next` is absent      |
| Server/DC fallback, when the above answers 404 | `GET /rest/api/content/{id}?status=historical&version=N&expand=version` for N = current, current−1, … | One request per version, bounded by `--limit`           |

Why each one:

- **Cloud** removed the v1 `GET /rest/api/content/{id}/version` list; the current v1 spec keeps
  only its `POST` (restore) and `DELETE`. The v2 versions endpoint is the only supported list. Its
  entries identify authors by `authorId` alone, so the client resolves display names with one
  `GET /wiki/rest/api/user/bulk?accountId=…` per 100 distinct authors. A failed lookup is not an
  error: the account id is shown instead.
- **Server/DC** has no documented version list in any REST reference from 8.9 to 11.0; the
  documented `/rest/api/content/{id}/history` returns only the latest and previous versions.
  Atlassian's KB points at the experimental endpoint, which returns `by`, `when`, `message`,
  `number`, and `minorEdit` per version but is explicitly unsupported and may disappear. The
  fallback uses only supported reads, so the command keeps working if it does. A version the walk
  finds missing (DC allows deleting a historical version) is skipped, not treated as an error.

All paths normalize to:

```ts
interface ConfluencePageVersion {
  readonly number: number;
  readonly when?: string;
  readonly author?: string; // display name, else account id / username
  readonly message?: string;
  readonly minorEdit?: boolean;
}
```

and return `{ versions, rawEntries, complete }`, mirroring `JiraChangelogResult` so the raw and
normalized views stay index-aligned.

## Behavior

```
atlassian confluence page history 123456
atlassian confluence page history https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title --limit 5
atlassian confluence page history 123456 --json
```

| Input     | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `<page>`  | Page id or page URL, resolved with `pageIdForInstance` like `page get` |
| `--limit` | Maximum number of versions, newest first. Default 25, minimum 1        |

**Human output** is a table, newest first:

```
VERSION  WHEN        AUTHOR        MINOR  MESSAGE
───────  ──────────  ────────────  ─────  ────────────────────────
7        2026-10-18  Ada Lovelace  —      Fixed the rollback steps
6        2026-10-02  Grace Hopper  yes    —
…
Showing 7 version(s).
```

Empty cells show `—`, as in every other table. `WHEN` is the date, as in `comment list`; `--json` has the full timestamp. When `complete` is false
the footer says `Showing the 25 most recent version(s); pass --limit for more.` Every
author-controlled value (author name, message) goes through the table's control-character
stripping.

**Order differs from `jira issue history` deliberately.** Jira prints oldest first because a
changelog reads as a narrative of field changes. A page's versions are usually consulted from the
top ("what changed recently"), and `--limit` should cut off the oldest versions, not the newest.

**`--json`** returns `{ rawEntries, complete }`: the instance's own version objects, newest first,
without sanitizing. `rawEntries` therefore differs in shape between Cloud (`authorId`, `createdAt`)
and Server/DC (`by`, `when`), as it does for Jira history. Resolved Cloud display names are not
injected into the raw entries.

**Errors** use the existing mapping: an unknown or unreadable page is the instance's 404 and exits 1.
On Cloud a blog post id also 404s, because the v2 endpoint is page-specific; the command is
`page history`, so that is accepted.

**MCP:** `confluence_page_history`, read kind, input `{ page, limit? }`, returning the same object as
`--json`. It is added to the read-tool lists in 0007 and the MCP guide.

Supporting change: the transport's `QueryValue` accepts a string array, repeated once per value,
because `user/bulk` takes `accountId` that way.

## Alternatives considered

- **Cloud v1 `content/{id}/version`.** Removed from the Cloud v1 API; only restore/delete remain.
- **One code path using the per-version walk everywhere.** It works on both deployments but costs a
  request per version where Cloud and the experimental endpoint return up to 250 or 200 per request.
  It stays as the DC fallback, not the default.
- **Following `_links.next` as a URL.** It is a server-provided path; taking only its `cursor`
  parameter keeps every request on the configured base URL and through the same transport.
- **Showing a historical version's body in this command (`--version N`).** Useful, but it is a
  read of one page version rather than a list, and belongs with `page get` (see open questions).

## Implementation plan

1. `simply-atlassian-core/src/confluence-client.ts`: `deployment` on the client, a raw request
   helper for a non-`/rest/api` base, `getAllPageVersions(pageId, limit)` with the three paths and
   the Cloud author lookup.
2. `simply-atlassian-core/src/confluence-history.ts`: normalization and `pageHistoryJson`, exported
   from `index.ts`.
3. `simply-atlassian/src/commands/atlassian/confluence/page/history.ts`.
4. `simply-atlassian-mcp/src/tools.ts`: `confluence_page_history`.
5. Docs: this file's status, the index row, 0007's tool count, the MCP guide, `AGENTS.md` map entry.
6. `pnpm run build` (command snapshot) and `pnpm run readme`; commit both.

## Testing

- Core, Cloud: two v2 pages followed through the cursor; the request asks for
  `sort=-modified-date` and never more than 250; author ids resolved through `user/bulk`, deduplicated;
  a failing `user/bulk` falls back to account ids; `complete: false` when `limit` stops paging.
- Core, Server/DC: experimental endpoint paged with `start`; a 404 from it triggers the walk, which
  starts at the current version, skips a deleted version, and stops at `limit` or version 1.
- CLI: table rendering and footer for complete and limited histories, URL input, `--json` shape,
  control characters stripped from author and message, 404 exits 1.
- MCP: the tool is registered as read-only and returns the `--json` object.

## Verification boundary

The mocks pin the documented and KB-described shapes. Two things only a live instance settles:
the experimental endpoint's ordering on Server/DC (the client sorts by `number` either way, but if
it pages oldest first a limited read returns the oldest versions, and the fallback walk would be the
right default instead), and whether it is present on the DC versions the team runs.

## Open questions

- **Reading an old version's body.** `page get --version N` (`status=historical&version=N` on both
  deployments) is the natural follow-up. Left out of this doc to keep it a single command.
- **Diffs between versions.** Neither API offers one; it would mean fetching two bodies and diffing
  the rendered Markdown. Not planned.
