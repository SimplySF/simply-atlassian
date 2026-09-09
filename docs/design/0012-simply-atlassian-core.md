# 0012 — Splitting `simply-atlassian-core` out of `simply-atlassian`

**Status:** Phase 1 implemented on `feat/simply-atlassian-core` (PR pending); phases 2 and 3 planned
**Package:** new `packages/simply-atlassian-core`; `packages/simply-atlassian` (CLI, slimmed);
`packages/simply-atlassian-mcp` (consumer, in a follow-up to 0007)
**Date:** 2026-09-09

## Problem

The MCP server has two ways to do a tool call, and both are wrong today.

[0007](0007-mcp-server.md) (PR #11, unmerged on `feat/mcp-server-tools`) spawns
`simply atlassian … --json` per call. That gives exact parity with the CLI — `--dry-run`,
`ATLASSIAN_READ_ONLY`, credential redaction, exit codes — at the cost of a Node process and an
oclif `Config.load()` per tool call, a dependency on the CLI package (so installing the MCP server
installs oclif), and a second process whose stdout/stderr must be parsed back into structured
results.

The alternative 0007 rejected — import the library — was rejected for a reason that is still
true: `@simplysf/simply-atlassian`'s `src/index.ts` exports only the client layer (`JiraClient`,
`ConfluenceClient`, config resolution, the error classes). Everything an agent actually relies on
lives in the command layer: request-body assembly for `issue create`/`update`, transition-name
resolution, mention resolution, link-direction resolution, the read-only guard, secret redaction,
the ADF-to-text rendering in `issue view`, the "a 200 with no account is not a login" check in
`whoami`. An in-process server that re-derived any of that would be a second source of truth.

SimplySF already solved this shape once. `simply-node` splits each plugin's CLI-independent logic
into a `-core` library package ([0019](https://github.com/SimplySF/simply-node/blob/main/docs/design/0019-plugin-core-library-extraction.md),
[0023](https://github.com/SimplySF/simply-node/blob/main/docs/design/0023-simply-apex-core.md)),
and the CLI plugins in `simply-plugins` consume those packages. 0001 anticipated this too — it
listed "a separate `packages/atlassian-core` package" as premature _while there is one consumer_.
There are now two.

## Decision

Add `@simplysf/simply-atlassian-core` at `packages/simply-atlassian-core`: a plain library, no
oclif, no `bin/`, zero runtime dependencies, holding everything in the CLI that does not need a
terminal. The CLI depends on it as a workspace dependency; the MCP server will depend on it
_instead of_ the CLI.

The work lands in three phases, each its own PR series. Only phase 1 is a pure move; phases 2
and 3 change where behaviour lives but not what it is.

| Phase | What                                                                                                              | Observable change                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | Create the package; move the already-oclif-free modules (`src/core/*` and most of `src/shared/*`) and their tests | None. Commands, flags, output, exit codes identical.     |
| 2     | Hoist the command layer's logic into core "operations" so each `run()` is parse → call core → render              | None by contract; the existing command tests are the net |
| 3     | The MCP server calls core in-process (revises 0007)                                                               | MCP: no child process, no oclif dependency, same tools   |

The organising rule for what belongs in core: **core never touches a terminal or a process.** No
`@oclif/core`, no `node:child_process`, nothing reads `process.argv`, nothing writes to stdout or
stderr. Reading `process.env` is allowed only through an injectable `env` parameter that defaults
to it (the pattern `resolveJiraConfig` and `loadEnvFile` already use). That rule is enforced by
lint, not convention (see Implementation plan).

## Behavior

### Phase 1 — `@simplysf/simply-atlassian-core`, the package

Modelled on `simply-node`'s `simply-apex-core`/`simply-aep-core`:

```json
{
  "name": "@simplysf/simply-atlassian-core",
  "description": "Configuration, authentication, HTTP clients, and shared logic for Atlassian products",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" } },
  "files": ["/lib"],
  "engines": { "node": ">=22.0.0" },
  "dependencies": {},
  "devDependencies": { "@vitest/coverage-v8": "^4.1.10", "vitest": "^4.1.10" },
  "publishConfig": { "access": "public" }
}
```

Scripts and `wireit` blocks copied from `simply-atlassian-mcp` (the non-oclif template already in
this repo), with `--project simply-atlassian-core`. `tsconfig.json` is the same three-line extend
the other packages use. `.gitignore` copied from the MCP package. No `command-snapshot`, no
`readme` script.

**What moves.** Flat `src/` layout, as in every `-core` package in `simply-node`. `git mv`, verbatim.

| From (`packages/simply-atlassian/src/`) | To (`packages/simply-atlassian-core/src/`) | Why it qualifies                                                   |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `core/auth.ts`                          | `auth.ts`                                  | pure                                                               |
| `core/config.ts`                        | `config.ts`                                | `env` is a parameter                                               |
| `core/confluence-client.ts`             | `confluence-client.ts`                     | pure                                                               |
| `core/env-file.ts`                      | `env-file.ts`                              | `env` is a parameter                                               |
| `core/errors.ts`                        | `errors.ts`                                | pure                                                               |
| `core/http.ts`                          | `http.ts`                                  | pure                                                               |
| `core/jira-client.ts`                   | `jira-client.ts`                           | pure                                                               |
| `core/text.ts`                          | `text.ts`                                  | pure                                                               |
| `shared/atlassian-url.ts`               | `atlassian-url.ts`                         | pure; the MCP needs URLs even though it never opens them           |
| `shared/issue-links.ts`                 | `issue-links.ts`                           | pure; the direction rule must have exactly one home                |
| `shared/json-input.ts`                  | `json-input.ts`                            | reads a file by path; no terminal                                  |
| `shared/mentions.ts`                    | `mentions.ts`                              | takes a `JiraClient`; no terminal                                  |
| `shared/storage-markdown.ts`            | `storage-markdown.ts`                      | pure                                                               |
| `shared/output.ts`                      | `output.ts`                                | pure string formatting; 0007 wants the curated view reusable       |
| `shared/issue-table.ts`                 | `issue-table.ts`                           | depends only on `output.ts`                                        |
| `shared/confluence-body.ts`             | `confluence-body.ts`                       | reads a file by path; no terminal (landed with 0008 during review) |

**What stays in the CLI:** `shared/base-command.ts` (oclif, `process.argv`),
`shared/open-in-browser.ts` (spawns a browser), every file under `commands/`. After phase 1 the
CLI's `src/shared/` holds only those two files and `src/core/` is deleted.

Relative imports between moved files (`./errors.js`, `../core/text.js` → `./text.js`) are the only
edits to moved files. `output.ts`'s re-export of `stripControl`/`stripControlOneLine` stays, so the
CLI's commands keep one import site for it.

**Barrel.** `src/index.ts` re-exports by name — no `export *` — so the public surface is a list a
reviewer can read and `test/index.test.ts` can pin (same test shape as `simply-aep-core`, asserting
`Object.keys(api).sort()` against a literal). Runtime exports after phase 1:

| File                   | Runtime exports                                                             |
| ---------------------- | --------------------------------------------------------------------------- |
| `auth.ts`              | `buildAuthHeaders`                                                          |
| `config.ts`            | `resolveJiraConfig`, `resolveConfluenceConfig`                              |
| `confluence-client.ts` | `ConfluenceClient`                                                          |
| `env-file.ts`          | `loadEnvFile`, `parseEnvFile`                                               |
| `errors.ts`            | `CliError`, `ConfigError`, `AuthError`, `NetworkError`, `HttpError`         |
| `http.ts`              | `HttpTransport`                                                             |
| `jira-client.ts`       | `JiraClient`                                                                |
| `text.ts`              | `stripControl`, `stripControlOneLine`                                       |
| `atlassian-url.ts`     | `issueUrl`, `projectUrl`, `pageUrl`, `pageIdFromInput`, `pageIdForInstance` |
| `issue-links.ts`       | `resolveLinkDirection`, `describeLinkFromIssue`                             |
| `json-input.ts`        | `parseBodyInput`, `mergeFields`                                             |
| `mentions.ts`          | `resolveMentions`, `appendMentions`                                         |
| `storage-markdown.ts`  | `storageToMarkdown`                                                         |
| `output.ts`            | `formatKeyValue`, `formatTable`                                             |
| `issue-table.ts`       | `jiraIssueColumns`                                                          |
| `confluence-body.ts`   | `resolveStorageBody`                                                        |

plus every exported type from those files (`AtlassianConfig`, `ConfigOverrides`, `Deployment`,
`EnvLike`, `JiraSearchOptions`, `JiraSearchPage`, `JiraSearchResult`, `JiraAgileResult`,
`JiraChangelog*`, `ConfluencePage`, `JsonCall`, `QueryValue`, `TransportTarget`, `LinkType`,
`ResolvedLink`, `IssueLink`, `LinkedIssue`, `ResolvedMention`, `Pair`, `Column`, `JiraIssueRow`).
Anything not in the barrel is internal.

**The CLI after phase 1.**

- `package.json`: `"@simplysf/simply-atlassian-core": "workspace:^0.1.0"` in `dependencies`.
  `@oclif/core` stays. Nothing else changes.
- Every command and `base-command.ts` imports from `@simplysf/simply-atlassian-core` instead of
  relative `core/`/`shared/` paths. `open-in-browser.ts` has no core imports and is untouched.
- `src/index.ts` keeps exporting exactly the names it exports today, now re-exported from core,
  with a comment saying the library home is core. `scripts/smoke-test.mjs` switches to
  `../packages/simply-atlassian-core/lib/index.js`. The CLI's export surface is not shrunk in this
  doc; whether it is stubbed out to `export default {}` (the `simply-plugins` shape) is an open
  question below.
- `wireit`: `compile`, `test:compile`, `lint`, and every vitest entry point (`test:only`,
  `test:coverage`, and `test:watch`, the latter two becoming wireit tasks) gain
  `"dependencies": ["../simply-atlassian-core:compile"]`. Vitest resolves the package through its
  compiled `lib/`, so a test task without the dependency races its siblings on a clean checkout;
  `test.yml` runs the CLI's `test:only` before any build to keep that from regressing. `lerna run build` already orders by
  workspace dependency, but without this a package-local `pnpm run build` in the CLI directory
  fails on a cold checkout, and wireit's cache for the CLI would not know core's `lib/` changed.
  `simply-node` gets away without it because its consumers live in another repo.
- `command-snapshot.json`, `README.md`, and `oclif.manifest.json` are unchanged: no command, flag,
  or help text moves.

**Tests after phase 1.** Tests move with their modules, one directory shallower:
`test/core/*.test.ts` and
`test/shared/{atlassian-url,confluence-body,issue-links,json-input,mentions,output,page-reference,storage-markdown}.test.ts` →
`packages/simply-atlassian-core/test/*.test.ts`. `test/shared/base-command-errors.test.ts` and
`test/shared/error-body.test.ts` stay (they drive real commands). The fake Atlassian HTTP server
in `test/core/support.ts` is needed by both packages' tests; phase 1 duplicates it
(`test/support.ts` in each — about 80 lines, `node:http` only) rather than reaching across package
boundaries. Phase 3 adds a third consumer and is the point to promote it to a
`@simplysf/simply-atlassian-core/testing` subpath export; not before.

The CLI's `test/index.test.ts` placeholder becomes a real test that the CLI still exports the
names it did, so the compatibility promise above is asserted rather than hoped.

### Phase 2 — the command layer becomes core operations

The point of this phase is the sentence 0007 used to reject in-process tools: _"the behaviour
agents depend on lives in the command layer."_ After phase 2 it does not. Each command's `run()`
is parse flags → call a core function → render, and the core function is what the MCP calls.

Every hoist is a "refactor that keeps the public surface identical" and lands under the existing
command tests; new core-level tests cover the newly-public functions. Land it as one PR per row
so each is reviewable against a handful of commands.

| PR  | Commands                                          | New core module                      | What moves                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a  | all writes                                        | `write-safety.ts`                    | `assertWritesAllowed(env = process.env)` from `base-command.ts`, so the MCP's `--allow-writes`/read-only gate and the CLI's `isWrite` guard call one function                                                                                                   |
| 2a  | all                                               | `redaction.ts`                       | `redactSecrets(message, secrets)` and `sanitiseDeep(value, secrets)` from `base-command.ts`. Core takes the secret _values_; the CLI keeps the argv+env collection, the MCP passes env values. `SECRET_ENV` (the variable names) moves too — it is the contract |
| 2b  | `issue create`, `issue update`                    | `issue-writes.ts`                    | `buildCreateIssueBody(input, deployment, client)` / `buildUpdateIssueBody(...)`: typed-field assembly, `assigneeValue`, merge over `--body`, the "nothing to send" `ConfigError`; `browseUrl`                                                                   |
| 2b  | `issue transition`, `issue transitions`           | `transitions.ts`                     | `resolveTransitionId(client, issue, nameOrId, { byName })` with its capped, sanitised candidate listing; `buildTransitionBody(body, id, comment)`                                                                                                               |
| 2c  | `issue comment add`/`edit`                        | `comments.ts`                        | comment-body assembly with `mentions.ts`; the "nothing to comment" check                                                                                                                                                                                        |
| 2c  | `issue view`, `issue history`, `whoami`, `user *` | `adf.ts`, `history.ts`, `account.ts` | `describeText` (ADF → text) with its inline-container rule; history `normalizeField`/`touchesField`/sort; `assertAccountResponse` (the login-page check); the `users` array-or-`values` normalisation                                                           |
| 2d  | `board list`, `sprint *`                          | `agile.ts`                           | `numericId` (today exported from the `sprint list` _command_ and imported by `sprint add` — a command-to-command import that should not exist); the 50-per-request chunk accounting                                                                             |
| 2d  | `confluence page *`                               | `confluence-pages.ts`                | default `expand` selection by body format, `webUrl`, the storage-vs-markdown choice                                                                                                                                                                             |
| 2e  | `issue delete`, `comment delete`, `link *`        | —                                    | audit only: expected to be thin already (`issue-links.ts` is in core after phase 1). Anything found is hoisted the same way                                                                                                                                     |

Two rules shape the operation signatures, both because of the MCP:

1. **Build and send are separate functions.** `--dry-run` today prints the body the command
   assembled and returns before any request. If core exposes `buildX(...)` (pure) and the client
   method sends, both the CLI and the MCP implement dry-run as "build, don't send" and the
   "no HTTP request is made under dry run" test lives in core once.
2. **Operations return data, never strings destined for a terminal.** Rendering stays in the
   command (`formatKeyValue`, `this.log`). Where the human view is itself the value — the curated
   `issue view` fields, the `history` lines — the operation returns the `Pair[]`/rows and the CLI
   formats them; the MCP can return the same rows as text. Output text is unchanged because the
   formatters are.

Phase 2 does **not** move help text, flag definitions, or `Command` subclasses; those are the CLI.
It does not add anything to `command-snapshot.json`.

### Phase 3 — the MCP server imports core (revises 0007)

Not designed here; recorded so phase 2's API is shaped for it. The follow-up to 0007 replaces
`src/cli.ts` (spawn) with direct calls, keeps everything else PR #11 decided — the tool catalogue
and `<product>_<noun>_<verb>` names, read-only by default with `--allow-writes`, `dryRun`/`confirm`
inputs, the confirm gate, and the `isError` result shape — and remaps error _classes_ instead of
exit codes (`ConfigError` → `config`, `AuthError` → `auth`, everything else → `error`). The MCP
package's dependency becomes `@simplysf/simply-atlassian-core`, not the CLI; `--timeout` becomes
an `AbortSignal` on the transport or is dropped in favour of the transport's own 30 s deadline.
The catalogue-equals-snapshot test can still read the sibling package's `command-snapshot.json`
from the repo at test time; it just stops being a runtime dependency.

The seven agile/open/history commands that landed after PR #11 branched (28 commands today, 21
in its catalogue) get tools in that follow-up as well; `open` tools return the URL rather than
launching a browser, which is why `atlassian-url.ts` is in core and `open-in-browser.ts` is not.

## Alternatives considered

**Keep spawning the CLI (0007 as it stands).** Works, and is the right first step if the MCP
needs to ship before phase 2 is done — see Sequencing. Rejected as the end state: a process and an
oclif config load per tool call, an MCP package that installs oclif, and stdout/stderr parsing to
recover what the CLI already had as objects. The user-visible symptom is latency on every call.

**Import from `@simplysf/simply-atlassian` directly, no new package.** The CLI already exports
the client layer, and phase 2 could hoist operations into the CLI's own `index.ts`. Rejected:
the MCP would still depend on an oclif package; `simply-node`'s 0019 already made the case for a
library that is not a CLI; and the lint-enforced "no terminal in core" rule needs a package
boundary to bite on — inside one package it is just a convention.

**Two core packages (`simply-jira-core`, `simply-confluence-core`).** Rejected for now: config,
auth, HTTP, errors, text, and JSON input are shared, so a split would need a third package under
both. One package with a flat layout is the `simply-node` shape. Revisit if the Confluence
surface (0008) grows a dependency the Jira side does not want.

**Leave `output.ts`/`issue-table.ts` in the CLI.** They are terminal formatting. Kept in core
because they are pure functions of data, 0007's open question 5 asked for the curated view to be
reusable by tools, and moving them later would be a breaking change to a published package
whereas keeping them costs nothing.

**A `testing` subpath export in phase 1.** Deferred to phase 3 (see Tests); two copies of an
80-line fake server is cheaper than a published test helper until a third consumer exists.

**Fold the split into PR #11's rebase.** Rejected: PR #11 touches only the MCP package and docs;
phase 1 touches only the CLI package and docs. They are independent and should stay that way.

## Implementation plan

### Before phase 1

- `packages/simply-atlassian-core/` already exists on disk as an untracked, gitignored leftover
  from an uncommitted attempt (`lib/`, `.wireit/`, `node_modules/`, `.eslintcache`,
  `tsconfig.tsbuildinfo`, empty `src/` and `test/`). Delete it; nothing in it is source.
- Decide Sequencing (below) for PR #11 and the 0008 branch.

### Phase 1 (one PR)

1. Scaffold `packages/simply-atlassian-core`: `package.json`, `tsconfig.json`, `.gitignore`,
   `README.md` (with an `## API` section, one row per export, modelled on `simply-aep-core`),
   `CONTRIBUTING.md` (the "this is a library, not a CLI" stub from `simply-aep-core`, reworded).
2. `git mv` the fifteen files in the table above; fix their relative imports.
3. Write `src/index.ts` (the barrel) and `test/index.test.ts` (the exported-keys pin).
4. `git mv` the matching tests; add `test/support.ts`; shorten their imports.
5. In the CLI: add the workspace dependency; rewrite imports in `commands/**` and
   `base-command.ts`; re-point `src/index.ts`; add the wireit cross-package dependencies; move
   `test/core/support.ts` to `test/support.ts` and fix the command tests' imports; delete the
   now-empty `src/core/`.
6. Root wiring: add `'packages/simply-atlassian-core'` to `allPackages` in `eslint.config.mjs`,
   and add a core-scoped `no-restricted-imports` entry banning `@oclif/core` and
   `node:child_process` (the enforcement of the Decision's rule). Root `tsconfig.json` and
   `vitest.config.ts` need nothing — both glob `packages/*`. `scripts/reset.mjs` likewise.
7. `scripts/smoke-test.mjs` imports from core.
8. Docs: package tables in root `README.md` and `CONTRIBUTING.md`; `AGENTS.md`'s documentation
   map; the design index; a note on 0001's "separate package — premature" alternative pointing
   here; 0007's open question 1 pointing here.
9. `pnpm install` (lockfile), `pnpm run build`, `pnpm test`; confirm
   `git diff --exit-code -- "**/command-snapshot.json"` and `packages/simply-atlassian/README.md`
   are clean, which is the proof that nothing user-visible moved.

Commit as `feat(simply-atlassian-core): extract the client core and shared logic from the CLI`
plus `refactor(simply-atlassian): consume @simplysf/simply-atlassian-core`. Lerna's independent
versioning publishes core at 0.1.0 and bumps the CLI's minor; `workspace:^0.1.0` is rewritten to a
real range at publish time by pnpm.

### Phase 2 (five PRs, 2a–2e, in that order)

Each: add the core module and its tests; rewrite the affected commands to call it; run the
package's existing command tests unchanged; extend the barrel, `README.md` `## API`, and
`test/index.test.ts`. 2a first because every later PR's write commands use `assertWritesAllowed`
and the MCP gate needs it earliest.

### Phase 3

A revision of 0007 (status back to Draft for the changed sections), then the MCP PR. Out of
scope here.

### Sequencing with open branches

- **`feat/mcp-server-tools` (PR #11, spawn-based MCP).** Independent of phase 1 (no CLI source
  overlap). Recommended: rebase and land it first — it is finished work, gives a usable MCP now,
  and its catalogue, gate, and result mapping survive phase 3 unchanged. If it is not going to
  land, phase 3 starts from it anyway.
- **0008 (Confluence writes, PR #16)** landed first, while this doc was in review. Its new
  `shared/confluence-body.ts` and the `pageIdForInstance` addition to `atlassian-url.ts` moved to
  core in the same phase 1 PR after a rebase; its five new commands were rewritten like the others.

## Testing

- **Core:** the moved tests, unchanged in substance. `test/index.test.ts` pins runtime exports.
  Phase 2 adds per-module tests for each hoisted operation, including the "build produces this
  body and no request is sent" cases that today live in `write-safety.test.ts`/`writes.test.ts`.
- **CLI:** every existing command test runs unmodified apart from import paths; that is the
  regression net for all three phases. `test/index.test.ts` asserts the compatibility re-exports.
- **Lint as a test:** the core-scoped `no-restricted-imports` rule fails the build if anyone
  imports oclif or `child_process` into core.
- **CI:** `test.yml` already runs `pnpm run build` + `pnpm test` per package on Linux and Windows
  and verifies committed snapshots; no workflow change. `docs.yml` triggers on
  `packages/*/README.md`, so core's README is covered.

## Open questions

1. **Stub the CLI's `src/index.ts` (`export default {}`) instead of re-exporting?** That is the
   `simply-plugins` shape and would stop the CLI advertising a library surface it no longer owns.
   It is a breaking change for the CLI package (0.x, so a minor bump under conventional commits).
   Recommendation: re-export for phase 1, stub in phase 3 once the MCP no longer depends on the
   CLI, and say so in the CLI's changelog.
2. **Rename `CliError`.** A base class called `CliError` in a library is a misnomer. Renaming it
   (`AtlassianError`, with `CliError` kept as an alias for one release) is cheapest before the
   package has external consumers. Deferred out of phase 1 deliberately: `whoami` throws a bare
   `CliError`, whose `name` reaches the CLI's `--json` error output, so a rename is not the
   zero-observable-change phase 1 promised. Decide it alongside phase 2a, where the error surface is
   being reshaped anyway.
3. **`json-input.ts` error text names `--body`/`--body-file`.** Correct for the CLI, wrong for an
   MCP input called `body`. The `label` parameter already exists; phase 3 passes its own. No
   phase 1 change.
4. **Does core publish from 0.1.0 or track the CLI's 0.5.x?** Independent versioning says 0.1.0;
   the package has no consumers outside this repo yet. Recommendation: 0.1.0.
