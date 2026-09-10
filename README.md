# Simply Atlassian

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Simply Atlassian is a command-line interface built by [SimplySF](https://github.com/SimplySF) for working
with Atlassian products (Jira, Confluence, and friends).

It covers Jira issues (search, view, create, update, transition, delete, history), comments with
@-mentions, issue links, users, agile boards and sprints, and Confluence pages (read, search, create,
update from storage format or Markdown, delete, comments) — plus opening any of them in a browser.
Output is human-readable by default and raw JSON with `--json`, every write takes `--dry-run`, and
the same capabilities are available to AI agents as an MCP server.

## Packages

| Package                                                             | Description                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`@simplysf/simply-atlassian`](packages/simply-atlassian)           | The `atlassian` CLI                                                                     |
| [`@simplysf/simply-atlassian-core`](packages/simply-atlassian-core) | Configuration, auth, HTTP clients, and shared logic the CLI and MCP server are built on |
| [`@simplysf/simply-atlassian-mcp`](packages/simply-atlassian-mcp)   | MCP server exposing Jira and Confluence to AI agents, one tool per CLI command          |

## Installation

All three packages need Node.js 22 or later.

**The CLI**, for a person at a terminal or a script:

```sh
npm install -g @simplysf/simply-cli
simply atlassian --help
```

**The MCP server**, for an AI agent in Claude Desktop, Claude Code, Cursor, VS Code, or any other
MCP client. Install it globally, or let the client fetch it on demand with
`npx -y @simplysf/simply-atlassian-mcp`:

```sh
npm install -g @simplysf/simply-atlassian-mcp
simply-atlassian-mcp --help
```

Then add it to your client; the [MCP server guide](https://simplysf.github.io/simply-atlassian/guides/mcp-server/)
has the configuration for each one.

**The core library**, for building your own tooling on the same configuration, clients, and
operations the CLI and MCP server use:

```sh
npm install @simplysf/simply-atlassian-core
```

Each reads the connection settings described in
[Credentials](https://simplysf.github.io/simply-atlassian/guides/credentials/).

## Documentation

The [documentation site](https://simplysf.github.io/simply-atlassian/) has a getting-started guide, guides to
credentials, write safety, scripting, and the MCP server, and the full command reference. The same command reference is in the
[package README](packages/simply-atlassian/README.md#commands).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo structure, how to set
up and build the project, our commit conventions, and how to submit a pull request. Please also read
our [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

Please report bugs or request features by [opening an issue](https://github.com/SimplySF/simply-atlassian/issues)
in this repository.

## License

Licensed under the [Apache-2.0](LICENSE.txt) license.
