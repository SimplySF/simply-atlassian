# @simplysf/simply-atlassian-mcp

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian-mcp?label=@simplysf/simply-atlassian-mcp)](https://npmjs.com/@simplysf/simply-atlassian-mcp) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that gives an AI agent in
Claude Desktop, Claude Code, Cursor, Gemini, VS Code, or any other MCP client the same Jira and
Confluence capabilities as the [`@simplysf/simply-atlassian`](../simply-atlassian) CLI: one tool per command,
calling the same [`@simplysf/simply-atlassian-core`](../simply-atlassian-core) library in-process.
The agent gets the CLI's credential handling, `dryRun` previews, read-only guard, credential
redaction, and error messages, and the same raw JSON the CLI prints with `--json`, without a
process per call.

Using it takes four steps: install the server, tell your MCP client how to launch it, check the
connection, then ask the agent for what you want in plain language. This README walks through
each, then covers letting the agent write, the full tool list, results and errors, and what to
check when something does not work. The same material, with the rest of the CLI's guides, is on
the [documentation site](https://simplysf.github.io/simply-atlassian/guides/mcp-server/).

## Install

The server needs Node.js 22 or later.

```bash
npm install -g @simplysf/simply-atlassian-mcp
simply-atlassian-mcp --help
```

`--help` prints the options and every tool the server can register, so it doubles as a check that
the install worked. It prints to stderr, because stdout is reserved for the protocol stream.

You can skip the global install and have the client fetch the package on demand with
`npx -y @simplysf/simply-atlassian-mcp` as the command; the client configurations below show both
forms.

## Connection settings

The server reads the same variables as the CLI, described in the
[Credentials](https://simplysf.github.io/simply-atlassian/guides/credentials/) guide:

```
JIRA_URL=https://your-site.atlassian.net
JIRA_USERNAME=you@example.com
JIRA_API_TOKEN=...

CONFLUENCE_URL=https://your-site.atlassian.net
CONFLUENCE_USERNAME=you@example.com
CONFLUENCE_API_TOKEN=...
```

Put them in a `.env` file and pass it with `--env-file`, or set them in the `env` block of the
client's server entry. A variable already in the environment wins over the file, as it does for
the CLI. Settings are resolved when a tool is called rather than at startup, so a server given only
the `JIRA_*` variables still serves every Jira tool; only the Confluence tools report a missing
setting.

Use an absolute path for the env file. MCP clients launch the server from a working directory of
their own, so `~` and relative paths may not resolve. On Windows, write the path with forward
slashes or doubled backslashes inside JSON: `"C:/Users/me/atlassian.env"`.

## Configure a client

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows:
`%APPDATA%\Claude\`) and restart Claude Desktop:

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

The same entry with the settings inline and no global install:

```json
{
  "mcpServers": {
    "simply-atlassian": {
      "command": "npx",
      "args": ["-y", "@simplysf/simply-atlassian-mcp"],
      "env": {
        "JIRA_URL": "https://your-site.atlassian.net",
        "JIRA_USERNAME": "you@example.com",
        "JIRA_API_TOKEN": "..."
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add simply-atlassian -- simply-atlassian-mcp --env-file ~/atlassian.env
```

Add `--scope project` to write the entry to a `.mcp.json` at the repository root instead, which
can be committed so a team shares the server definition. Keep tokens out of a committed file by
pointing at an env file each person holds locally. Inside a session, `/mcp` lists the configured
servers and whether each one connected.

### Cursor

Cursor reads `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project, with
the same `mcpServers` shape as Claude Desktop.

### Gemini CLI

Gemini CLI reads `~/.gemini/settings.json` for every project, or `.gemini/settings.json` inside a
project, with the same `mcpServers` shape as Claude Desktop:

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

`gemini mcp add` writes the same entry. `--scope user` puts it in the global file; the default
`project` scope writes `.gemini/settings.json`, and `-e` sets one variable on the entry:

```sh
gemini mcp add --scope user \
  -e JIRA_URL=https://your-site.atlassian.net \
  -e JIRA_USERNAME=you@example.com \
  -e JIRA_API_TOKEN=... \
  simply-atlassian simply-atlassian-mcp
```

Flags meant for the server itself, `--env-file` and `--allow-writes`, are easier to add by editing
`settings.json`, because `gemini mcp add` reads a leading-dash argument as one of its own options.

Values in `env` expand `$NAME` from the environment Gemini started in, which keeps the token out of
the settings file without an env file:

```json
{
  "mcpServers": {
    "simply-atlassian": {
      "command": "npx",
      "args": ["-y", "@simplysf/simply-atlassian-mcp"],
      "env": {
        "JIRA_URL": "https://your-site.atlassian.net",
        "JIRA_USERNAME": "you@example.com",
        "JIRA_API_TOKEN": "$JIRA_API_TOKEN"
      }
    }
  }
}
```

Two other fields on an entry matter here. `trust: true` bypasses the per-call confirmation for
every tool on that server, so leave it off on any entry started with `--allow-writes` and let a
person approve each write. `includeTools` and `excludeTools` narrow what the model is shown, which
is a second way to express the split in [Let the agent write](#let-the-agent-write): a write entry
can register the write tools while holding back the destructive ones.

```json
{
  "mcpServers": {
    "simply-atlassian-write": {
      "command": "simply-atlassian-mcp",
      "args": ["--allow-writes", "--env-file", "/home/me/atlassian-write.env"],
      "excludeTools": ["jira_issue_delete", "jira_issue_comment_delete", "confluence_page_delete"],
      "trust": false
    }
  }
}
```

Inside a session, `/mcp` lists the configured servers, whether each connected, and the tools it
registered.

### Gemini Code Assist

Agent mode in the VS Code extension reads that same `~/.gemini/settings.json`, so an entry added
for Gemini CLI is already in place. In IntelliJ the file is `mcp.json` in the IDE's configuration
directory, holding the same `mcpServers` object.

### VS Code

VS Code reads `.vscode/mcp.json`, with a `servers` key and an explicit transport type:

```json
{
  "servers": {
    "simply-atlassian": {
      "type": "stdio",
      "command": "simply-atlassian-mcp",
      "args": ["--env-file", "/home/me/atlassian.env"]
    }
  }
}
```

### Any other client

The server speaks MCP over stdio, so any client that can launch a local command works: give it the
command, its arguments, and optionally an environment, as above. It announces itself as
`simply-atlassian` with the package version during the handshake and supplies instructions that
summarise the tool conventions for the host's model.

## Check the connection

Ask the agent which Jira account it is connected as. It should call `jira_whoami`, whose
description tells the model to use it first for exactly this purpose, and report back the account
the credentials resolve to. If it does, the server is running and the credentials work; the
[troubleshooting](#troubleshooting) table covers the cases where it does not.

## Ask for what you want

You do not call tools yourself. Describe the outcome, and the agent chooses the tools and fills in
their inputs from the descriptions the server publishes. Some examples of what a request turns
into:

| You ask                                               | The agent calls                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "What's open in PROJ and assigned to me?"             | `jira_issue_search` with `jql` such as `project = PROJ AND assignee = currentUser() AND statusCategory != Done` |
| "Summarise PROJ-42 and its comments."                 | `jira_issue_view`, then `jira_issue_comment_list`                                                               |
| "Who changed the priority on PROJ-42, and when?"      | `jira_issue_history` with `field: "priority"`                                                                   |
| "What's in the current sprint on the Platform board?" | `jira_board_list` to find the board id, `jira_sprint_list` for the active sprint, then `jira_sprint_issues`     |
| "Find our release-notes pages in the DOCS space."     | `confluence_page_search` with a CQL query                                                                       |
| "Give me a link to PROJ-42."                          | `jira_open`, which returns the URL rather than launching a browser                                              |

Each tool's inputs are the matching command's arguments and flags in camel case, with arrays where
the CLI takes a repeatable or comma-separated flag; see the CLI's
[command reference](https://simplysf.github.io/simply-atlassian/reference/) for what each does.
The first request above, for instance, becomes a call like:

```json
{
  "jql": "project = PROJ AND assignee = currentUser() AND statusCategory != Done",
  "fields": ["summary", "status", "priority"],
  "limit": 50
}
```

and returns the same envelope the CLI prints under `--json`:

```json
{ "issues": [...], "pages": 1, "complete": true }
```

A few things make the agent's job easier:

- **Name the fields you care about.** `fields` on the issue tools matters as much here as in the
  CLI: raw issue payloads are large, and an agent pays for every token it reads. "Show me the
  summary and status of..." lets it ask for only those.
- **Name boards and sprints; the agent resolves the numbers.** The sprint tools take numeric ids,
  which the agent looks up with `jira_board_list` and `jira_sprint_list`.
- **Transitions go by name.** "Move it to Done" works; when unsure what the workflow allows, the
  agent can call `jira_issue_transitions` first.
- **Mention people by name or email.** `mentions` resolves them to account ids; an ambiguous name
  comes back as an error listing the candidates, so the agent can ask you which one.
- **Paste Confluence URLs.** Every page input accepts a page id or a page URL.
- **`open` tools return URLs.** A server cannot launch a browser, so `jira_open` and
  `confluence_open` hand back the address for you to follow.

## Let the agent write

Started without options, the server registers only the read tools. Start it with `--allow-writes`
to also register the tools that create, update, transition, comment, link, and delete. Even then,
`ATLASSIAN_READ_ONLY` in the environment refuses every write, exactly as it does for the CLI.

That mirrors the two-credential-file arrangement in
[Write safety](https://simplysf.github.io/simply-atlassian/guides/write-safety/): give the agent's
everyday server a read-scoped token, and configure a second server entry with `--allow-writes` and
a write-capable token that is enabled only when a person means to let the agent write. In a
`mcpServers` configuration the pair looks like this:

```json
{
  "mcpServers": {
    "simply-atlassian": {
      "command": "simply-atlassian-mcp",
      "args": ["--env-file", "/home/me/atlassian.env"]
    },
    "simply-atlassian-write": {
      "command": "simply-atlassian-mcp",
      "args": ["--allow-writes", "--env-file", "/home/me/atlassian-write.env"]
    }
  }
}
```

A read-scoped token is still the only layer that binds; the server-side default just keeps write
tools out of the agent's normal loop entirely. Most clients also ask you to approve each tool call,
and the tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so a host can tell a read
from a delete when it asks.

With writes allowed:

- **Ask for a preview first.** Every write tool accepts `dryRun: true`, which returns the request
  that would be sent without sending it. "Show me what you'd send to move PROJ-42 to Done with a
  comment, then do it" produces a call like the one below, which you can check before the agent
  repeats it without `dryRun`.

  ```json
  { "issue": "PROJ-42", "transition": "Done", "comment": "Verified in staging.", "dryRun": true }
  ```

- **Irreversible deletes need consent.** `jira_issue_delete` and `jira_issue_comment_delete`
  require `confirm: true`, and so does `confluence_page_delete` with `purge: true`. A call without
  it is answered with a `confirm-required` error before anything is looked up, and the message
  names the input to add, so the agent will come back and ask you. Trashing a page needs no
  `confirm`, because it is reversible.
- **Confluence bodies can be Markdown.** The page and comment tools take a body as `text` (plain
  prose), raw storage-format `body`, or `markdown` (converted to storage format), and
  `confluence_page_update` takes `append` to add to a page instead of replacing it. "Add a
  Decisions section to this page with these three bullets" becomes `confluence_page_update` with
  `markdown` and `append: true`.

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
[Scripts and agents](https://simplysf.github.io/simply-atlassian/guides/scripting/). The agent
sees these errors and can act on them, so a wrong key or a missing setting usually ends in the
agent telling you what went wrong rather than in silence.

## Troubleshooting

Run `simply-atlassian-mcp --help` at a terminal first. If it prints the tool list, the package is
installed and working, and the problem is in how the client launches it or what it passes.

| Symptom                                                           | Cause and fix                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The client reports the server failed to start                     | Desktop apps do not load your shell profile, so the command may not be on their `PATH`. Use the full path to the executable (it lives in the directory `npm prefix -g` reports, under `bin/` on macOS and Linux), or the `npx` form above. |
| The client's log says `Env file ... not found.`                   | The only startup failure. The path is wrong or relative; make it absolute. The server exits with code 2.                                                                                                                                   |
| Every tool returns `code: "config"` naming `JIRA_URL`             | The settings are not reaching the server: the env file is not being read, or the variables were set in a shell the client did not inherit. Pass `--env-file` or an `env` block explicitly.                                                 |
| Confluence tools fail with `code: "config"` while Jira works      | Only the `JIRA_*` variables are set. Add the `CONFLUENCE_*` ones; each product's settings are resolved separately.                                                                                                                         |
| `code: "auth"` with status `401`                                  | The instance rejected the credentials. Cloud needs `JIRA_USERNAME` plus `JIRA_API_TOKEN`; Server/Data Center needs `JIRA_PERSONAL_TOKEN` alone. Set one style, not both.                                                                   |
| `code: "auth"` with status `403` on a write                       | The token is read-scoped, which is the intended outcome for the everyday server. Use the write-capable server entry for this change.                                                                                                       |
| The agent says it has no tool to create, update, or delete        | The server was started without `--allow-writes`. That is the default; see [Let the agent write](#let-the-agent-write).                                                                                                                     |
| A write returns `code: "config"` mentioning `ATLASSIAN_READ_ONLY` | The variable is set in the environment or the env file. Unset it, or point the write server at a credential file meant for writing.                                                                                                        |

## Embed in your own process

The stdio binary is the usual way to run the server, but the package also exports what it is
built from, so a host process can serve the same tools over a transport of its choosing:

```js
import { createServer, startServer } from '@simplysf/simply-atlassian-mcp';

// Serve over stdio, exactly as the binary does.
await startServer({ allowWrites: false, envFile: '/home/me/atlassian.env' });

// Or build the server and attach a transport yourself.
const server = createServer({ allowWrites: true, env: process.env });
await server.connect(transport);
```

`createServer` returns the MCP SDK's `McpServer` with the tools registered and nothing connected.
`TOOLS` is the full catalogue, `selectTools(allowWrites)` is the subset a given configuration
registers, and `invokeTool` and `mapError` run one tool and map a failure onto the error object
above, for tests and hosts that need to drive the server without a transport.

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
