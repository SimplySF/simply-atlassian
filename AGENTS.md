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

The package [README](packages/simply-atlassian/README.md) is the generated user-facing command
reference. Update command metadata first, then regenerate it as described in `CONTRIBUTING.md`.
