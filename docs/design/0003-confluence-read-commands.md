# 0003 — Confluence read commands and page rendering

**Status:** Implemented (PR #4)
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-04

## Problem

The client core (0001) can already talk to Confluence — `getPage`, `searchPages`, and
`getPageChildren` exist and are tested — but no command exposes any of it. The team reads
Confluence as heavily as Jira, so a Jira-only CLI covers half the daily work.

Two things have to be decided before the commands can be written, and neither is obvious:

1. **The base command is Jira-shaped.** `JiraCommand` carries `--jira-url`,
   `--jira-username`, `--jira-api-token`, and `--jira-personal-token`. Confluence needs the
   same machinery with different flags, so the class has to split before a second product
   arrives — not after.
2. **A page's content is not text.** Confluence returns `body.storage.value`, an XHTML-ish
   "storage format" containing Atlassian-specific macro elements. Printing it raw is unusable
   for a person and wasteful for an agent, so this doc has to settle how a page body is
   rendered.

## Decision

Split the base command into a product-agnostic parent with per-product subclasses, then add
three read commands — `simply atlassian confluence page get`, `page search`, and
`page children` — mirroring the Jira read commands' conventions exactly.

Page bodies are converted to Markdown by a small purpose-built renderer with no new
dependency. Confluence storage format is a constrained, documented subset rather than
arbitrary HTML, and macros need custom handling regardless of what does the conversion, so a
general HTML-to-Markdown library earns less here than it looks like it would.

## Behavior

### Command namespace

Per the convention established in PR #3, the binary is `simply` and commands nest by product:

| Command                                            | Client method     | Purpose                             |
| -------------------------------------------------- | ----------------- | ----------------------------------- |
| `simply atlassian confluence page get <page>`      | `getPage`         | One page, body rendered as Markdown |
| `simply atlassian confluence page search`          | `searchPages`     | CQL search, paged like Jira's       |
| `simply atlassian confluence page children <page>` | `getPageChildren` | Direct children of a page           |

Files land at `src/commands/atlassian/confluence/page/*.ts`, tests mirror them, and each new
topic level gets a `description` in `oclif.topics`.

### Base command split

`src/shared/base-command.ts` becomes:

- **`AtlassianCommand`** — everything neither product owns: `enableJsonFlag`, `-e/--env-file`
  loading, the `catch()` that maps typed errors to stable exit codes and keeps failures off
  stdout, credential scrubbing, and control-character stripping.
- **`JiraCommand extends AtlassianCommand`** — the `--jira-*` connection flags and `jira()`.
- **`ConfluenceCommand extends AtlassianCommand`** — the `--confluence-*` flags and
  `confluence()`.

Nothing about the existing Jira commands changes except which class they extend. The security
behaviour proven in PR #3 lives in the shared parent, so Confluence inherits it rather than
reimplementing it.

### Page arguments accept a URL

`page get` and `page children` take either a page id or a pasted page URL:

```
simply atlassian confluence page get 123456
simply atlassian confluence page get https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title
```

Extracting the id from a URL is a three-line helper, and it removes a genuine annoyance:
people (and agents relaying what a person pasted) have a URL, not an id. The same helper
should later be applied to Jira issue keys, which have the equivalent `/browse/PROJ-1` form.
A value that is neither a bare id nor a recognizable page URL is a `ConfigError` naming both
accepted forms.

### Output

Identical contract to 0002, so nothing new has to be learned:

- **Default:** human-friendly. `page get` prints page metadata as aligned key-value lines
  followed by the rendered body. `page search` prints a table of id, space, type,
  last-modified, and title; `page children` prints id, status, last-modified, and title — no
  space column, because a child is in its parent's space. Both commands request the
  expansions those columns need: search and children return bare content otherwise, and the
  columns would have rendered as blanks nobody asked for.
- **`--json`:** the raw, unmodified API payload. For `page search`, which follows pages, the
  same envelope shape 0002 defined for Jira search: `{results, size?, pages, complete}`.
- **Errors:** unchanged — one JSON object on stderr under `--json`, nothing on stdout, exit
  2 config or usage, 3 auth, 1 everything else.

### CQL requires a predicate

Confluence rejects a query that is only an ordering: `--cql "order by lastmodified desc"`
returns a 400 with `Could not parse cql`. This mirrors Jira Cloud's refusal of unbounded JQL
(0002), and for the same reason the examples all carry a restriction — a documented example
that errors is worse than none.

### Page body rendering

`page get` requests `body.storage` and converts it. The renderer covers what Confluence
actually emits:

| Storage format                                       | Markdown                                                |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `<h1>`–`<h6>`                                        | `#`–`######`                                            |
| `<p>`                                                | paragraph, blank line separated                         |
| `<strong>` / `<em>` / `<code>`                       | `**`, `_`, backticks                                    |
| `<a href>`                                           | `[text](href)`                                          |
| `<ul>`/`<ol>`/`<li>`, nested                         | `-` / `1.` with indentation                             |
| `<table>`, `<th>`, `<td>`                            | GitHub-style table                                      |
| `<ac:structured-macro ac:name="code">`               | fenced block, language from the macro parameter         |
| `info` / `note` / `warning` / `tip` / `panel` macros | labelled blockquote                                     |
| Any other `<ac:*>` macro                             | `> [macro: name]` placeholder                           |
| `<ac:link>` / `<ri:page>`                            | `[title]` with the page reference                       |
| `<ac:task-list>` / `<ac:task>`                       | `- [ ]` / `- [x]` checklist                             |
| `<ac:adf-extension>`                                 | its fallback content, else `> [node-type]`              |
| `<ac:emoticon>`                                      | its printable emoji fallback                            |
| `<![CDATA[…]]>`                                      | literal text — this is how code macro bodies are stored |
| Comments, doctypes, processing instructions          | dropped                                                 |

Deliberate limitations, stated so nobody is surprised: attachments and images become their
filename in brackets rather than embedded content; layout macros are flattened; unrecognized
macros keep their name but lose their body; `colspan`/`rowspan` are dropped, so a spanning
cell shifts the rest of its row; and a nested table collapses into its cell's text. A table
with no `<th>` row gets a blank header rather than having its first data row promoted into
column names. `--json` always carries the untouched original, so nothing is unrecoverable.

Two properties matter because the output reaches an agent as well as a terminal. Everything a
page author controls is stripped of C0/C1 control characters, carriage returns, and invisible
Unicode format and bidi characters before rendering — a bare CR is enough to overwrite a line
on screen while leaving the hidden text in the stream, which would split what a reviewer sees
from what an agent ingests. And a fence is always longer than the longest backtick run in its
body, with the info string reduced to a language token, so page content cannot break out of a
code block and land as prose an agent might read as narrative.

Flags on `page get`:

| Flag                                    | Effect                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--body-format storage\|markdown\|none` | `markdown` (default) renders; `storage` prints the raw stored value; `none` omits the body and skips fetching it |
| `--expand <csv>`                        | Confluence expansions, replacing the default set                                                                 |

`--body-format none` matters for the agent case: page metadata is small, page bodies are not,
and an agent listing pages should not pay for content it will not read.

## Alternatives considered

- **`turndown` (+ `turndown-plugin-gfm`) for the conversion** — what
  `kaichen/atlassian-cli` uses, and a proven general HTML-to-Markdown library. Rejected, but
  narrowly: it adds a runtime dependency (plus a second for tables) to a package whose
  single-dependency footprint is a real asset in the security review this tool has to pass,
  and it still needs bespoke rules for every `<ac:*>` macro, which is the genuinely
  Confluence-specific half of the problem. If the purpose-built renderer proves inadequate
  against real pages, adopting turndown is a contained change behind one function — revisit
  then, with evidence rather than speculation.
- **Printing raw storage format and letting the caller convert** — zero work and zero loss,
  but it pushes an XHTML-parsing problem onto every consumer, and for the agent that drives
  this CLI it means paying tokens for markup. `--body-format storage` keeps this available
  for anyone who wants it without making it the default.
- **Stripping tags to plain text** — dependency-free and simple, but it discards the
  structure that makes a page readable: headings, lists, tables, and code blocks all collapse
  into undifferentiated prose. Worse for a person and worse for an agent.
- **Confluence Cloud's v2 API (`/wiki/api/v2/pages`)** — newer and cleaner than the
  `/rest/api/content` surface the client uses, but it exists only on Cloud, and the whole
  point of the client layer is that commands do not branch on deployment. Staying on v1
  keeps one code path for both. Worth revisiting only if Atlassian withdraws v1.
- **A single `page` command with subcommand-ish flags** (`page --search`, `page --children`)
  — fewer files, but it fights oclif's topic model, makes `--help` less discoverable for an
  agent, and diverges from the Jira commands for no benefit.

## Implementation plan

1. `src/shared/base-command.ts` — extract `AtlassianCommand`; keep `JiraCommand` as a
   subclass so the existing commands are untouched beyond their `extends` clause; add
   `ConfluenceCommand`.
2. `src/shared/atlassian-url.ts` — `pageIdFromInput(value)`: bare id, or id extracted from a
   `/wiki/spaces/<key>/pages/<id>/<slug>` URL; `ConfigError` otherwise.
3. `src/shared/storage-markdown.ts` — `storageToMarkdown(value)`, the renderer above.
4. `src/core/confluence-client.ts` — add `searchAllPages(cql, limit)` following `_links.next`
   the way `searchAllIssues` follows Jira's cursors, and let `getPage` take an explicit
   expansion list so `--body-format none` can skip the body.
5. `src/commands/atlassian/confluence/page/get.ts`
6. `src/commands/atlassian/confluence/page/search.ts`
7. `src/commands/atlassian/confluence/page/children.ts`
8. Regenerate `command-snapshot.json` (`pnpm run build`) and the README (`pnpm run readme`);
   commit both.

## Testing

Vitest, against the existing local `node:http` harness:

- **base-command split:** a Jira command and a Confluence command each resolve only their own
  product's flags; `--env-file`, exit-code mapping, and stdout-stays-empty-on-error are
  asserted once against `AtlassianCommand` and inherited.
- **atlassian-url:** bare id; a full page URL with and without a trailing slug; a URL from a
  Server/DC instance (no `/wiki` segment); a garbage value raising `ConfigError`.
- **storage-markdown:** each row of the conversion table, nested lists, a table, a code macro
  with and without a language parameter, an unknown macro, and malformed markup that must not
  throw.
- **commands:** `page get` renders metadata plus body and returns the raw payload under
  `--json`; `--body-format storage` prints the stored value verbatim; `--body-format none`
  omits the body _and_ does not request it; `page search` follows more than one page and
  reports truncation; `page children` handles a page with no children; a nonexistent page id
  exits 1 with the API's message.
- **live:** the same matrix run against a real Cloud instance before the PR is opened, since
  PR #3 demonstrated that mocks accept requests a real instance rejects. This happened: 38
  cases across the three commands, all passing, and it found three defects the mocks had
  hidden (missing search expansions, task-list status text leaking as content, and ADF
  decision macros printing their internal UUIDs).

## Open questions

- **`page views`** — Kai's tool exposes a per-page view-count endpoint. It is Cloud-only and
  analytics-flavoured rather than content, so it is left out here; add it later if anyone
  wants it.
- **`confluence user search`** — also in Kai's surface. It belongs with the Jira user command
  in a later "directory" doc rather than under `page`.
- **Markdown fidelity threshold** — how wrong does the purpose-built renderer have to be
  before turndown is worth the dependency? Proposed answer: if a page from the team's own
  space renders unusably, switch. Rendering is isolated behind `storageToMarkdown`, so the
  swap stays a one-function change. Worth noting that the Cloud API also returns
  `body.atlas_doc_format` — the same ADF JSON Jira uses — which is a second possible source
  if storage format proves awkward.
- **Data Center verification** — everything live-tested here was Cloud. The v1 `/rest/api`
  surface these commands use exists on both, and the client already handles the deployment
  difference, but no Confluence command has yet run against a Data Center instance.
