# 0008 — Confluence writes

**Status:** Draft
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-08

## Problem

Confluence is read-only. 0003 shipped `page get`, `page search`, and `page children`, and nothing
since has been able to change a page. That is half of what the tool exists for: the workflow this
CLI was built to serve is "read the requirements page, then create the tickets" — and increasingly
the reverse, "write the status page from what shipped." Neither works today.

It is also the largest remaining parity gap. `mcp-atlassian` and Atlassian's own `acli` both write
Confluence; we do not.

Three mechanics decide the shape of these commands, and all three were established against a live
instance rather than reasoned about, because each has a plausible-but-wrong answer:

1. **A page update needs the page's current version number.** The question was whether sending a
   stale one overwrites somebody's edit. **It does not** — Confluence answers `409` and changes
   nothing:

   ```
   409 ConflictException: Version must be incremented on update. Current version is: 2
   ```

   Verified by updating to v2, then sending v2 again: the second call was refused and the page kept
   its v2 body. This is the finding that shapes the command — see _Versions_ below.

2. **`DELETE` does not destroy a page.** It moves it to the space trash: the page comes back from
   `GET ?status=any` with `status: trashed` and appears in `?status=trashed` listings. A _second_
   delete, with `?status=trashed`, purges it permanently — after which the id `404`s. Two different
   operations with very different consequences, behind one HTTP verb.

3. **A comment is content, not a sub-resource.** It is created by `POST /content` with
   `type: comment` and a `container` pointing at the page, and read back from
   `GET /content/{id}/child/comment`. Not the shape Jira uses, so 0005's client methods do not
   transfer.

## Decision

Five commands.

| Command                        | Kind  |
| ------------------------------ | ----- |
| `confluence page create`       | write |
| `confluence page update`       | write |
| `confluence page delete`       | write |
| `confluence page comment list` | read  |
| `confluence page comment add`  | write |

### Versions: fetch, increment, send

`page update` reads the page, adds one to its version, and sends that. The caller never supplies a
version number.

The reason this is safe rather than sloppy is finding 1. Fetch-then-write has a race window — the
page can change between the read and the write — but the window ends in a **`409` that changes
nothing**, not a silent overwrite. So the worst outcome of losing the race is a clear error telling
the caller to retry, which is exactly what the CLI would have to say anyway.

Requiring `--version` was the alternative, and it is the wrong trade here: the primary caller is an
agent, which has no way to know the number without a prior read, so the flag would force every
caller to implement fetch-then-write themselves and get the race handling wrong in their own code
instead of ours. A flag that every caller must pass and none can compute is not a safety feature.

The 409 is surfaced with its own message rather than a generic failure, since "someone edited this
page while you were working" is a specific, actionable thing and the caller's next move is to
re-read and re-apply.

`PUT /content/{id}` also requires the `title` even when it is unchanged, so the same fetch supplies
it. `--title` overrides.

### Delete: trash by default, purge on request

Finding 2 splits this in two, and 0004's rule — as sharpened in 0005 and applied in 0006 —
decides each:

| Command               | Effect                               | `--confirm`? |
| --------------------- | ------------------------------------ | ------------ |
| `page delete`         | moves to trash; restorable in the UI | **no**       |
| `page delete --purge` | permanently destroys it              | **yes**      |

`--confirm` guards irreversible loss of data. Trashing is not that: the page is recoverable, and
attaching the flag to a reversible action is how the flag stops meaning anything on the commands
where it matters — the same argument that left `--confirm` off `link delete` in 0006.

Purging is exactly that, so it takes the flag and says what it is destroying.

`--purge` on a page that is not already trashed performs both steps, because "delete this
permanently" is one intent and making the caller issue two commands invites them to stop after the
first and believe they are done.

### Body input: storage now, markdown later

These commands accept **storage format**, Confluence's XHTML-plus-macros representation, plus a
`--text` convenience for the simple case:

| Flag                   | Body sent                     |
| ---------------------- | ----------------------------- |
| `--body-file page.xml` | the file's contents, verbatim |
| `--body '<p>…</p>'`    | the argument, verbatim        |
| `--text "one line"`    | wrapped in a paragraph        |

**Markdown input is deliberately out of scope**, and that is the largest decision in this document.

`shared/storage-markdown.ts` converts storage → markdown, for `page get`. The reverse is not that
function run backwards; it is a different problem. Storage has no markdown equivalent for an info
panel, a status badge, or a page include, and markdown has constructs — a fenced code block — that
must become a `structured-macro` with a CDATA body and a language parameter. Writing it means
_designing a mapping_, deciding what is lost in each direction, and that argument deserves its own
document rather than being smuggled into this one.

Accepting storage unblocks the entire write surface now. When markdown lands it adds a flag and
changes none of these commands' shapes.

The honest cost, stated plainly: **storage is not what an agent would naturally produce.** Asked to
write a status page, a model emits markdown, not `<ac:structured-macro>`. So until markdown exists,
the agent-facing story here is weaker than for the Jira commands, and the tool is most useful for
callers who already have storage — including anything that read a page with `page get --json` and
wants to write part of it back. That is a real limitation, not a technicality.

### Placement and identity

`page create` takes `--space` and `--title`, both required, and `--parent <id>` to place the page
under another, mapping to `ancestors: [{ id }]`. Parent matters more here than it looks: the
break-a-page-into-work flow wants child pages, and a page created without a parent lands at the
space root where nobody looks.

Confluence permits two pages with the same title in a space only if one is trashed; a genuine
duplicate is a `400`, surfaced as-is rather than pre-checked, since the instance's answer is more
current than a guess.

### Comments

`page comment add` posts `type: comment` with a `container`, per finding 3. `page comment list`
reads `child/comment` and renders id, author, date, and a flattened one-line preview — the same
columns as `issue comment list` in 0005, for the same reason: the id is what any future edit or
delete needs and is not otherwise discoverable.

Comment edit and delete are **not** in this document. Jira got them in 0005 because a comment
there is a sub-resource with a clean `PUT`/`DELETE`; a Confluence comment is content, so editing
one is `page update`'s version dance applied to a comment id. That is the same design question a
second time and belongs with it, not bolted on here.

### Output and errors

Unchanged from 0002. Human tables by default, `--json` returning the raw payload, one JSON object
on stderr for failures, exit 2 config or usage, 3 auth, 1 otherwise. Every write takes `--dry-run`.
All four writes declare `static isWrite = true`, so 0004's read-only guard covers them without any
command doing anything.

Page titles and comment bodies are server-supplied and go out through the sanitising paths
established in 0002 and hardened since.

## Alternatives considered

- **Requiring `--version` on update.** Rejected above: uncomputable by the caller that matters, and
  the 409 already makes the unsafe case loud.
- **`--force` to overwrite regardless of version.** There is no such thing in the API — the version
  must be exactly current + 1 — so "force" could only mean "re-read and retry", which quietly
  discards a concurrent edit. If a caller wants that, it is two explicit commands, and it should
  feel like two.
- **`--confirm` on plain `page delete`.** Rejected: trashing is reversible. Revisit if it turns out
  people cannot find the trash.
- **Markdown input in this document.** Rejected above; it is the one deferral here that materially
  weakens the result, so it should be the next Confluence doc rather than a someday item.
- **Pre-checking whether a title already exists.** Rejected. It is a race, and Confluence's own
  `400` is accurate.
- **Page labels and attachments.** Out of scope. Labels are a small, separate surface; attachments
  need multipart support the transport does not have and belong with Jira attachments.

## Implementation plan

1. `src/core/confluence-client.ts` — `createContent(body)`, `updateContent(id, body)`,
   `deleteContent(id, options: { purge?: boolean })`, `getComments(pageId, options)`. All
   `mutating: true` except the last.
2. `src/shared/confluence-body.ts` — resolves `--text` / `--body` / `--body-file` into a storage
   body, refusing more than one source. Mirrors `shared/json-input.ts`'s shape so the error
   messages match what callers already see.
3. `src/commands/atlassian/confluence/page/{create,update,delete}.ts`
4. `src/commands/atlassian/confluence/page/comment/{list,add}.ts`
5. `oclif.topics` gains `atlassian:confluence:page:comment`; regenerate `command-snapshot.json` and
   the README.
6. `site/src/content/docs/guides/write-safety.md` — document `page delete --purge --confirm`
   alongside the existing `--confirm` commands, per CONTRIBUTING's rule for write-safety changes.
   The docs site's command reference regenerates from the README, so nothing else there is hand-run.

## Testing

- **body resolution:** `--text` wraps in a paragraph; `--body` and `--body-file` pass through
  verbatim; two sources at once is a `ConfigError`; a create with no body is refused.
- **update:** fetches the current version and sends exactly current + 1; supplies the existing
  title when `--title` is absent and the override when present; a `409` from the instance surfaces
  as a conflict naming the page rather than a generic failure; `--dry-run` sends no write.
- **delete:** plain delete needs no `--confirm` and hits `DELETE /content/{id}`; `--purge` requires
  `--confirm` and issues the trash-then-purge pair; refused without it, naming the page; the
  read-only guard refuses both before any request.
- **create:** `--space` and `--title` reach the payload; `--parent` becomes `ancestors[0].id`; a
  duplicate title surfaces the instance's 400.
- **comment add / list:** the container points at the page; the listing renders every column from
  captured output rather than the mock payload; an empty listing is not an error.
- **live:** against a real instance — create a page under a parent, read it back, update it and
  confirm the version incremented, force a 409 by sending a stale version, add and list a comment,
  trash the page, confirm it is recoverable, then purge it and confirm the id 404s. Leave the space
  and its trash clean.

## Open questions

- **Markdown input** is the next Confluence document and should not wait long, since it is what
  makes these commands useful to an agent rather than only to a caller holding storage.
- **Comment edit and delete**, deferred above, belong with it.
- **Whether `page update` should support a partial edit** — appending a section rather than
  replacing the body. It is the common real request ("add this week to the status page"), it cannot
  be done safely by string concatenation on storage, and it may be the actual reason markdown
  matters. Worth its own thought rather than a flag.
