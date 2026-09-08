# AGENTS.md

Guidance for coding agents working in this repository.

## Start here

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, validation, and contribution rules.
- Read [`docs/design/README.md`](docs/design/README.md) for the design-document process and the
  index of topic-focused architecture and behavior docs.
- Read [`packages/simply-atlassian/README.md`](packages/simply-atlassian/README.md) for the generated
  CLI command reference.

## Feature-specific guidance

- For `jira open` and `confluence open`, read
  [`docs/design/0010-open-in-browser.md`](docs/design/0010-open-in-browser.md). It records URL
  construction, browser-launch and fallback behavior, and the supported output modes.
- Use the neighboring numbered design docs in [`docs/design/`](docs/design/README.md) for the
  corresponding Atlassian client, output, Confluence, write-safety, user, and issue-link areas.

Keep this file as an index for agents. Put substantive behavior and design rationale in the focused
docs under `docs/` and in the generated package README, not here.
