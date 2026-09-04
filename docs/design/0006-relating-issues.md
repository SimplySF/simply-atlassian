# 0006 — Relating issues: subtasks and links

**Status:** Implemented (PR #7)
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-04

## Problem

Issues can be created and edited (0004) but not related to one another, which is most of what
breaking work down actually consists of.

Two gaps of different kinds:

1. **Subtasks are possible but unreasonable.** A subtask is an ordinary issue carrying a
   `parent`, so it already works — but only by hand-writing the whole request body:
   `--body '{"fields":{"project":{"key":"PROJ"},"issuetype":{"name":"Subtask"},"parent":{"key":"PROJ-1"},"summary":"…"}}'`.
   Every other common field has a flag; this one, which is the entire point of a subtask, does
   not.
2. **Links are not possible at all.** Unlike subtasks there is no workaround, because a link
   is not a field on an issue: it is a separate resource created through `/rest/api/2/issueLink`
   with its own type vocabulary from `/rest/api/2/issueLinkType`. This is also a parity gap —
   `kaichen/atlassian-cli` has link types, create, and remove.

Links carry the one genuinely error-prone thing in this doc: **direction**. "A blocks B" and
"B blocks A" are opposite claims about the world, and the API expresses the distinction as
`inwardIssue` versus `outwardIssue` — a naming that says nothing about which is which to
anyone who has not read the reference twice. Getting it backwards produces a link that exists,
looks plausible, and states the opposite of what was meant. Nothing errors.

## Decision

Add `--parent` to `issue create`, and four link commands. The link commands take direction the
way a person would say it out loud, resolving the API's inward/outward themselves:

```
simply atlassian jira issue link create PROJ-1 blocks PROJ-2
simply atlassian jira issue link create PROJ-2 "is blocked by" PROJ-1     # the same fact
```

Both forms are accepted because both are natural, and a phrase that names the _inward_
direction flips the pair rather than being rejected. The type argument matches — case- and
whitespace-insensitively — against the link type's name, its outward phrase, or its inward
phrase, and an unmatched value lists what the instance actually offers, exactly as the
transition lookup in 0004 does.

| Command                                | Kind  |
| -------------------------------------- | ----- |
| `issue link types`                     | read  |
| `issue link list <issue>`              | read  |
| `issue link create <from> <type> <to>` | write |
| `issue link delete <link-id>`          | write |

## Behavior

### `--parent` on `issue create`

```
simply atlassian jira issue create --project PROJ --type Subtask --parent PROJ-1 --summary "…"
```

Maps to `fields.parent = { key: … }`. It is not validated against the issue type: Jira itself
rejects a parent on a non-subtask type, and on team-managed projects `parent` is also how an
issue is placed under an epic — so second-guessing the caller would break a legitimate use.

`issue view` gains a `Parent` row, shown only when the instance reports one. Without it the flag
would be a write with no way to read it back through the CLI — the parent would be set, correctly,
and invisible.

### Direction, concretely

Jira's model, stated once so the implementation has something to be checked against — and stated
carefully, because the field names actively mislead. Two facts from Atlassian's issue-linking
reference:

1. A link is stored as a pair of ends, `inwardIssue` and `outwardIssue`.
2. When rendering issue X's links, _"if the issue link data contains an `inwardIssue` field, the
   link should be labeled with the value of the `type.inward` field."_

Put together: the issue sitting in the `outwardIssue` field is labeled with the **inward** phrase.
So for the `Blocks` type (outward `blocks`, inward `is blocked by`), the subject of "blocks" is
whatever went into `inwardIssue` — not, as the name suggests, `outwardIssue`:

| Intent            | inwardIssue | outwardIssue |
| ----------------- | ----------- | ------------ |
| A blocks B        | A           | B            |
| A is blocked by B | B           | A            |

This was established empirically rather than reasoned about, because reasoning about it is how it
goes wrong: a link created as `outwardIssue: A, inwardIssue: B` reads back, from A's own side, as
`inwardIssue: B` — which by the rule above labels as **"A is blocked by B"**. The first draft of
this document asserted the opposite, and nothing about the payload would have revealed the error,
since both readings of the JSON are internally consistent. Only the labeling rule distinguishes
them.

So `issue link create A blocks B` sends `inwardIssue: A, outwardIssue: B`, and
`issue link create A "is blocked by" B` sends the pair reversed. A test asserts this mapping
against the exact bytes, and a live round-trip re-reads the link from both issues' sides to
confirm Jira agrees.

The type goes out as its **id**, not its name, whenever the instance supplies one. A name is a
mutable string the server re-resolves, so posting it reopens the question the phrase match just
answered — a rename between the lookup and the post, or two types sharing a name, would land a
different relationship than the one matched.

Two kinds of ambiguity are refused rather than guessed. An outward phrase is preferred over an
inward one across all types, since the outward form is how anyone states a relationship out loud;
but a **name** and a **phrase** are different kinds of token, so when they point at different
types there is no principled winner and the command says so. A symmetric type — `Relates`, whose
phrases are identical — is not ambiguous: either orientation is the same fact.

`link list` renders the reverse mapping, and where the instance gives it nothing to work with —
a type missing or blanking the phrase for that direction — it says `is linked to` rather than
falling back to the type name. The name would read as the _outward_ phrase, so an inward end
labelled `Blocks` states the reverse of the truth; asserting no direction is the only safe answer.

### `issue link types`

`GET /issueLinkType`. Prints the name alongside both phrases, because the phrases are what
`link create` accepts and they are not guessable from the name — `Duplicate` offers
`duplicates` and `is duplicated by`.

### `issue link list <issue>`

Reads the `issuelinks` field. Each row shows the link id, the relationship as a phrase, and the
other issue with its status and summary — phrased from the perspective of the issue asked
about, so a reader does not have to work out which side they are on:

```
ID     RELATIONSHIP     ISSUE     STATUS       SUMMARY
10201  blocks           PROJ-4    To Do        Ship the thing
10202  is blocked by    PROJ-2    In Progress  Land the migration
```

The id column exists for the same reason `comment list`'s does: `link delete` needs it and
nothing in the UI shows it.

Both read commands take `--limit` (default 25), like every other list here. Neither endpoint
paginates — `issuelinks` arrives whole, and `GET /issueLinkType` is a single list — and anyone
with "Link issues" on a project can attach thousands of links to an issue, so an unbounded render
is a way to flood the caller's context. `--json` still carries the entire payload.

### `issue link create` and `delete`

Both are writes: `static isWrite = true`, so 0004's read-only guard covers them, and both take
`--dry-run`.

`link create` also takes `--comment`, which Jira attaches to the link itself rather than to
either issue — the natural place to record _why_ two issues are related, which the relationship
phrase alone cannot carry. It is wrapped for the deployment the same way a description is: ADF on
Cloud, plain text on Server/DC.

`link delete` resolves the link before touching it, so both the dry run and the result name the
relationship rather than only its id:

```
Deleted link 10003: PROJ-1 blocks PROJ-2.
```

That costs one extra request and it is what makes the next paragraph true. A link id is
instance-global — it identifies nothing on its own, and after deletion the link is gone from both
issues, so this line is the only surviving record of what was removed. An agent told by some
issue comment to "remove the bogus link 10357" would otherwise delete a relationship it never
identified. The id is also shape-checked as numeric, so an issue key passed here is a usage error
rather than a 404 that reads as though the link were already gone.

`link delete` does **not** require `--confirm`. 0004's rule, as sharpened in 0005, is that
`--confirm` guards irreversible loss of data — and a deleted link is re-creatable in one command
from the line above. Attaching `--confirm` to something trivially reversible is how the flag stops
meaning anything on the commands where it matters.

Re-creating a link that already exists is not an error and not a duplicate: Jira answers 201 and
leaves the single link in place. The CLI does not try to distinguish the two cases, because
doing so would cost an extra request on every create to report a difference that changes
nothing — the state afterwards is what the summary says either way.

### Output and errors

Unchanged from 0002, 0004, and 0005: human-friendly tables by default, `--json` returning the
raw payload, one JSON object on stderr for failures, exit 2 config or usage, 3 auth, 1
everything else. Server-supplied text — summaries, status names, link phrases — goes out
sanitised.

## Alternatives considered

- **Exposing `inwardIssue`/`outwardIssue` as flags**, mirroring the API. Honest to the wire and
  hostile to everyone: it makes the caller learn a distinction the API invented, and it is
  precisely the confusion that produces backwards links. The natural-language form cannot be
  got wrong in the same silent way.
- **Accepting only the type name** (`Blocks`) and a separate `--direction` flag. Two arguments
  to express one fact, and `--direction inward` is no clearer than `inwardIssue`.
- **Validating `--parent` against the issue type** before sending. Rejected: Jira's own error
  is accurate and current, ours would encode assumptions that are already false for
  team-managed projects, where `parent` links an issue to an epic.
- **`--confirm` on `link delete`.** Rejected per the sharpened rule above.
- **A `--link` flag on `issue create`**, creating an issue and linking it in one step. Appealing
  for the agent case — "break this page into tickets, each blocking the next" — but it makes
  `create` partially succeed in a new way: the issue exists, the link failed, and the exit code
  can only describe one of those. Better as two commands the caller can sequence and check.
  Worth revisiting if that sequencing turns out to be painful in practice.

## Implementation plan

1. `src/core/jira-client.ts` — `getLinkTypes()`, `createIssueLink(body)`, `deleteIssueLink(id)`.
   Reads of an issue's links need no new method: `issuelinks` comes back from `getIssue`.
2. `src/shared/issue-links.ts` — `resolveLinkDirection(types, from, phrase, to)`: matches the
   phrase against name, outward, or inward, returns `{ type, inwardIssue, outwardIssue }`, and
   raises a `ConfigError` listing the available types when nothing matches.
3. `src/commands/atlassian/jira/issue/link/{types,list,create,delete}.ts`
4. `--parent` added to `issue create`, and a `Parent` row to `issue view`.
5. `oclif.topics` gains `atlassian:jira:issue:link`; regenerate `command-snapshot.json` and the
   README.

## Testing

- **resolveLinkDirection:** an outward phrase keeps the pair; an inward phrase reverses it; the
  type name alone is treated as outward; matching is case- and whitespace-insensitive; a
  symmetric type (`Relates`, whose phrases are identical) resolves without ambiguity; an
  unmatched phrase lists every available type, capped; a phrase matching two types errors rather
  than guessing; a name colliding with another type's phrase errors rather than picking one; a
  type with neither id nor name is refused.
- **link create:** the request body carries the resolved pair, asserted against the exact bytes;
  both phrasings of one fact produce an identical body; `--comment` is wrapped for the
  deployment; `--dry-run` sends nothing; an unmatched phrase lists the available types; the
  read-only guard refuses it before any request.
- **link list:** phrases are rendered from the asked-about issue's perspective; an issue with no
  links says so; a link missing its type or counterpart issue does not crash the row.
- **link delete:** the id reaches the URL; the relationship is named in both the dry run and the
  result; an issue key passed as an id is a usage error that sends nothing; the read-only guard
  refuses it before any request; `--dry-run` deletes nothing.
- **link list / link types:** every column is asserted against rendered output rather than
  against the mock payload, since a payload assertion checks the mock against itself; `--limit`
  caps the render and reports the true total; a missing phrase renders as no direction.
- **`--parent`:** reaches `fields.parent.key`, and merges with `--body` the way other typed
  flags do; `issue view` shows the parent when there is one and omits the row when there is not.
- **live:** against a real instance — list types, create a subtask under a parent, link two
  issues in both phrasings and confirm the direction is right _as Jira reports it back_, list
  the links, delete one, and leave the sandbox clean.

## Open questions

- **Whether `link list` belongs on `issue view` instead**, as an extra section rather than its
  own command. Separate for now, because `view`'s output is already long and links have an id
  column that only matters when deleting.
- **Remote links** (`/issueLink` covers issue-to-issue only; `/remotelink` handles links to
  URLs and Confluence pages). Out of scope here, but they are the natural way to connect a
  ticket back to the page it came from — which is the workflow this tool exists to serve, so
  worth its own doc soon.
