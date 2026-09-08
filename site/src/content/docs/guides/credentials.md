---
title: Credentials
description: How the Simply Atlassian CLI finds its connection settings, and how flags, environment variables, and an env file take precedence.
---

Connection settings come from environment variables, or from a `.env` file named with
`-e/--env-file`. Only Atlassian connection variables are read from that file; anything else in it
is ignored.

```
JIRA_URL=https://your-site.atlassian.net
JIRA_USERNAME=you@example.com          # Cloud
JIRA_API_TOKEN=...                     # Cloud
JIRA_PERSONAL_TOKEN=...                # Server/Data Center, instead of the two above

CONFLUENCE_URL=https://your-site.atlassian.net
CONFLUENCE_USERNAME=you@example.com
CONFLUENCE_API_TOKEN=...
```

## Precedence

Explicit flags beat the environment, which beats the file's contents. That ordering is what makes
the two-file arrangement described in [Write safety](/guides/write-safety/) work: a read-scoped file
can be the default, and a write-capable one is named explicitly for the one command that needs it.

```sh
simply atlassian jira issue search -e ~/atlassian.env --jql "project = PROJ"
```

## Cloud versus Server/Data Center

Jira Cloud authenticates with your account email plus an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens) (`JIRA_USERNAME` and
`JIRA_API_TOKEN`). Server and Data Center use a personal access token on its own
(`JIRA_PERSONAL_TOKEN`) in place of those two. Set one style or the other, not both.

Server/Data Center support is implemented but has not yet been verified against a live instance.

## Certificate verification

Certificate verification is always on. For an instance behind an internal or agency certificate
authority, trust that CA rather than disabling verification:

```sh
NODE_EXTRA_CA_CERTS=/path/to/ca.pem simply atlassian jira whoami
```

## Checking what you're connected as

```sh
simply atlassian jira whoami
```

reports the account the current credentials resolve to. A `403` from a read-scoped token is
reported as an authentication error saying the credential cannot make changes, so a refused write
is distinguishable from a genuine permissions problem.
