---
title: Credentials
description: How the Simply Atlassian CLI finds its connection settings, and how flags, environment variables, and an env file take precedence.
---

Connection settings come from environment variables, or from a `.env` file named with
`-e/--env-file`. Only Atlassian connection variables are read from that file; anything else in it
is ignored.

```
SIMPLY_JIRA_URL=https://your-site.atlassian.net
SIMPLY_JIRA_USERNAME=you@example.com          # Cloud
SIMPLY_JIRA_API_TOKEN=...                     # Cloud
SIMPLY_JIRA_PERSONAL_TOKEN=...                # Server/Data Center, instead of the two above

SIMPLY_CONFLUENCE_URL=https://your-site.atlassian.net
SIMPLY_CONFLUENCE_USERNAME=you@example.com     # Cloud
SIMPLY_CONFLUENCE_API_TOKEN=...                # Cloud
SIMPLY_CONFLUENCE_PERSONAL_TOKEN=...           # Server/Data Center, instead of the two above
```

## Renamed variables

Every variable now starts with `SIMPLY_`. The unprefixed names — `JIRA_URL`, `JIRA_USERNAME`,
`JIRA_API_TOKEN`, `JIRA_PERSONAL_TOKEN`, `JIRA_SSL_VERIFY`, their `CONFLUENCE_*` counterparts, and
`ATLASSIAN_READ_ONLY` — are shared with other Atlassian tools, so a shell set up for one of those
quietly configured this CLI as well.

The old names are deprecated, not yet removed. Each still works while its `SIMPLY_` name is unset,
and a command that relies on one prints a warning to stderr naming the rename. Once both are set the
`SIMPLY_` name wins and the old one is ignored without comment, so another tool can keep its own
`JIRA_URL`. The unprefixed names will stop working in a future major release; rename them, in your
shell and in any `.env` file, by adding the prefix.

## Precedence

Explicit flags beat the environment, which beats the file's contents. That ordering is what makes
the two-file arrangement described in [Write safety](/guides/write-safety/) work: a read-scoped file
can be the default, and a write-capable one is named explicitly for the one command that needs it.

```sh
simply atlassian jira issue search -e ~/atlassian.env --jql "project = PROJ"
```

## Cloud versus Server/Data Center

Jira Cloud authenticates with your account email plus an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens) (`SIMPLY_JIRA_USERNAME` and
`SIMPLY_JIRA_API_TOKEN`). Server and Data Center use a personal access token on its own
(`SIMPLY_JIRA_PERSONAL_TOKEN`) in place of those two. Set one style or the other, not both. Confluence
works the same way with the `SIMPLY_CONFLUENCE_*` names.

Server/Data Center support is implemented but has not yet been verified against a live instance.

## Certificate verification

Certificate verification is always on. For an instance behind an internal or agency certificate
authority, trust that CA rather than disabling verification:

```sh
NODE_EXTRA_CA_CERTS=/path/to/ca.pem simply atlassian jira whoami
```

A `SIMPLY_JIRA_SSL_VERIFY=false` or `SIMPLY_CONFLUENCE_SSL_VERIFY=false` carried over from other Atlassian
tooling is rejected with an error rather than silently ignored, so nobody ends up believing
verification is off when it is on, or the reverse.

## Checking what you're connected as

```sh
simply atlassian jira whoami
```

reports the account the current credentials resolve to. A `403` from a read-scoped token is
reported as an authentication error saying the credential cannot make changes, so a refused write
is distinguishable from a genuine permissions problem.
