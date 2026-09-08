---
title: MCP server
description: Give an AI agent in Claude Desktop, Claude Code, or Cursor the Simply Atlassian CLI as Model Context Protocol tools, read-only by default.
---

`@simplysf/simply-atlassian-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io/)
server that exposes every CLI command as an MCP tool. It runs the CLI itself for each call, so the
agent gets the same credential handling, `--dry-run` previews, read-only guard, and error messages
described elsewhere in these guides, and the same raw JSON the CLI prints with `--json`.

```sh
npm install -g @simplysf/simply-atlassian-mcp
```

## Configure a client

Add the server to your MCP client and give it the connection settings from
[Credentials](/guides/credentials/), either as environment variables or as a file. For Claude
Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "simply-atlassian": {
      "command": "simply-atlassian-mcp",
      "args": ["--env-file", "/home/me/atlassian.env"]
    }
  }
}
```

For Claude Code:

```sh
claude mcp add simply-atlassian -- simply-atlassian-mcp --env-file ~/atlassian.env
```

## Read-only by default

Started without options, the server registers only the read tools, and every CLI call it makes
runs with `ATLASSIAN_READ_ONLY=1`. Start it with `--allow-writes` to also register the tools that
create, update, transition, comment, link, and delete.

That mirrors the two-credential-file arrangement in [Write safety](/guides/write-safety/): give the
agent's everyday server a read-scoped token, and configure a second server entry with
`--allow-writes` and a write-capable token only when a person means to let the agent write. A
read-scoped token is still the only layer that binds; the server-side default just keeps write
tools out of the agent's normal loop entirely.

With writes allowed:

- every write tool accepts `dryRun: true`, which returns the request that would be sent without
  sending it;
- `jira_issue_delete` and `jira_issue_comment_delete` also require `confirm: true`, and a call
  without it is refused before the CLI runs.

## Tools

| Read tools                 | Write tools (`--allow-writes`)                |
| -------------------------- | --------------------------------------------- |
| `jira_whoami`              | `jira_issue_create`                           |
| `jira_user_search`         | `jira_issue_update`                           |
| `jira_user_view`           | `jira_issue_transition`                       |
| `jira_issue_search`        | `jira_issue_delete` (needs `confirm`)         |
| `jira_issue_view`          | `jira_issue_comment_add`                      |
| `jira_issue_transitions`   | `jira_issue_comment_edit`                     |
| `jira_issue_comment_list`  | `jira_issue_comment_delete` (needs `confirm`) |
| `jira_issue_link_list`     | `jira_issue_link_create`                      |
| `jira_issue_link_types`    | `jira_issue_link_delete`                      |
| `confluence_page_get`      |                                               |
| `confluence_page_search`   |                                               |
| `confluence_page_children` |                                               |

Each tool's inputs are the command's arguments and flags in camel case; see the
[Command Reference](/reference/) for what each does. `fields` on the issue tools matters as much
here as in the CLI: raw issue payloads are large, and an agent pays for every token it reads.

## Results and errors

A successful call returns the CLI's `--json` output verbatim. A failure returns an error result
whose text is a JSON object with a stable `code`:

| `code`             | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `config`           | Missing or contradictory settings, a refused write, bad input.        |
| `auth`             | The instance rejected the credentials.                                |
| `error`            | Any other CLI failure, including an API error with its HTTP `status`. |
| `confirm-required` | A destructive tool was called without `confirm: true`.                |
| `timeout`          | The call overran the server's `--timeout` (default 60 seconds).       |
| `server`           | The CLI process could not be started.                                 |

The first three map one-to-one onto the CLI's exit codes 2, 3, and 1, described in
[Scripts and agents](/guides/scripting/).

## Options

```
simply-atlassian-mcp [--allow-writes] [--env-file <path>] [--timeout <ms>]
```

`--help` prints the options and the full tool list. Because stdout is the protocol stream, it
prints to stderr.
