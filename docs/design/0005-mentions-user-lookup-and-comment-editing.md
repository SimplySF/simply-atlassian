# 0005 — Mentions, user lookup, and comment editing

**Status:** Implemented (PR #6)
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-04

## Problem

Comments can be added (0004) but not made genuinely usable. Three gaps, and they share a root
cause:

1. **A mention needs an account id, not a name.** Writing `@joe` in a comment produces the
   literal text `@joe`; a real mention is a structured node carrying an id
   (`70121:8d8e...`). So the useful form — "mention this person by name" — requires resolving a
   name to an id, and nothing in the CLI can do that today. Mentions are already possible
   through `--body-file` for anyone who knows the id, which is precisely the audience that
   does not need help.
2. **There is no way to look a person up at all**, which is also a parity gap:
   `kaichen/atlassian-cli` exposes a user command and this CLI does not.
3. **A comment cannot be corrected or withdrawn.** Jira supports both; neither is implemented,
   and neither is in the reference tool.

Resolving a name to an id is the shared dependency, and it carries the one genuinely dangerous
failure mode in this doc: **a query that matches several people.** Silently picking the first
match is how the wrong person gets mentioned — or, worse for an agent-driven tool, how the
wrong person is notified about work they have no context for. The design has to answer that
explicitly rather than by accident.

## Decision

Add a user lookup, use it to resolve mentions written by name, and complete the comment
lifecycle:

| Command                                                           | Kind                     |
| ----------------------------------------------------------------- | ------------------------ |
| `simply atlassian jira user search`                               | read                     |
| `simply atlassian jira user view <account>`                       | read                     |
| `simply atlassian jira issue comment edit <issue> <comment-id>`   | write                    |
| `simply atlassian jira issue comment delete <issue> <comment-id>` | write, needs `--confirm` |

And extend `comment add`/`edit` with `--mention`, which resolves a name and **refuses on
ambiguity**, listing the candidates so the caller can retry precisely — the same
self-correcting shape as the transition-name lookup in 0004, which live testing showed is the
failure an agent recovers from most easily.

## Behavior

### Mentions

`--mention` is repeatable and accepts either an account id (used as-is) or a search term
(resolved). Each resolved mention is appended to the comment body, after the text.

An account id is recognised by shape, and Cloud uses more than one: `70121:8d8e…`, `qm:8b1e…`,
and a colon-less 24-character alphanumeric form such as `5b10a2844c20165700ede21g` — which is
alphanumeric rather than hex, since Atlassian's own documented example ends in `g`. A shape
this does not recognise can be forced through with the `account:` prefix, so a valid id is
never searched as though it were a name. An id passed this way carries no display name, and
the mention omits its fallback text rather than rendering the id where a name belongs.

```
simply atlassian jira issue comment add PROJ-1 --text "ready for review" --mention ada@example.com
simply atlassian jira issue comment add PROJ-1 --text "see above" --mention 70121:8d8e579e-...
```

| Situation                | Result                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| Exactly one active match | mention appended                                                      |
| No match                 | `ConfigError` naming the query, suggesting an email or `account:<id>` |
| Only deactivated matches | `ConfigError` saying so — they would never be notified                |
| Several active matches   | `ConfigError` listing candidates one per line, by id and name         |

Deactivated accounts are filtered out before the count is taken. Without that, a person with
an old duplicate account makes their own email address ambiguous, and a lone deactivated match
would resolve silently to an account that never receives the notification.

The candidate list is capped, and deliberately does **not** quote email addresses. The account
id is the entire remediation — the message tells the caller to pass one — so an address adds
nothing, and this is a path the operator did not ask for: they asked to post a comment, and a
long list of colleagues' addresses is not a reasonable thing to hand back, least of all into an
agent's context.

An email address is the term most likely to be unique and is the recommended form; the
`--help` text says so.

Appending rather than interpolating is deliberate. Substituting `@name` inside `--text` reads
better, but it means scanning caller text for something that looks like a mention — and a
comment that legitimately contains an email address or an `@handle` would then trigger a
lookup, or worse, a mention nobody asked for. Appending keeps the text the caller wrote
exactly as written. Interpolation can be revisited once mentions have been used in anger.

The deployment is read from the client, never inferred from the body's shape. That distinction
is not cosmetic: inferring it — "this body is a string, so the instance must be Server" — meant
a string body on Cloud silently dropped every mention, and an ADF body on Server silently
replaced the caller's entire comment with a bare mention token. Both were losses on a write
path with no error at all. A string body on Cloud is now promoted to ADF so the text survives
alongside the mentions, and a body Server cannot read is refused rather than discarded.

The shape differs by deployment and the client owns the difference, as it does for
descriptions:

| Deployment | Mention                                                              |
| ---------- | -------------------------------------------------------------------- |
| Cloud      | ADF node `{ type: 'mention', attrs: { id, text: '@Display Name' } }` |
| Server/DC  | the wiki-markup token `[~username]` appended to the text             |

### User lookup

**`jira user search <query>`** — `GET /user/search` on Cloud (`query`), `GET /user/search`
with `username` on Server/DC. Prints account id, display name, email, and active state.
The account id column is the point: it is what every other command needs and what no one can
guess.

**`jira user view <account>`** — one user by account id (Cloud) or username (Server/DC),
matching how 0001's config already distinguishes the two.

Email visibility is a per-user privacy setting on Cloud, so the email column is frequently
empty. That is worth stating in the help text rather than letting it read as a bug.

### Comment editing and deletion

**`comment edit <issue> <comment-id>`** — `PUT /issue/{key}/comment/{id}`. Takes the same
`--text`, `--mention`, `--body`, `--body-file`, and `--dry-run` as `comment add`. It
**replaces** the body rather than appending to it, which the summary states outright: an edit
that silently appended would be a surprising way to lose a comment's meaning.

Because it replaces, `--mention` may not stand alone here — it must accompany `--text` or a
body. Allowing it alone meant posting a bare mention over whatever the comment previously
said, which nobody would ask for on purpose.

**`comment delete <issue> <comment-id>`** — `DELETE /issue/{key}/comment/{id}`, requires
`--confirm`, since a deleted comment is not recoverable through the API. Same reasoning as
`issue delete` in 0004: `--confirm` is attached only to what cannot be undone.

Both declare `static isWrite = true`, so 0004's read-only guard covers them without either
command doing anything.

### Output and errors

Unchanged from 0002 and 0004. `comment list`'s `ID` column is what makes `edit` and `delete` usable at all — the id is not
otherwise discoverable from the UI.

Its preview column renders a mention by its display text. A mention node carries no `text` of
its own, only `attrs.text`, so without handling it explicitly a comment reading "please review
@Ada" previewed as "please review" — hiding the one thing a reader most wants to know, which is
who was notified — and a mention-only comment previewed as empty. Under `--dry-run` the request
body is sanitised before printing rather than merely serialised: a display name is chosen by
its account's owner, and `JSON.stringify` escapes C0 controls while leaving C1, bidi, and
zero-width characters intact, so a preview could otherwise show a reviewer something other than
what would be sent.

## Alternatives considered

- **Interpolating `@name` inside `--text`.** Nicer to type, but it requires deciding whether
  any given `@something` in caller text is a mention. A comment quoting an email address, a
  handle, or a shell variable would misfire, and the failure is a notification sent to a real
  person. Rejected for now; `--mention` is unambiguous, and the ergonomic version can be added
  later without changing the flag.
- **Resolving a mention silently to the first match.** Rejected outright. It is the one
  behaviour here that can do social damage, and it fails silently, which is the worst
  combination. Ambiguity is an error.
- **Caching user lookups.** A mention costs one extra request. Caching adds staleness and a
  cache to invalidate, for a saving nobody has measured. Skipped.
- **`comment delete` without `--confirm`.** Rejected for consistency with 0004: a comment
  cannot be recovered, so it belongs in the same category as an issue.
- **`--confirm` on `--mention`.** Raised in review, and it has a real argument behind it: 0004's
  rule is that `--confirm` guards what cannot be undone, and a notification cannot be unsent —
  deleting the comment does not recall the email. Rejected, but the rule needs sharpening rather
  than hand-waving: `--confirm` guards irreversible **loss of data**, not every irreversible
  side effect. Mentioning a colleague is a routine, expected part of commenting, and a flag
  required on a routine action is passed reflexively — which is exactly how a confirmation
  becomes a rubber stamp, the failure 0004 set out to avoid. The genuine protection against an
  unwanted notification is the same as for any other write: a read-scoped token, and `--dry-run`
  when a person wants to look first.
- **A `--visibility` flag** restricting a comment to a role or group. Real, and supported by
  the API, but it needs role and group lookups of its own to be usable, and it is orthogonal
  to everything here. Left for a later doc; `--body` already reaches it.

## Implementation plan

1. `src/core/jira-client.ts` — `searchUsers(query, limit)`, `getUser(account)`,
   `updateComment(issueKey, commentId, body)`, `deleteComment(issueKey, commentId)`, and a
   `mentionValue(accountId, display)` that returns the deployment-appropriate shape.
2. `src/shared/mentions.ts` — `resolveMentions(client, terms)`: an account id passes through, a
   term is searched, and ambiguity or absence raises a `ConfigError` naming the candidates.
3. `src/commands/atlassian/jira/user/{search,view}.ts`
4. `src/commands/atlassian/jira/issue/comment/{edit,delete}.ts`
5. `--mention` added to `comment add` and `comment edit`.
6. `oclif.topics` gains `atlassian:jira:user`; regenerate `command-snapshot.json` and the
   README.

## Testing

- **resolveMentions:** an account id passes through without a lookup; one match resolves;
  zero matches names the query; several matches list every candidate's id; an empty term is
  refused.
- **mentionValue:** ADF node on Cloud, `[~username]` on Server/DC.
- **user search / view:** results render; an empty result set is not an error; a missing user
  exits 1 with the API's message; the email column tolerates a user who hides it.
- **comment edit:** replaces the body; `--dry-run` sends nothing; a nonexistent comment id
  exits 1.
- **comment delete:** refused without `--confirm`, naming the comment; `--dry-run` sends
  nothing; the read-only guard refuses it before any request.
- **live:** against a real instance — add a comment with a mention resolved by email, verify
  the mention renders as a pill rather than text, edit it, then delete it, leaving the sandbox
  clean. This happened, and is also how the preview bug was caught: a live listing showed the
  mention missing from the preview column, in output that had already been read once without
  anyone noticing.

## Open questions

- **Whether `user search` should exist on Confluence too.** The endpoint differs and the
  account ids are shared on Cloud, so `jira user search` is probably sufficient for both;
  worth revisiting if Confluence-specific lookup is ever needed.
- **Mentioning someone who cannot see the issue.** Jira accepts the mention and the person
  gets a notification they cannot act on. Detecting that needs a permission check per
  mention, which seems disproportionate — but it is a real way to leak an issue's existence,
  and worth a second look if the tool is ever pointed at a restricted project.
