# 0016 — Keeping a macro's visible words when rendering a page

**Status:** Implemented
**Package:** `packages/simply-atlassian-core`
**Date:** 2026-10-16

## Problem

`storageToMarkdown` (0003) dropped words that a reader of the page can see in Confluence, because
those words are stored as macro parameters or reference attributes rather than as body text:

- a status lozenge rendered as `[status]`, so an incident page lost its severity (`SEV2`) and a
  service page lost its state (`LIVE`);
- a panel rendered as `> **warning**`, without the heading its `title` parameter gives it;
- an expand section rendered as `> [macro: expand]`, without the title a reader clicks on;
- a user mention rendered as `[link]`, so "maintained by" named nobody;
- a table nested in a cell ran its values together into one word (`ZoneUptimeeu-199.99%`).

The output reaches a model as well as a terminal. A model asked about an incident's severity, or a
page's owner, cannot answer from text that is not there, and nothing in the output says it was
dropped.

## Decision

Keep those words, in the bracketed and quoted forms the renderer already uses, so the vocabulary of
the output does not grow.

## Behavior

| Storage                                                   | Markdown                                                 |
| --------------------------------------------------------- | -------------------------------------------------------- |
| inline `status` macro with `title` `SEV2`                 | `[status: SEV2]`                                         |
| inline macro without a `title`                            | `[status]` (unchanged)                                   |
| `warning` panel with `title` `Paging policy`              | `> **warning: Paging policy**` then the quoted body      |
| `expand` (or any non-panel block macro) with a `title`    | `> [macro: expand: Show legacy details]`                 |
| `<ac:link><ri:user ri:username="sam.rivera" /></ac:link>` | `[@sam.rivera]`; else `ri:userkey`, else `ri:account-id` |
| a table inside a cell                                     | `Zone, Uptime; eu-1, 99.99%` in that cell                |

A link with its own link body still renders that body, as before. A macro whose title is empty
renders exactly as it did.

## Alternatives considered

- **Rendering a nested table as a real table.** Markdown has no nested tables, and a GitHub-style
  cell holds one line, so the inner table has to be flattened into text either way. Commas and
  semicolons keep the values apart without introducing a pipe that would add a column.
- **Resolving a mention's user key to a display name.** That needs a request per user, and this
  function is pure by design (0012). The identifier is enough to tell users apart and to look one
  up.

## Implementation plan

`src/storage-markdown.ts`: `macroLabel` adds the title to the inline macro and block macro
renderers; `referenceName` names `ri:user`; an inline `table` renderer flattens a nested table.

## Testing

One test per row above in `test/storage-markdown.test.ts`, plus the existing panel, macro and table
tests, which pin that a macro or table without these features renders as it did.

## Open questions

- None.
