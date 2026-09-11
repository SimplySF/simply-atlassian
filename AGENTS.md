# AGENTS.md

## Documentation map

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull-request checklist.
Read [docs/design/README.md](docs/design/README.md) before changing a user-visible command,
shared module, authentication, or API behavior; it defines when a design document is required and
indexes the topic records.

Use the smallest relevant topic document rather than loading the whole directory:

- [Atlassian client core](docs/design/0001-atlassian-client-core.md): configuration, authentication,
  HTTP behavior, and pagination conventions.
- [Output conventions and Jira reads](docs/design/0002-output-conventions-first-jira-commands.md):
  table output and JSON behavior.
- [Jira write safety](docs/design/0004-write-safety-and-jira-issue-writes.md): dry runs,
  confirmations, and `ATLASSIAN_READ_ONLY`.
- [Jira agile boards and sprints](docs/design/0009-jira-agile-boards-sprints.md): board and sprint
  commands, numeric-ID policy, agile pagination, and sprint-write limits.
- [Open Atlassian objects in the browser](docs/design/0010-open-in-browser.md): `jira open` and
  `confluence open` URL construction, browser-launch and fallback behavior, and output modes.
- [Jira issue history](docs/design/0011-jira-issue-history.md): changelog paging, completeness
  reporting, and the split between normalized terminal output and raw JSON across Cloud and Server/DC.
- [MCP server](docs/design/0007-mcp-server.md): the tool catalogue and its parity with the CLI,
  the read-only default and `--allow-writes`, the confirm gate, and error mapping.
- [The core library package](docs/design/0012-simply-atlassian-core.md): what lives in
  `@simplysf/simply-atlassian-core` versus the CLI, the no-terminal rule, and the phased plan for
  the MCP server to call it in-process.

The package [README](packages/simply-atlassian/README.md) is the generated user-facing command
reference. Update command metadata first, then regenerate it as described in `CONTRIBUTING.md`.

The published documentation is built by [simply-cli](https://github.com/SimplySF/simply-cli) from
the **published packages**, not from this repo. The guides live in `packages/*/docs/guides/` and are
listed in each package's `files`, so they travel with a release; the command reference is generated
from `oclif.manifest.json`. A guide change therefore reaches the site when the package is released,
not when it merges — which is deliberate, so the site describes what people have installed. Never
hand-write a reference page. A guide that no longer matches `--help` is worse than no guide.

## Working conventions

- **Implement functionality in `@simplysf/simply-atlassian-core` first, then expose it through both
  `simply-atlassian` (the CLI) and `simply-atlassian-mcp`.** The core package holds the behavior;
  the other two are thin surfaces over it. Putting logic in a command means the MCP server cannot
  reach it without a second implementation, and two implementations of the same rule drift — which
  is the problem [0012](docs/design/0012-simply-atlassian-core.md) exists to solve.

  Both surfaces are closed allowlists, so exposing is a real step rather than something that
  happens for free: a CLI command declares its `flags`, and an MCP tool declares its `inputSchema`.
  A capability that lives in core and reaches only one of them is the failure worth checking for.
  Anything touching a terminal, a process, `process.argv`, stdout or stderr stays out of core.

- A new command, user-visible flag/output/error change, or new shared module needs a design document
  in `docs/design/` **before** implementation, following the process in
  [docs/design/README.md](docs/design/README.md). After landing, correct the doc to match what
  shipped and update its `Status` line and index row.
- Before calling a command or flag change finished, work through the "Pull Requests" checklist in
  `CONTRIBUTING.md`. Nothing local enforces two of its steps, so they are the ones most often
  skipped: run `pnpm run readme` in the package and commit the regenerated README, and run
  `pnpm run build` so `command-snapshot.json` regenerates and commit it. CI catches a stale
  snapshot but not a stale README.
- Command copy (summaries, descriptions, examples) lives inline as static class properties on the
  command classes. There is no `messages/*.md` convention here; SimplySF's Salesforce CLI repos use
  one via `@salesforce/core`, which does not apply to this project.
