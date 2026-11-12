# 0023 — Prefixing environment variables with `SIMPLY_`

**Status:** Implemented
**Package:** `simply-atlassian-core`, `simply-atlassian`, `simply-atlassian-mcp`
**Date:** 2026-11-12

## Problem

Every setting this project reads came from an unprefixed environment variable: `JIRA_URL`,
`JIRA_USERNAME`, `JIRA_API_TOKEN`, `JIRA_PERSONAL_TOKEN`, `JIRA_SSL_VERIFY`, the matching
`CONFLUENCE_*` five, and `ATLASSIAN_READ_ONLY`. The Jira and Confluence names are the ones most other
Atlassian tooling reads — other MCP servers, scripts, CI jobs — so a shell set up for any of them
silently configured this CLI too, pointing it at whatever instance and credential that tool used.
There was no way to give this CLI its own settings without also changing the other tool's.

## Decision

Every variable gets a `SIMPLY_` prefix, matching the `simply` binary and the SimplySF package scope.
The unprefixed names are deprecated, not removed: each still works while its prefixed name is unset,
and using one produces a warning. They are removed in a future major release.

The mapping lives once, in `simply-atlassian-core` (`src/env-vars.ts`, exported as `LEGACY_ENV`), and
every reader goes through `envValue(env, name)`, so the CLI and the MCP server cannot disagree about
which name wins.

## Behavior

| New name                           | Deprecated name             |
| ---------------------------------- | --------------------------- |
| `SIMPLY_ATLASSIAN_READ_ONLY`       | `ATLASSIAN_READ_ONLY`       |
| `SIMPLY_JIRA_URL`                  | `JIRA_URL`                  |
| `SIMPLY_JIRA_USERNAME`             | `JIRA_USERNAME`             |
| `SIMPLY_JIRA_API_TOKEN`            | `JIRA_API_TOKEN`            |
| `SIMPLY_JIRA_PERSONAL_TOKEN`       | `JIRA_PERSONAL_TOKEN`       |
| `SIMPLY_JIRA_SSL_VERIFY`           | `JIRA_SSL_VERIFY`           |
| `SIMPLY_CONFLUENCE_URL`            | `CONFLUENCE_URL`            |
| `SIMPLY_CONFLUENCE_USERNAME`       | `CONFLUENCE_USERNAME`       |
| `SIMPLY_CONFLUENCE_API_TOKEN`      | `CONFLUENCE_API_TOKEN`      |
| `SIMPLY_CONFLUENCE_PERSONAL_TOKEN` | `CONFLUENCE_PERSONAL_TOKEN` |
| `SIMPLY_CONFLUENCE_SSL_VERIFY`     | `CONFLUENCE_SSL_VERIFY`     |

Resolution, per setting:

1. An explicit flag (`--jira-url`, …) wins, as before. The flags now bind the prefixed name.
2. Otherwise the prefixed name, when it has a non-empty value.
3. Otherwise the deprecated name.

The prefixed name always wins over its deprecated one, so a `JIRA_URL` left in place for another tool
cannot override a setting made for this one. This applies to `SIMPLY_ATLASSIAN_READ_ONLY` too: an
explicit `SIMPLY_ATLASSIAN_READ_ONLY=0` beside `ATLASSIAN_READ_ONLY=1` is not read-only, because
someone deliberately set the new name.

**Errors** name the prefixed variable (`SIMPLY_JIRA_URL is not configured…`), since that is the one
to set.

**Warnings.** When a deprecated name is the one actually supplying a value, one line names each
rename: `Deprecated environment variables in use: JIRA_URL → SIMPLY_JIRA_URL, …`. Values are never
included. A deprecated name shadowed by its prefixed one is not reported: it is most likely there for
another tool, and nagging about it on every run would punish exactly the person who migrated. The
CLI reports it with oclif's `warn` after loading `--env-file` (stderr; silent under `--json`, like
every other warning). The MCP server writes it to stderr once at startup; stdout is the protocol.
Core only builds the text (`deprecatedEnvWarning`), keeping its no-terminal rule.

**`--env-file`** accepts both spellings. The rule that the real environment wins now treats the two
names of a setting as one: a file's entry is applied only when the environment sets the setting under
neither name. Checking only the file's own key would let a file's `SIMPLY_ATLASSIAN_READ_ONLY=0`
outrank a real `ATLASSIAN_READ_ONLY=1` — the prefixed name wins on lookup — and so turn the guard off
from a file, breaking 0004's "a file can turn the guard on but never off".

**Redaction** collects credential values under both names, whichever won, so a shadowed legacy token
is still scrubbed from output.

## Public API

`simply-atlassian-core` adds `LEGACY_ENV`, `EnvName`, `envValue`, `deprecatedEnvInUse` and
`deprecatedEnvWarning`. `READ_ONLY_ENV` now holds `'SIMPLY_ATLASSIAN_READ_ONLY'`, and `SECRET_ENV`
lists both spellings of each credential.

## Alternatives considered

- **Hard rename with no fallback.** Breaks every existing shell, `.env` file and MCP client entry on
  upgrade, with a "not configured" error that does not say why. Rejected for a minor release.
- **Warn whenever a deprecated name is present.** Rejected for the shadowing reason above: the
  collision with other tools is the whole problem, so their variables are expected to stay.
- **Read-only as the OR of both names.** Safer-looking, but it makes an explicit new-name `0`
  meaningless and diverges from every other setting. The file-based downgrade it would guard against
  is closed by the env-file rule instead.

## Removal

A later major release deletes `LEGACY_ENV`'s fallback in `envValue`, the deprecated keys from the
env-file allowlist and `SECRET_ENV`, and the warning. Keeping `*_SSL_VERIFY=false` rejection for the
unprefixed names is worth reconsidering then, since that check exists for settings carried over from
other tooling.
