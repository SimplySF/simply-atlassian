# 0022 — Moving a Confluence page under a new parent

**Status:** Implemented (PR #86)
**Package:** `packages/simply-atlassian-core`, `packages/simply-atlassian`, `packages/simply-atlassian-mcp`
**Date:** 2026-11-09

## Problem

`page create` can place a new page under a parent (0008), but nothing can change the parent of a
page that already exists. Reorganising a space, such as gathering scattered pages under one heading
page, therefore has to be done by hand in the browser, one page at a time. Applications built on the
core library, such as a tool that tidies a large space, cannot do it at all.

## Decision

`page update` gains a `parent` input: a page id, or a page URL on the configured instance, resolved
the same way as `page create --parent`. The update request then carries `ancestors: [{ id }]`, which
is how Confluence moves a page. It lives in `UpdatePageInput` and `preparePageUpdate` in core, and is
exposed as `--parent` on `atlassian confluence page update` and as `parent` on the
`confluence_page_update` MCP tool.

A move is an ordinary full update, and the body travels with it. When `parent` is given without a
body, `preparePageUpdate` reads the page's current storage and sends it back exactly as read, so the
page's content does not change. A caller that already holds the storage can pass it as `body`
instead; a storage body is sent as given, with no conversion. If the instance returns no body for
the page, the move is refused rather than sent with an empty body, because an empty body would erase
the page.

## Behavior

| Input                           | What is sent                                                                |
| ------------------------------- | --------------------------------------------------------------------------- |
| `parent` only                   | current title, version + 1, `ancestors`, and the current storage, unchanged |
| `parent` with a body            | the new body as usual, plus `ancestors`                                     |
| `parent` with `title`           | the new title, `ancestors`, and the current storage, unchanged              |
| no `parent`                     | exactly what `page update` sent before; no `ancestors` key                  |
| `parent` URL for other instance | refused with a configuration error before any request                       |

`minorEdit` and `message` (`--minor-edit` and `--message` on the CLI) go into the payload's `version`
object, each only when given, so an update that sets neither sends exactly what it did before. A
caller moving many pages at once marks each version minor, so the pages' watchers are not notified
once per page, and records a message saying the page was moved. Neither counts as a change on its
own: an update with only these still needs a title, a body or a parent.

The version handling, the conflict message on a stale version, `--dry-run`, and the read-only guard
are the ones `page update` already has (0008).

## Findings

Tested by hand against Confluence Data Center 9.2:

- `PUT /rest/api/content/{id}/move/append/{targetId}` answers 404; that endpoint does not exist there.
- `PUT /rest/api/content/{id}` with `{ id, type: "page", title, version: { number: current + 1 },
ancestors: [{ id: newParentId }], body: { storage: { value: <current storage>, representation:
"storage" } } }` moves the page. The body read back afterwards is byte-for-byte identical, and the
  version increments.

Cloud was not tested. The same v1 update request is documented to accept `ancestors` there, but this
has not been confirmed against a Cloud site.

## Alternatives considered

- **A separate `page move` command.** Rejected for now: the request is the same update that
  `page update` already prepares, with the same version handling, and a second command would
  duplicate that logic. The Cloud-only move endpoint could justify one later if Data Center gains it.
- **Sending a move without a body.** Not chosen, because the tested request includes the body and
  whether Data Center keeps or clears a body that is left out of a full update was not established.
  Re-sending the storage that was just read is the request known to work.

## Testing

`packages/simply-atlassian-core/test/confluence-pages.test.ts`, under "moving a page with parent":
`ancestors` is present when `parent` is given and absent otherwise, a URL resolves to its id, a URL
for another instance is refused before any request, the current storage is re-sent untouched, a
storage body given with the move is sent as-is without reading the old one, and a page read without
its body is not moved. A separate test there checks that `minorEdit` and `message` appear in `version`
only when given. The CLI test in `writes.test.ts` checks the whole request `--parent` sends,
and the MCP catalogue test checks that `parent` is declared on `confluence_page_update`.
