# 0010 — Open Atlassian objects in the browser

**Status:** Implemented (PR #13)
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-08

## Problem

After finding an issue or page with the CLI, the useful next action is often to open it in the
Atlassian web application. Today callers must assemble the URL themselves, and headless callers
have no explicit URL-only mode.

## Decision

Add `jira open` and `confluence open` commands. They resolve the configured product base URL,
build a browser URL locally, and launch the platform's default browser through `open` on macOS,
`xdg-open` on Linux, or `start` on Windows. `--print` and its `--url` alias print the URL without
launching. `--json` always returns `{ "url": "..." }` without launching. If the process is in CI,
has no Linux display, or the opener cannot be launched or exits unsuccessfully, the command prints
the URL instead.

## Behavior

| Command                    | Input               | URL                                          |
| -------------------------- | ------------------- | -------------------------------------------- |
| `jira open ISSUE-123`      | Jira issue key      | `<base>/browse/ISSUE-123`                    |
| `jira open PROJ`           | Jira project key    | `<base>/browse/PROJ`                         |
| `confluence open 123456`   | Numeric page id     | `<base>/pages/viewpage.action?pageId=123456` |
| `confluence open PAGE-URL` | Confluence page URL | Same URL after extracting its numeric id     |

Issue, project, and page identifiers are percent-encoded. Confluence Cloud's resolved base already
includes `/wiki`, while Server/DC's base does not need a product suffix; the same page path works
with both shapes.

## Alternatives considered

- **A browser-opening dependency:** rejected because the three platform commands cover the supported
  platforms and adding a dependency would enlarge a small CLI feature.
- **Cloud's `/jira/software/projects/KEY` project path:** rejected in favor of `/browse/KEY`, which
  is the stable path shared by Jira Cloud and Server/DC.
- **Confluence's newer space/page path:** rejected in favor of `pages/viewpage.action?pageId=ID`,
  which works from both the Cloud `/wiki` base and a Server/DC base.
- **Print-only by default:** rejected because an interactive CLI user's natural next step is to
  open the object; explicit `--print`/`--url`, JSON mode, and headless fallback cover automation.

## Implementation plan

1. Add `issueUrl`, `projectUrl`, and `pageUrl` to `shared/atlassian-url.ts`.
2. Add the shared detached platform opener in `shared/open-in-browser.ts`.
3. Add the Jira and Confluence `open` commands.
4. Add URL and command tests, regenerate the command snapshot, and regenerate the package README.

## Testing

Unit tests cover encoding and Cloud/Server base shapes. Command tests cover issue/project and page
resolution, `--print`, `--url`, `--json`, and opener failure fallback for synchronous spawn errors,
asynchronous `error` events, and non-zero exits.

## Open questions

None. The URL forms and launch-vs-print behavior were selected for this implementation.
