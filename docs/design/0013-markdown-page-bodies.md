# 0013 — Markdown page bodies

**Status:** Draft
**Package:** `packages/simply-atlassian-core` (the converter); `packages/simply-atlassian` (the flags)
**Date:** 2026-09-09

## Problem

0008 made Confluence writable, and deliberately took only **storage format** — Confluence's XHTML
with `ac:` macro tags. That is the honest shape of the API, and it is the wrong shape for the
caller this CLI exists to serve.

Ask a model to write a status page and it produces Markdown. It does not produce
`<ac:structured-macro ac:name="code" ac:schema-version="1">` with a CDATA body and a language
parameter — and when pushed to, it produces that _almost_ correctly, which fails as a 400 rather
than as something a caller can recover from. So the write commands are usable today by anyone
holding storage and awkward for the one consumer the tool was built around.

This is also the gap between "we can write Confluence pages" and "documentation can be automated,"
which is the use case the writes were wanted for.

Nothing else in the field does this from a CLI. `kaichen/atlassian-cli` takes a raw JSON payload
and nothing else; Atlassian's `acli` was not checked. `mcp-atlassian`, the Python MCP server both
CLIs descend from, does convert — which is where the expectation comes from.

## Decision

Add `--markdown` and `--markdown-file` to `page create`, `page update`, and `page comment add`,
alongside the existing `--text`, `--body`, and `--body-file`. Exactly one body source, as now.

Add `--append` to `page update`, which puts the new body after the existing one instead of
replacing it.

`--append` is in this document rather than its own because it is the same use case. "Add this week
to the status page" is what automated documentation means in practice, and neither half is much use
alone: appending without Markdown means splicing XHTML by hand, and Markdown without appending
means rewriting the whole page on every edit. It is also the sharpest edge on `page update` today —
the command replaces the body, so an agent that does not first read and re-send the old content
destroys it. Confluence's version history makes that recoverable, but recoverable is not the same
as correct.

What `--append` deliberately does **not** do is place content. It concatenates: storage is XHTML,
so putting a block after the last one is well-defined. Replacing a named section, or inserting
under a particular heading, requires understanding the document's structure, and guessing at that
is how an edit lands somewhere nobody intended. If that is wanted it deserves its own design.

A new `markdown-storage.ts` in `simply-atlassian-core` converts a documented subset of Markdown
to storage, beside `storage-markdown.ts` which does the reverse — [0012](0012-simply-atlassian-core.md)
moved that code out of the CLI, and a converter with no terminal or process dependencies belongs
on that side of the line. The
commands are otherwise untouched: no new command, no changed output, no changed version or delete
behaviour.

### What converts

| Markdown                  | Storage                                        |
| ------------------------- | ---------------------------------------------- |
| `# … ######`              | `<h1>` … `<h6>`                                |
| blank-line separated text | `<p>`                                          |
| `**bold**`, `__bold__`    | `<strong>`                                     |
| `*italic*`, `_italic_`    | `<em>`                                         |
| `` `code` ``              | `<code>`                                       |
| ` ```lang ` fenced block  | `code` macro, `language` parameter, CDATA body |
| `- ` / `* ` / `+ `        | `<ul><li><p>`                                  |
| `1. `                     | `<ol><li><p>`                                  |
| nested lists (two spaces) | nested `<ul>`/`<ol>`                           |
| `[text](url)`             | `<a href="url">`                               |
| `> `                      | `<blockquote>`                                 |
| `---`                     | `<hr />`                                       |
| trailing two spaces       | `<br />`                                       |
| GFM pipe tables           | `<table><tbody><tr><th>/<td>`                  |

That set is not arbitrary: it is the inverse of what `storage-markdown.ts` already produces when
reading a page, so the two directions agree on the same vocabulary.

### The three decisions that matter

**1. Unsupported Markdown is a loud error, never a silent drop.**

Images, footnotes, reference-style links, raw HTML blocks, task lists and definition lists are
refused, naming the construct and the line number. The alternative — dropping what we cannot
translate — means a caller writes a page, the command reports success, and a section is missing.
Nobody re-reads a page they just published. A converter that occasionally eats a paragraph is
worse than no converter, because it is trusted.

Widening the set later is easy and safe. Un-losing content is not possible.

**2. Confluence-only constructs stay unreachable from Markdown.**

An info panel, a status badge, a page include, an expand block: Markdown has no syntax for these,
and inventing some — `:::info` or similar — would mean this CLI defining a dialect that no editor,
linter or model knows. A caller who needs a macro uses `--body` with storage, which is why that
flag remains. `--markdown` is for prose, which is the great majority of what gets written.

**3. Round-tripping is not lossless, and the doc says where.**

`page get` renders storage to Markdown; this renders Markdown to storage. It is tempting to treat
that as symmetric and it is not. Reading a page containing an info panel produces a blockquote
labelled `> **info**`, and converting that back produces a _blockquote_, not the panel. So
`page get --body-format markdown` piped into `page update --markdown-file` silently flattens
macros.

Two consequences, both deliberate:

- `page get` keeps `--body-format storage`, which _is_ exact. The read-modify-write path a caller
  should use for an existing page is storage in, storage out. The help text on `--markdown` says so.
- This is the one real hazard in the feature, because automated documentation means repeated edits
  to the same page — precisely where a lossy round trip compounds. It is called out in the
  scripting guide rather than left to be discovered.

### Safety

The converter's input is a file or string the caller supplies, and its output becomes a page other
people load. Three things follow.

**All text is XML-escaped** before it lands in storage. Storage is XHTML: an unescaped `&` or `<`
from caller prose either breaks the body or, worse, is reinterpreted as markup. This is the same
rule `--text` already follows, and it means Markdown cannot be used to inject a macro — a caller
who writes `<ac:structured-macro …>` in a Markdown file gets those characters on the page.

**Link and image URLs are scheme-checked.** `[click me](javascript:…)` would otherwise produce
`<a href="javascript:…">` on a page other people click. Only `http`, `https`, `mailto` and
same-instance relative paths are allowed; anything else is refused, naming the scheme. This is
stored content, so the consequence outlives the command.

**Control and invisible characters are stripped**, as `--text` does since 0008. The CLI removes
this class when reading from the API; writing it in unremarked would make the tool the vector.

Nesting depth is bounded, so a pathological file cannot exhaust the stack.

## Alternatives considered

- **A Markdown library** (`marked`, `markdown-it`, `unified`). Rejected: the package has zero
  runtime dependencies except `@oclif/core`, deliberately, because the smaller the dependency tree
  the easier this is to get approved for a government environment. A library would also produce
  HTML, which is not storage — the macro cases still need writing by hand, so it buys tokenising
  and not the part that is actually hard.
- **Reusing `storage-markdown.ts` in reverse.** Not possible. It is a table of storage tags mapped
  to Markdown output; the inverse needs a Markdown _parser_, which is a different kind of program.
- **Dropping unsupported constructs with a warning on stderr.** Rejected. Under `--json` a caller
  never reads stderr, and an agent least of all. A warning nobody sees is a silent drop with extra
  steps.
- **Inventing syntax for macros** (`:::info`). Rejected above.
- **Making `--markdown` the default for `--text`.** Rejected: `--text` promises text, and quietly
  interpreting `*` and `_` in someone's prose is the kind of surprise that turns a status update
  into italics.

## Implementation plan

1. `packages/simply-atlassian-core/src/markdown-storage.ts` — `markdownToStorage(markdown: string): string`, with a block
   pass and an inline pass, throwing `ConfigError` for unsupported constructs.
2. `packages/simply-atlassian-core/src/confluence-body.ts` — `--markdown` / `--markdown-file` added to the one-source
   resolver, so the "pass only one of" error keeps naming every flag the caller used.
3. Flags added to `page create`, `page update`, `page comment add`; `--append` on `page update`,
   which fetches `body.storage` only when appending so an ordinary update does not pay for a body
   it is about to discard.
4. `site/src/content/docs/guides/scripting.md` — the lossy round trip, and which format to use for
   read-modify-write.
5. Regenerate `command-snapshot.json` and the README.

## Testing

- **Per construct:** every row of the table above, asserted against exact storage output.
- **Escaping:** `&`, `<`, `>`, `"`, `'` in prose; a literal `<ac:structured-macro>` in Markdown
  comes out inert; a fenced block's contents are not escaped twice inside CDATA, and a body
  containing `]]>` does not break out of it.
- **Refusals:** each unsupported construct errors naming itself and its line; a `javascript:` link
  is refused naming the scheme; `data:` likewise.
- **Nesting:** two- and three-level lists; a list inside a blockquote; depth beyond the bound errors
  rather than recursing.
- **Round trip, honestly:** a fixture converted Markdown → storage → Markdown asserts what
  survives, and a second fixture asserts that a storage macro read to Markdown and back does
  **not** survive — the loss is pinned by a test so nobody assumes otherwise.
- **`--append`:** the new body lands after the existing one; the body is fetched only when
  appending; `--append` with nothing to add is refused before any request.
- **Live:** create a page from a Markdown file containing every supported construct, read it back
  with `--body-format storage`, append a section, and confirm the rendering in the browser.

## Open questions

- **Images.** Refused here because attachments are not supported yet, so the only workable form is
  an external URL, and a page full of hotlinked images is its own problem. Worth revisiting with
  attachments.
- **Whether `page get` should gain `--body-format markdown-strict`** that refuses to render what
  cannot round-trip, for callers that intend to write back. Speculative until someone wants it.
