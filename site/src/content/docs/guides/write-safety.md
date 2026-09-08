---
title: Write safety
description: The layers between a Simply Atlassian command and a change to your Jira data, and which of them is a real boundary.
---

The commands that change data — `issue create`, `update`, `transition`, the comment and link
commands — and the ones that destroy it — `issue delete`, `comment delete`, `link delete` — sit
behind several layers. Only the last is a real boundary, and it is worth being clear about which is
which.

## `--confirm`

Required by the delete commands, and by nothing else. It stops accidents: a malformed command, a
mistyped key. It does not stop a caller that decides to pass it, and requiring it everywhere would
train callers to pass it always — at which point it protects nothing while still implying that it
does.

## `--dry-run`

Accepted by every write command. It prints the request that would be sent and sends nothing, which
is the cheapest way to see what is about to happen.

```sh
simply atlassian jira issue transition PROJ-1 "Done" --dry-run
```

## `ATLASSIAN_READ_ONLY`

Set it to `1`, `true`, `yes`, or `on` and every write command refuses before making any request.
Reads are unaffected. This guards against misconfiguration: the wrong credential file, the wrong
context. It is not a security boundary, because anything that can run commands can also unset an
environment variable.

## A read-scoped API token

This is the only layer that actually binds. Atlassian's scoped API tokens grant named scopes, so a
token with read scopes and no write scopes cannot create, edit, or delete anything — the instance
refuses server-side, regardless of what this CLI sends or what any caller is persuaded to attempt.

That matters most when an AI agent drives the CLI, because ticket and page text is written by
whoever can edit it, and an agent reading that text cannot reliably tell instructions from content.
The arrangement worth adopting is two credential files:

```
~/atlassian.env        # read-scoped token — what the agent uses by default
~/atlassian-write.env  # write-capable token — passed explicitly, by a person
```

```sh
simply atlassian jira issue search -e ~/atlassian.env --jql "project = PROJ"
simply atlassian jira issue delete PROJ-1 -e ~/atlassian-write.env --confirm
```

The agent's normal loop is then structurally incapable of changing anything, and a write becomes a
deliberate act. A `403` from a read-scoped token is reported as an authentication error that says
the credential cannot make changes, rather than looking like a permissions bug.
