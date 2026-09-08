# @simplysf/simply-atlassian-mcp

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian-mcp?label=@simplysf/simply-atlassian-mcp)](https://npmjs.com/@simplysf/simply-atlassian-mcp) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the
[`@simplysf/simply-atlassian`](../simply-atlassian) CLI to AI agents as MCP tools, so an agent in
Claude Desktop, Claude Code, Cursor, or any other MCP client can search, read, and (when explicitly
allowed) change Jira issues and read Confluence pages.

Every tool wraps one CLI command and runs it as a child process with `--json`, so the server
inherits the CLI's behaviour rather than reimplementing it: the same credential resolution, the
same `--dry-run` previews, the same `ATLASSIAN_READ_ONLY` guard, the same credential scrubbing in
error messages, and the same stable exit codes. The result of a tool call is the raw Atlassian API
payload, exactly as the CLI's `--json` prints it.

## Install

```bash
npm install -g @simplysf/simply-atlassian-mcp
```

Requires Node.js 22 or later. The CLI is a dependency, so nothing else needs to be installed.

## Configure an MCP client

The server speaks MCP over stdio. Point a client at the binary and give it the same connection
settings the CLI reads — see the CLI's [Credentials](https://simplysf.github.io/simply-atlassian/guides/credentials/)
guide. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "simply-atlassian": {
      "command": "simply-atlassian-mcp",
      "env": {
        "JIRA_URL": "https://your-site.atlassian.net",
        "JIRA_USERNAME": "you@example.com",
        "JIRA_API_TOKEN": "..."
      }
    }
  }
}
```

Or keep the credentials in a file and pass it instead:

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

### Server options

| Option              | Effect                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allow-writes`    | Also register the tools that change or delete data. Without it, only read tools exist and the CLI is additionally run with `ATLASSIAN_READ_ONLY=1`.       |
| `--env-file <path>` | A `.env` file passed to every CLI call. Variables already in the environment win over the file, and only Atlassian connection variables are read from it. |
| `--timeout <ms>`    | Kill a CLI call that runs longer than this and report it as a timeout. Defaults to 60000.                                                                 |
| `--help`            | Print the options and the tool list to stderr.                                                                                                            |

## Write safety

The server is read-only by default. That is a convenience, not a security boundary: the CLI's
[Write safety](https://simplysf.github.io/simply-atlassian/guides/write-safety/) guide explains
why a **read-scoped API token** is the only layer that actually binds, and why that matters most
when an agent is the caller. Give the agent's server a read-scoped credential, and run a second
server with `--allow-writes` and a write-capable credential only when a person means to let it
write.

With `--allow-writes`:

- Every write tool accepts `dryRun: true`, which returns the request that would be sent and sends
  nothing.
- The irreversible tools — `jira_issue_delete` and `jira_issue_comment_delete` — additionally
  require `confirm: true`. A call without it is refused before the CLI is even started.
- Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so a host can ask for approval
  where its policy says to.

## Tools

Read tools, always registered:

| Tool                       | Wraps                                       |
| -------------------------- | ------------------------------------------- |
| `jira_whoami`              | `simply atlassian jira whoami`              |
| `jira_user_search`         | `simply atlassian jira user search`         |
| `jira_user_view`           | `simply atlassian jira user view`           |
| `jira_issue_search`        | `simply atlassian jira issue search`        |
| `jira_issue_view`          | `simply atlassian jira issue view`          |
| `jira_issue_transitions`   | `simply atlassian jira issue transitions`   |
| `jira_issue_comment_list`  | `simply atlassian jira issue comment list`  |
| `jira_issue_link_list`     | `simply atlassian jira issue link list`     |
| `jira_issue_link_types`    | `simply atlassian jira issue link types`    |
| `confluence_page_get`      | `simply atlassian confluence page get`      |
| `confluence_page_search`   | `simply atlassian confluence page search`   |
| `confluence_page_children` | `simply atlassian confluence page children` |

Write tools, registered with `--allow-writes`:

| Tool                        | Wraps                                        | Needs `confirm` |
| --------------------------- | -------------------------------------------- | --------------- |
| `jira_issue_create`         | `simply atlassian jira issue create`         |                 |
| `jira_issue_update`         | `simply atlassian jira issue update`         |                 |
| `jira_issue_transition`     | `simply atlassian jira issue transition`     |                 |
| `jira_issue_delete`         | `simply atlassian jira issue delete`         | yes             |
| `jira_issue_comment_add`    | `simply atlassian jira issue comment add`    |                 |
| `jira_issue_comment_edit`   | `simply atlassian jira issue comment edit`   |                 |
| `jira_issue_comment_delete` | `simply atlassian jira issue comment delete` | yes             |
| `jira_issue_link_create`    | `simply atlassian jira issue link create`    |                 |
| `jira_issue_link_delete`    | `simply atlassian jira issue link delete`    |                 |

Tool inputs mirror the command's arguments and flags in camel case (`deleteSubtasks` for
`--delete-subtasks`, `byName` for `--by-name`). List-valued inputs are arrays: `fields` and `expand`
become one comma-separated flag, `labels` and `mentions` become a repeated flag. `body` is a JSON
object passed as `--body`. See the CLI's
[command reference](https://simplysf.github.io/simply-atlassian/reference/) for what each does.

## Results and errors

A successful call returns one text content block holding the CLI's `--json` output verbatim — the
raw API payload, or the `{ issues, total?, pages, complete }` envelope for paged searches.

A failed call returns `isError: true` with a text block holding a JSON object:

```json
{ "code": "auth", "name": "AuthError", "message": "…", "exitCode": 3, "status": 403 }
```

| `code`             | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `config`           | The CLI exited 2: missing or contradictory settings, a refused write, bad input. |
| `auth`             | The CLI exited 3: the instance rejected the credentials.                         |
| `error`            | Any other CLI failure, including an API error (`status` carries the HTTP code).  |
| `confirm-required` | A destructive tool was called without `confirm: true` (and not as a dry run).    |
| `timeout`          | The CLI call overran `--timeout` and was stopped.                                |
| `server`           | The CLI process could not be started at all.                                     |

Messages are the CLI's own, already scrubbed of credential values and control characters.

## Programmatic use

```ts
import { createServer } from '@simplysf/simply-atlassian-mcp';

const server = createServer({ allowWrites: false, envFile: '/etc/atlassian.env' });
await server.connect(myTransport);
```

`createServer` accepts a `runCli` replacement, which is how the package's own tests capture the
argument list each tool builds without spawning anything.

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for what's specific to this package, and the repo's [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for repo structure, setup, commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
