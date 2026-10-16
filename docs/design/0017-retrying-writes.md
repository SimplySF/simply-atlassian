# 0017 — Retrying only the writes that cannot have landed

**Status:** Draft
**Package:** `packages/simply-atlassian-core`
**Date:** 2026-10-16

## Problem

`HttpTransport` (0001) retries a 429, a 5xx, and a transient connection failure for every call,
up to three attempts. For a read that is harmless. For a write it is not, because a 5xx or a
dropped connection can arrive **after** the instance has applied the change: a gateway or load
balancer gives up on a slow backend and answers `502`/`504`, or the connection drops while the
response is in flight. Retrying then sends the same write a second time.

What that does depends on the write:

| Write                                                                     | Effect of a second send                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `jira issue create`, `issue comment add`, `sprint create`, `page comment` | a duplicate, and the caller sees only the second      |
| `jira issue remotelink create` without a `globalId`                       | a duplicate                                           |
| `confluence page update`                                                  | `409` on the stale version, for a change that landed  |
| `confluence page create`                                                  | `400` title clash, for a page that now exists         |
| any delete                                                                | `404`, for a delete that succeeded                    |
| `jira issue transition`                                                   | the transition is no longer valid from the new status |
| `issue update`, `comment edit`, label add, sprint add                     | nothing: these converge                               |

Against a local server that applies each `POST /issue` and answers the first with a `502`, a
`504`, or a reset socket, one `jira issue create` made two issues and reported only the second.
The false failures are as bad for an agent as the duplicates: an agent told a page update failed
retries it.

Behind a corporate proxy or a Data Center load balancer, which is where this CLI is aimed, a
gateway timeout is not rare.

## Decision

A call that declares itself `mutating` — every write already does, for the 403 hint in 0001 — is
retried only on a failure that proves the instance did not act. Any other failure ends the call at
once, and its message says the change may have been applied so that neither a person nor an agent
repeats it blind. Reads keep the 0001 policy unchanged.

## Behavior

| Failure on a `mutating` call | Retried?       | Message ends with                                          |
| ---------------------------- | -------------- | ---------------------------------------------------------- |
| `429`                        | yes            | —                                                          |
| connection refused           | yes            | —                                                          |
| `5xx`                        | no             | `The change may have been applied; check before retrying.` |
| connection reset / dropped   | no             | `The change may have been applied; check before retrying.` |
| timeout                      | no (as before) | `The change may have been applied; check before retrying.` |

The error types and exit codes do not change: a 5xx is still an `HttpError` and a transport failure
a `NetworkError`, both exit code `1` and MCP code `error`. Only the retry count and the sentence
differ.

A `429` is safe because Atlassian rate-limits before doing any work. A refused connection is safe
because the request never reached the instance. A timeout was never retried; it now says the same
thing, because a slow write is exactly the one most likely to have landed.

## Alternatives considered

- **A list of writes that are safe to repeat.** `issue update`, `comment edit`, label adds, and
  sprint adds converge, so they could keep retrying a 5xx. Rejected: it is a second list to keep
  correct as commands are added, and an entry that is wrong fails silently, by duplicating, which
  is the bug this record fixes. One rule fails loudly, and the cost of a needless failure on a
  converging write is one check by the caller. Revisit only if a 5xx on those proves common.
- **Idempotency keys.** Jira and Confluence offer no general idempotency header; only remote links
  have an equivalent (`globalId`). Not available.
- **Look for the write, then retry.** Search for the issue just created, re-read the page version,
  and retry only if it is absent. Per-endpoint, racy against other writers, and each lookup can
  fail the same way. The caller is better placed to check, and the message tells it to.
- **Retry everything, and document it.** The status quo. A CLI built for agents should not create
  data the caller did not ask for.

## Implementation plan

`src/http.ts`: the 429/5xx outcome carries whether another attempt is safe, which `json()` honours;
`triage()` retries a mutating call's transport failure only for `ECONNREFUSED`; a shared sentence is
appended to the 5xx, transport, and timeout errors of a mutating call. 0001's retry policy points
here.

## Testing

`test/http.test.ts`, against the local server: a write is sent once on a `502`, on a dropped
connection, and on a timeout, each saying it may have been applied; a write still retries a `429`
and a refused connection, without the sentence. The existing tests pin that reads still retry a
5xx and a transient connection failure.

## Open questions

- None. Whether converging writes should keep retrying a 5xx was decided against (the first
  alternative).
