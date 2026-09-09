# 0014 — Discovery, labels, sprint writes, and remote links

**Status:** Draft
**Package:** `packages/simply-atlassian-core` (behaviour); `packages/simply-atlassian` and
`packages/simply-atlassian-mcp` (surfaces)
**Date:** 2026-09-09

## Problem

Three unrelated gaps, grouped because each is one endpoint and a table, and splitting them into
three documents would cost more than it clarifies.

**Discovery is the one that matters.** `issue create` and `issue update` accept `--body` for
fields that have no typed flag, which is the escape hatch for custom fields — and there is no way
to find out what those fields are called. A caller who wants to set a sprint or a story-point value
has to already know `customfield_10011`, which they can only learn from the web UI or by guessing.
For an agent that is not a minor inconvenience; it makes the escape hatch unusable, because a model
cannot inspect a Jira admin screen. The same applies to project keys and version names.

**Confluence labels** are how pages get organised and found, and nothing in the CLI reads or sets
them.

**Remote links are the one that came from the field.** An agent on a government laptop was asked
to connect a Jira ticket to the Confluence page describing it, and the only way to do it was to
hand-author XHTML containing an `<a href>`, save it to a file, and pass `--body-file`. That works,
and it is one-directional: the page points at the ticket, the ticket knows nothing, and nothing can
ask which pages reference an issue. `issue link` does not help — it only ever joins two Jira issues.

**Sprint writes** finish what 0009 started. `sprint list`, `sprint issues` and `sprint add` shipped;
creating a sprint and closing one did not, so the CLI can move issues into a sprint that someone
else had to create.

## Decision

Ten commands. Five reads, five writes.

| Command                                     | Endpoint                              | Kind  |
| ------------------------------------------- | ------------------------------------- | ----- |
| `jira projects`                             | `GET /project/search`                 | read  |
| `jira fields`                               | `GET /field`                          | read  |
| `jira project versions <key>`               | `GET /project/{key}/versions`         | read  |
| `confluence page label list <page>`         | `GET /content/{id}/label`             | read  |
| `confluence page label add <page>`          | `POST /content/{id}/label`            | write |
| `jira sprint create`                        | `POST /sprint`                        | write |
| `jira sprint update <id>`                   | `POST /sprint/{id}`                   | write |
| `jira issue remotelink list <issue>`        | `GET /issue/{key}/remotelink`         | read  |
| `jira issue remotelink create <issue>`      | `POST /issue/{key}/remotelink`        | write |
| `jira issue remotelink delete <issue> <id>` | `DELETE /issue/{key}/remotelink/{id}` | write |

Behaviour lands in `simply-atlassian-core` and is exposed through both the CLI and the MCP server,
per the rule in `AGENTS.md`. Both surfaces are closed allowlists, so exposing is a deliberate step
rather than a consequence of implementing.

### Discovery

**`jira projects`** lists key, name, type and lead. The key is the point: it is what every other
command takes and what a caller most often does not have.

Paged like every other list here — `--limit`, default 25, following pages until the limit is met.
Cloud paginates `/project/search`; Server/DC returns `GET /project` unpaginated, and the client
absorbs that difference as it does elsewhere.

**`jira fields`** lists id, name, whether the field is custom, and which schema type it holds. It
is unpaginated on both deployments — a few hundred entries — so it is fetched whole and the render
is capped.

`--custom` filters to custom fields, which is the common case: the built-ins are guessable and the
custom ones are why anyone runs this. `--search <text>` matches name or id, because on a mature
instance the list is long and "the one called Story Points" is how people think.

This is the command that makes `--body` usable:

```
$ simply atlassian jira fields --custom --search sprint
ID                  NAME    CUSTOM  TYPE
customfield_10020   Sprint  yes     array
```

**`jira project versions`** lists id, name, released and archived state, and release date. Versions
are how Jira models releases, and the id is needed to set `fixVersions` through `--body`.

### Confluence labels

`page label list` shows name and prefix. Confluence namespaces labels — `global`, `my`, `team` —
and the prefix is part of the identity, so hiding it would make two different labels look the same.

`page label add` takes one or more `--label` values, repeatable, and posts them together. Labels
are additive and idempotent: adding one that exists is not an error and the command says the label
is present rather than implying it created something.

It is a write, so `static isWrite = true` and `--dry-run`, but **no `--confirm`** — adding a label
loses nothing, and 0004's rule reserves that flag for irreversible loss of data.

Label _removal_ is not in scope. It is `DELETE /content/{id}/label?name=`, and it deserves the same
thought about whether removing a label someone else applied is a thing this tool should make easy.

### Sprint writes

`sprint create` takes `--board` (numeric, per 0009's rule that names are not resolved), `--name`,
and optional `--start`, `--end` and `--goal`.

`sprint update <id>` changes `--name`, `--goal`, `--start`, `--end`, or `--state`. State is the
interesting one: Jira accepts `future`, `active` and `closed`, and moving to `closed` is how a
sprint ends.

**Closing a sprint is not `--confirm`-gated**, and that is a judgement worth recording. It is
disruptive and visible, but it is reversible — a closed sprint can be reopened — and 0004's rule is
about irreversible loss of data, not about consequence. Attaching `--confirm` here would weaken it
where it matters. `--dry-run` covers the "let me see first" case.

Jira rejects an incomplete sprint update by clearing fields the caller did not send, so `sprint
update` reads the sprint first and sends the merged result — the same fetch-then-write shape as
`page update` in 0008, for the same reason.

### Remote links

`issue remotelink create` takes `--url`, and optionally `--title`, `--summary` and
`--relationship`. It is the missing direction: a page can carry a hyperlink to a ticket, but only
Jira's remote links make the relationship visible _from the issue_, which is where anyone looking
at the work will be.

Two decisions worth recording.

**`globalId` is set from the URL.** Jira treats it as the link's identity, so posting the same URL
twice updates the existing link rather than adding a duplicate. A caller re-running a script is
the normal case, and an auto-assigned id would leave them with five links to the same page.

**The scheme is checked**, http and https only, for the same reason Markdown link targets are
checked in 0013: the link sits on the issue for everyone who opens it, and stored content outlives
the command that wrote it.

`remotelink delete` needs no `--confirm` — the link holds no content and is re-creatable in one
command from its URL, so it is not the irreversible loss that flag guards. It does shape-check the
id, so an issue key passed by mistake is a usage error rather than a 404 reading as "already gone".

A convenience that links a page in one step — resolving a Confluence page id to its URL and title
without the caller doing it — is deliberately **not** here. It would mean a Jira command holding
Confluence credentials, which crosses a line the config layer draws deliberately. Two commands
compose instead: `confluence open <page> --print` gives the URL.

### Output and errors

Unchanged from 0002. Tables by default, `--json` for the raw payload, one JSON object on stderr for
failures, exit 2 config or usage, 3 auth, 1 otherwise. Server-supplied text — project names, field
names, labels — goes out through the sanitising paths.

## Alternatives considered

- **Resolving board or project names to ids.** Rejected, consistent with 0009: a name is neither
  unique nor stable, and "run `board list` first" is honest where a silent wrong match is not.
- **Caching the field list.** It changes rarely and the request is one round trip. Caching adds
  staleness and a cache to invalidate for no measured gain.
- **Folding `project versions` into `jira projects`.** They answer different questions and one is
  per-project. Keeping them separate matches how `board list` and `sprint list` already split.
- **`confirm` on `sprint update --state closed`.** Rejected above.
- **Label removal in this doc.** Deferred; it is a different question from adding.
- **Splitting this into three documents.** Each would be a page of preamble for one endpoint.

## Implementation plan

1. `simply-atlassian-core`: `getProjects`, `getFields`, `getProjectVersions`, `getLabels`,
   `addLabels`, `createSprint`, `updateSprint` on the clients; `jira-discovery.ts` for the field
   filtering, and sprint-input building in `jira-agile.ts`.
2. Commands under `jira/projects.ts`, `jira/fields.ts`, `jira/project/versions.ts`,
   `confluence/page/label/{list,add}.ts`, `jira/sprint/{create,update}.ts`.
3. MCP tools for all seven, with the two writes marked `kind: 'write'`.
4. `oclif.topics` gains `atlassian:jira:project` and `atlassian:confluence:page:label`; regenerate
   `command-snapshot.json` and the README.
5. Add the two new write commands to the reflective write-safety list.

## Testing

- **fields:** `--custom` filters; `--search` matches name and id, case-insensitively; the render is
  capped and reports the true total; an instance with no custom fields is not an error.
- **projects / versions:** paging stops at `--limit`; every column renders from captured output
  rather than the mock payload; an empty result is not an error.
- **labels:** the prefix is shown; `--label` is repeatable and posts one request; adding an existing
  label is reported as already present, not as new; the read-only guard refuses the write.
- **sprint create / update:** required fields reach the payload; `update` merges rather than
  clearing what it did not send; `--state closed` is accepted; `--dry-run` sends nothing; the guard
  refuses both.
- **MCP:** all seven appear in the catalogue, and the two writes are `kind: 'write'`.
- **remote links:** the body carries `globalId` set from the URL, so a re-run updates rather than
  duplicates; a `javascript:`, `data:`, `file:` or relative target is refused; a missing
  relationship renders as "links to"; a link with no object does not crash the row.
- **MCP:** all ten appear in the catalogue and the five writes are `kind: 'write'`, asserted rather
  than assumed — a missing schema key is valid TypeScript and nothing else would catch it.
- **live:** against a real instance — list projects and fields, find a custom field by name, read a
  project's versions, add and list a page label, create a sprint and close it, and link an issue to
  a Confluence page and read it back from both sides, leaving the sandbox clean.

## Open questions

- **Label removal**, deferred above.
- **The Jira issue macro on the Confluence side.** A remote link makes the issue aware of the page;
  the reverse direction is currently a plain hyperlink. Confluence's `jira` macro would render a
  live status badge instead, and writing one is possible through `--body` today. Worth its own
  thought, since it is the half a reader sees.
- **Whether `fields` should show which projects and issue types a custom field is available on.**
  Jira exposes it through a different endpoint per field, so it would be N+1 requests. Probably
  wants `--field <id>` for one field's detail rather than widening the list.
