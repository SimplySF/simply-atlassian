---
title: Get Started
description: Requirements, installation, and a first command for the Simply Atlassian CLI.
---

## Requirements

- Node.js 22 or later
- A Jira Cloud and/or Confluence Cloud site, with an API token for your account. Server/Data Center
  is implemented but not yet verified against a live instance.

## Install

```sh
npm install -g @simplysf/simply-atlassian
```

## Verify it worked

```sh
simply atlassian --help
```

## Connect to your instance

Every command reads its connection settings from environment variables, or from a `.env` file
passed with `-e/--env-file`. The minimum for Jira Cloud:

```
JIRA_URL=https://your-site.atlassian.net
JIRA_USERNAME=you@example.com
JIRA_API_TOKEN=...
```

Confluence uses the matching `CONFLUENCE_URL`, `CONFLUENCE_USERNAME`, and `CONFLUENCE_API_TOKEN`.
See [Credentials](/guides/credentials/) for Server/Data Center tokens, precedence between flags,
environment, and file, and how to trust an internal certificate authority.

## First commands

Confirm which account you're authenticated as, then run a search:

```sh
simply atlassian jira whoami
simply atlassian jira issue search --jql "project = PROJ AND statusCategory != Done"
```

Add `--json` to either to get the raw API payload instead of the formatted table.

## Where to go next

- The [Command Reference](/reference/) lists every command by topic, with its flags and examples.
- [Write safety](/guides/write-safety/) explains `--confirm`, `--dry-run`, `ATLASSIAN_READ_ONLY`,
  and why a read-scoped token is the only one of those that actually binds.
- [Scripts and agents](/guides/scripting/) covers the `--json` contract and exit codes.
- [MCP server](/guides/mcp-server/) gives an AI agent the same commands as tools, read-only by
  default.
- Want to contribute? See
  [CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) in the
  repo.
