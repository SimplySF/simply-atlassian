# @simplysf/simply-atlassian-mcp

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the
[`@simplysf/simply-atlassian`](../simply-atlassian) CLI to AI agents as MCP tools, so an agent in
Claude Desktop, Claude Code, Cursor, or any other MCP client can search, read, and (when given a
write-capable credential) change Jira issues and read Confluence pages without shelling out itself.

> **Status: scaffold.** The package builds, tests, and starts a stdio server, but registers no tools
> yet. Which commands become tools, how credentials and the CLI's write-safety layers carry over,
> and how output is shaped for an agent are being decided in
> [`docs/design/0007-mcp-server.md`](../../docs/design/0007-mcp-server.md). It is marked `private`
> and is not published until that lands.

## Install

Once published:

```bash
npm install -g @simplysf/simply-atlassian-mcp
```

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

Prefer a read-scoped API token for the credential an agent uses by default; the CLI's
[Write safety](https://simplysf.github.io/simply-atlassian/guides/write-safety/) guide explains why
that is the only layer that binds.

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for what's specific to this package, and the repo's [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for repo structure, setup, commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
