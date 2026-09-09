# @simplysf/simply-atlassian-mcp

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian-mcp?label=@simplysf/simply-atlassian-mcp)](https://npmjs.com/@simplysf/simply-atlassian-mcp) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that gives an AI agent in
Claude Desktop, Claude Code, Cursor, or any other MCP client the same Jira and Confluence
capabilities as the [`@simplysf/simply-atlassian`](../simply-atlassian) CLI: one tool per command,
calling the same [`@simplysf/simply-atlassian-core`](../simply-atlassian-core) library in-process.
The agent gets the CLI's credential handling, `dryRun` previews, read-only guard, credential
redaction, and error messages, and the same raw JSON the CLI prints with `--json`, without a
process per call.

## Install

```bash
npm install -g @simplysf/simply-atlassian-mcp
```

## Configure an MCP client

The server speaks MCP over stdio. Point a client at the binary and give it the connection settings
the CLI reads — see the [Credentials](https://simplysf.github.io/simply-atlassian/guides/credentials/)
guide — either as environment variables or as a file. For Claude Desktop, in
`claude_desktop_config.json`:

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

Started without options, the server registers only the read tools. Start it with `--allow-writes`
to also register the tools that create, update, transition, comment, link, and delete. Even then,
`ATLASSIAN_READ_ONLY` in the environment refuses every write, exactly as it does for the CLI.

That mirrors the two-credential-file arrangement in
[Write safety](https://simplysf.github.io/simply-atlassian/guides/write-safety/): give the agent's
everyday server a read-scoped token, and configure a second server entry with `--allow-writes` and
a write-capable token only when a person means to let the agent write. A read-scoped token is
still the only layer that binds; the server-side default just keeps write tools out of the agent's
normal loop entirely.

With writes allowed:

- every write tool accepts `dryRun: true`, which returns the request that would be sent without
  sending it;
- `jira_issue_delete` and `jira_issue_comment_delete` also require `confirm: true`, and so does
  `confluence_page_delete` with `purge: true`. A call without it is refused before anything is
  looked up. Trashing a page needs no `confirm`, because it is reversible.

## Tools

| Read tools (always registered) | Write tools (`--allow-writes`)                          |
| ------------------------------ | ------------------------------------------------------- |
| `jira_whoami`                  | `jira_issue_create`                                     |
| `jira_user_search`             | `jira_issue_update`                                     |
| `jira_user_view`               | `jira_issue_transition`                                 |
| `jira_open`                    | `jira_issue_delete` (needs `confirm`)                   |
| `jira_issue_search`            | `jira_issue_comment_add`                                |
| `jira_issue_view`              | `jira_issue_comment_edit`                               |
| `jira_issue_history`           | `jira_issue_comment_delete` (needs `confirm`)           |
| `jira_issue_transitions`       | `jira_issue_link_create`                                |
| `jira_issue_comment_list`      | `jira_issue_link_delete`                                |
| `jira_issue_link_list`         | `jira_sprint_add`                                       |
| `jira_issue_link_types`        | `confluence_page_create`                                |
| `jira_board_list`              | `confluence_page_update`                                |
| `jira_sprint_list`             | `confluence_page_delete` (needs `confirm` with `purge`) |
| `jira_sprint_issues`           | `confluence_page_comment_add`                           |
| `confluence_open`              |                                                         |
| `confluence_page_get`          |                                                         |
| `confluence_page_search`       |                                                         |
| `confluence_page_children`     |                                                         |
| `confluence_page_comment_list` |                                                         |

Each tool's inputs are the command's arguments and flags in camel case; see the CLI's
[command reference](https://simplysf.github.io/simply-atlassian/reference/) for what each does.
`fields` on the issue tools matters as much here as in the CLI: raw issue payloads are large, and
an agent pays for every token it reads. The two `open` tools return the URL rather than launching
a browser.

## Results and errors

A successful call returns what the CLI prints with `--json`, verbatim. A failure returns an error
result whose text is a JSON object with a stable `code`:

| `code`             | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `config`           | Missing or contradictory settings, a refused write, bad input. CLI exit code 2.   |
| `auth`             | The instance rejected the credentials; carries the HTTP `status`. Exit code 3.    |
| `error`            | Any other failure, including an API error with its `status` and sanitised `body`. |
| `confirm-required` | A destructive tool was called without `confirm: true`.                            |

The first three carry the same `name`, `message`, and `exitCode` the CLI writes to stderr,
scrubbed the same way, as described in
[Scripts and agents](https://simplysf.github.io/simply-atlassian/guides/scripting/).

## Options

```
simply-atlassian-mcp [--allow-writes] [--env-file <path>]
```

`--help` prints the options and the full tool list. Because stdout is the protocol stream, it
prints to stderr.

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for what's specific to this package, and the repo's [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for repo structure, setup, commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
