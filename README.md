# Simply Atlassian

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Simply Atlassian is a command-line interface built by [SimplySF](https://github.com/SimplySF) for working
with Atlassian products (Jira, Confluence, and friends).

It covers Jira issues (search, view, create, update, transition, delete, history), comments with
@-mentions, issue links, users, agile boards and sprints, and Confluence pages (read, search, create,
update from storage format or Markdown, delete, comments) — plus opening any of them in a browser.
Output is human-readable by default and raw JSON with `--json`, every write takes `--dry-run`, and
the same capabilities are available to AI agents as an MCP server.

This repo is a Lerna/pnpm monorepo, following the same conventions as SimplySF's
[`simply-node`](https://github.com/SimplySF/simply-node) and [`simply-plugins`](https://github.com/SimplySF/simply-plugins)
repos.

## Packages

| Package                                                             | Description                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`@simplysf/simply-atlassian`](packages/simply-atlassian)           | The `atlassian` CLI                                                                     |
| [`@simplysf/simply-atlassian-core`](packages/simply-atlassian-core) | Configuration, auth, HTTP clients, and shared logic the CLI and MCP server are built on |
| [`@simplysf/simply-atlassian-mcp`](packages/simply-atlassian-mcp)   | MCP server exposing Jira and Confluence to AI agents, one tool per CLI command          |

## Installation

```sh
npm install -g @simplysf/simply-atlassian
```

```sh
simply atlassian --help
```

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
