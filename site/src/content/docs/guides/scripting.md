---
title: Scripts and agents
description: The output contract that makes the Simply Atlassian CLI safe to drive from a shell script or an AI agent - raw JSON, stable exit codes, no prompts.
---

The CLI is designed for two callers at once: a person at a terminal, and a script or AI agent
running it as shell commands. The defaults serve the person; a small, stable contract serves the
script.

## `--json` returns the raw API payload

Every command accepts `--json`, without exception. The output is the unmodified response from the
Atlassian API — the full object, not the curated subset the human view shows — so anything the API
exposes is reachable with `jq` and the payload shape is Atlassian's contract rather than this CLI's.

```sh
simply atlassian jira issue view PROJ-1 --json | jq -r '.fields.status.name'
```

The one exception is a command that follows pages. `jira issue search` (and the Confluence `page
search` and `page children` commands) make several requests, so there is no single response to hand
back. They return an envelope instead:

```json
{ "issues": [...], "total": 120, "pages": 3, "complete": false }
```

The elements inside are still raw API objects. `complete: false` means `--limit` cut the results
short, so a caller can detect truncation without counting rows. `total` is present only when the
instance reports one: Server/Data Center does, Jira Cloud's search endpoint does not.

## Keep payloads small with `--fields`

Raw Jira issue payloads are large, and an agent pays for every token it reads. `--fields` on the
issue commands requests only the named fields:

```sh
simply atlassian jira issue search --jql "project = PROJ AND sprint in openSprints()" \
  --fields key,summary,status,assignee --limit 100 --json
```

## Exit codes and errors

Errors carry no stack trace and map to stable exit codes:

| Exit code | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| `0`       | Success                                                 |
| `2`       | Configuration problem, e.g. a missing URL or token      |
| `3`       | Authentication or authorization failure                 |
| `1`       | Anything else, including an API error or an unknown key |

Under `--json`, a failure is written as one JSON object on **stderr** and stdout stays empty, so a
caller that captures stdout never has to disambiguate an error from a payload. Error messages are
scrubbed of any known credential value and of terminal control characters before they are emitted.

```sh
if ! out=$(simply atlassian jira issue view PROJ-999 --json 2>err.json); then
  case $? in
    3) echo "credentials rejected";;
    *) jq -r .message err.json;;
  esac
fi
```

## Never interactive

No command prompts or blocks on stdin. A destructive command that wants a safety check takes an
explicit flag (`--confirm` on the delete commands), because a hung prompt is a hung agent. See
[Write safety](/guides/write-safety/) for the full set of layers and for the two-credential-file
arrangement that keeps an agent's normal loop read-only.

## Help is discovery

`--help` output is generated from the command classes and written to be self-sufficient, so an
agent can discover flags and examples the same way a person does:

```sh
simply atlassian jira issue --help
simply atlassian jira issue transition --help
```

The same text, for every command, is on the [Command Reference](/reference/) pages.
