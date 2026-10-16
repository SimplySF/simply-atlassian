# 0018 — `atlassian mcp install`

**Status:** In progress
**Package:** `simply-atlassian-mcp`
**Date:** 2026-10-16

## Problem

Getting a client to launch `simply atlassian mcp` means hand-editing a configuration file whose
location and shape differ per client. The commonest failures are a GUI client that can't find
`simply` on `PATH`, and a relative `--env-file`. The README spends a section per client explaining
the edit.

## Decision

Add `simply atlassian mcp install`, which writes the entry into named clients. The behavior is
designed once, for both MCP products, in
[simply-cli 0003 — Installing the MCP servers into MCP clients](https://github.com/SimplySF/simply-cli/blob/main/docs/design/0003-mcp-client-setup.md).
That covers the client table, how each client is edited, launchers, outcomes and exit codes.

The client logic lives in this package, in `src/mcpClients`, not in a shared npm library. 0003
planned a library, `@simplysf/simply-mcp-clients`, published from simply-cli, and it was built
there. It was dropped before its first publish: each product carries its own copy instead, and
simply-gitlab's is identical. That means two copies of the client table, which is what 0003 warned
about. In return, neither product depends on a package from another repo, and there is no release
order to manage across three repos. Change both copies in the same pair of PRs.

`src/mcpClients` stays out of `simply-atlassian-core` on purpose. Core has no runtime dependencies,
and this code needs `jsonc-parser` and `cross-spawn` (`claude` and `codex` are `.cmd` shims on
Windows).

This command decides only what is specific to this product:

| Flag             | Effect on the entry                                                                    |
| ---------------- | -------------------------------------------------------------------------------------- |
| `--allow-writes` | Adds `--allow-writes` to the args, and makes the default name `simply-atlassian-write` |
| `--xray`         | Adds `--xray` to the args                                                              |
| `--env-file`     | Adds `--env-file <absolute path>`; refused (exit 2) if the file doesn't exist          |
| (no `--name`)    | `simply-atlassian`, or `simply-atlassian-write` with `--allow-writes`                  |

The args are always `atlassian mcp …`. The `absolute` launcher runs `process.execPath` on the
`simply` host's `bin/run.js` (`this.config.root`). This package's own `bin/run.js` is the
standalone server and doesn't take `atlassian mcp`, so the command refuses `--launcher absolute`
(exit 2) when it isn't running under `@simplysf/simply-cli`.

`atlassian mcp` remains a command and also becomes a topic. oclif matches the longest command id,
so `atlassian mcp install` reaches the new command and `atlassian mcp` still serves.

## Alternatives considered

See simply-cli 0003 for the command's behavior. Beyond that:

- **Depend on `@simplysf/simply-mcp-clients` (0003's plan).** One copy of the client table, but a
  third repo's package that both products wait on to release. Dropped for a copy per product, as
  above.
- **Put the code in `simply-atlassian-core` and have simply-gitlab depend on it.** One copy, but
  GitLab would install the Atlassian library and wait on Atlassian releases. It would also give core
  its first runtime dependencies.
- **Fall back to `--launcher simply` silently** when `absolute` can't work. That would write an
  entry that depends on `PATH` when the person asked for the opposite, so the command refuses
  instead.

## Implementation plan

1. `src/mcpClients/`: the client logic, copied from the simply-cli implementation of 0003 along with
   its tests in `test/mcpClients/`. Dependencies: `jsonc-parser`, `cross-spawn`.
2. `src/commands/atlassian/mcp/install.ts` and `test/mcp-install.test.ts`.
3. README and `docs/guides/mcp-server.md`: lead "Configure a client" with the command.
4. In simply-cli, raise the `@simplysf/simply-atlassian-mcp` `jitPlugins` lower bound to the release
   that ships it.

## Testing

Flag forwarding (`--allow-writes`, `--xray`, `--env-file` made absolute), the default name switch,
`--name` and `--launcher`, the launcher guard, a missing `--client` (exit 2, listing the ids), a
missing env file (exit 2, nothing written), `--dry-run --json`, and the exit code being the highest
across clients. Every case writes project-scope files under a temp directory. The client logic
itself is tested in `test/mcpClients/`: paths per platform, every outcome, comment- and
format-preserving JSONC edits, the `claude`/`codex` argv, launchers and the env file.

## Open questions

None beyond simply-cli 0003's.
