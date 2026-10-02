# 0015 — Xray test management under `jira xray`

**Status:** Draft
**Package:** `packages/simply-atlassian-core` (field discovery, client, behaviour);
`packages/simply-atlassian` and `packages/simply-atlassian-mcp` (surfaces)
**Date:** 2026-10-02, revised 2026-10-02 after review

## Problem

[Xray](https://www.getxray.app/) is the test-management app most Jira shops use, and nothing here
can talk to it. Its objects (Test, Test Set, Test Plan, Test Execution, Precondition) are Jira
issues, so `jira issue view` and `jira issue search` already read their summary, status and labels.
What makes them _tests_ is unreadable today:

- a test's steps;
- the requirement or bug it verifies;
- which plans and sets contain it;
- where it sits in the test repository.

All of that lives in Xray custom fields and Xray's REST API.

Three findings from teams who have scripted against Xray Server/Data Center shape this design:

- **Xray's Jira field ids depend on the instance.** They are assigned when the app is installed,
  so `customfield_12345` holds the manual steps on one instance and something else on the next.
  Scripts only worked after someone found the right ids by looking for fields whose schema type is
  `com.xpandit.plugins.xray:*`.
- **People do not start from a test key.** They start from a project, a plan, a set, or a
  repository folder ("path"). A test is often reachable only indirectly, for example
  Plan → Set → Test.
- **Reading one test at a time is not enough.** The real job is _exporting_ a body of tests, scoped
  to a project, plan, set or path, and often filtered further. In a poorly organised project the
  only reliable filter may be a keyword in the title or description, or "tests linked to these
  stories".

Xray is also the first Marketplace app this CLI supports, so where it goes sets the pattern for the
next one.

## Decision

Xray is a **subtopic of Jira**: `simply atlassian jira xray <noun> <verb>`. As always, behaviour
goes into `simply-atlassian-core` first and is then exposed through the CLI and the MCP server. The
rule this sets for later apps: **an app lives under the product that hosts it** (`jira tempo …`,
`confluence drawio …`), not next to Jira and Confluence as a product of its own.

**Scope for this version: Xray Server/Data Center, reads only.** Xray Cloud and every write
command are deferred, because no one needs them yet. The design keeps room for both (see
[Deferred](#deferred)), but none of it is built speculatively.

The first version adds seven read commands:

| Command                         | What it answers                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `jira xray fields`              | Which Jira fields hold Xray's data on this instance (discovered, then cached)   |
| `jira xray test get <test>`     | One test: type, steps (with called tests), definition, links, plans, sets, path |
| `jira xray test list <scope>`   | A table of tests in a project, plan, set or path, with optional filters         |
| `jira xray test export <scope>` | Full test records for the same scopes and filters, in bulk                      |
| `jira xray plan list`           | Test plans in a project                                                         |
| `jira xray set list`            | Test sets in a project                                                          |
| `jira xray path list`           | The test repository's folder tree for a project                                 |

Execution and run reads (`execution runs`) are left out too. Nobody asked for them in review, and
they fit naturally with the deferred write commands.

**Field discovery is the foundation.** Everything else is either a Jira search that asks for the
discovered Xray fields, or one of a small number of Xray REST calls under `/rest/raven/1.0`. The
search approach is what makes bulk export practical: a page of 100 tests with their steps is one
request, instead of 101 (one search plus one steps call per test).

Endpoint, field-type and JQL-function names below come from Xray's public documentation. They
**must be confirmed** against a real DC instance before implementation (see
[Facts to confirm](#facts-to-confirm)).

## Behavior

### Connection

Unchanged from the rest of the Jira commands. Xray Server/DC is a plugin on the Jira host, so
`JIRA_URL` and `JIRA_PERSONAL_TOKEN` (or their flags) are all it needs. `XrayCommand extends
JiraCommand` and adds no connection flags.

If `JIRA_URL` points at a Cloud site (`*.atlassian.net`, by 0001's rule), every Xray command fails
with a `ConfigError` (exit 2): "Xray commands support Jira Server/Data Center only; Xray Cloud is a
separate API that is not supported yet." This check happens before any request is sent, so the
user does not get a confusing 404 from a `/rest/raven` path that does not exist on Cloud.

### Field discovery and the instance record

**What is discovered.** `GET /rest/api/2/field` (already wrapped by `listFields` in
`jira-discovery.ts`) is filtered to fields whose `schema.custom` starts with
`com.xpandit.plugins.xray:`. Each one is mapped to a stable **role** by its schema type, **never by
its display name**: names can be renamed and translated, but schema types cannot.

| Role                | Field schema type (`com.xpandit.plugins.xray:…`, confirm each) |
| ------------------- | -------------------------------------------------------------- |
| `testType`          | `test-type-custom-field`                                       |
| `steps`             | `steps-editor-custom-field`                                    |
| `cucumberType`      | `automated-tests-type-custom-field` (Scenario / Outline)       |
| `cucumberScenario`  | `automated-tests-custom-field`                                 |
| `genericDefinition` | `path-editor-custom-field`                                     |
| `preconditions`     | `test-precondition-custom-field`                               |
| `testSets`          | `test-sets-tests-custom-field`                                 |
| `testPlans`         | `test-plans-associated-with-test-custom-field`                 |
| `repositoryPath`    | `test-repository-path-custom-field`                            |
| `testSetTests`      | `test-sets-custom-field`                                       |
| `testPlanTests`     | `test-plan-custom-field`                                       |

Any other field with the `com.xpandit.plugins.xray:` prefix is still recorded in the instance
record, with no role, so it can be requested by name through `--fields`. This way a new Xray
version that adds fields does not need a CLI release before those fields can be read.

The issue type names (Test, Test Set, Test Plan, Test Execution, Precondition) can be changed in
Xray's settings too. They default to the standard names and can be overridden in the instance
record (see below). Xray does not expose that mapping through REST (confirm), so this one part is
configured, not discovered.

**The instance record.** Discovery results are saved as one JSON file per instance:

```
${XDG_CACHE_HOME:-~/.cache}/simply-atlassian/xray/<host>[_<path>].json
```

```json
{
  "jiraUrl": "https://jira.example.gov/jira",
  "discoveredAt": "2026-10-02T14:03:11Z",
  "xrayVersion": "7.4.0",
  "fields": { "steps": "customfield_12100", "testType": "customfield_12101", "…": "…" },
  "unmapped": { "customfield_12188": "com.xpandit.plugins.xray:some-new-field" },
  "issueTypes": { "test": "Test", "testSet": "Test Set", "testPlan": "Test Plan" }
}
```

- **When discovery runs.** The first time an Xray command is used against an instance, discovery
  runs once and saves the record. Later commands read the record and make no discovery request.
- **Refreshing.** `jira xray fields --refresh` rediscovers and rewrites the record. A command whose
  query fails because a recorded field id is gone (Jira reports it as an unknown field) rediscovers
  **once** and retries. A second failure is reported as a normal error. This covers a reinstall or
  upgrade without the user having to know the cache exists.
- **Overrides survive refreshes.** An `overrides` object in the record, edited by hand, beats
  discovery and is kept when the record is rewritten. This is where renamed issue types go, and the
  fix for the ambiguity case below.
- **Ambiguity.** If two fields share one role's schema type (it happens after an app reinstall
  leaves orphaned fields), discovery does not guess. It records both. Commands that need that role
  fail with a `ConfigError` that names both field ids and the record's path, and says how to pin
  one in `overrides`.
- **No cache.** If the cache directory cannot be written (read-only home, sandboxed agent),
  discovery still runs and its result is used for the current process; only saving it fails, with
  one line on stderr. A file the CLI cannot write must not stop a read.

Core is still forbidden from touching terminals and processes, as 0012 requires. The record's
directory is passed in by the caller (the CLI and the MCP server both default it as above), and
reading the environment goes through the usual `env` parameter.

**`jira xray fields`** shows the record as a table: role, field id, field name, schema type. It
also shows the unmapped Xray fields and the record's path. `--refresh` rediscovers first. `--json`
prints the record itself. This command is how a person checks what the CLI will query, and it
replaces the manual introspection described above.

### `--fields`: choosing what comes back

Every command that returns tests takes an optional `--fields`. Its values are combined with the
command's default set (it does not replace the defaults), comma-separated or repeated, like
`issue search --fields`. Three kinds of value are accepted:

- **Role names** from the table above (`steps`, `repositoryPath`, …), resolved through the instance
  record.
- **Display names of Xray fields**, including unmapped ones, resolved through the record.
- **Any Jira field id or name** (`components`, `labels`, `customfield_10400`, "Story Points"),
  passed to Jira as given.

`--fields` names that match nothing are reported as an error before the search runs, not silently
dropped. With `--fields` alone, the defaults are the minimum each command needs (shown per command
below). A separate `--only-fields` flag can come later if replacing the defaults turns out to be
needed (open question).

On the table commands (`test list`, `plan list`, `set list`), each requested field becomes an extra
column. On `test get` and `test export`, requested fields go into a `fields` object in each record,
keyed by the name the caller used.

### Scopes and filters (shared by `test list` and `test export`)

Exactly **one scope** is required:

| Scope flag                           | Tests it selects                                                     | How (confirm)                                           |
| ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `--project <key>`                    | Every Test in the project                                            | JQL `project = X AND issuetype = <test type>`           |
| `--plan <key>`                       | Tests in the plan, **including those it reaches through a Test Set** | `testPlanTests("KEY")` JQL function, plus set expansion |
| `--set <key>`                        | Tests in the set                                                     | `testSetTests("KEY")` JQL function                      |
| `--path <folder>` (with `--project`) | Tests in a repository folder; `--recursive` includes subfolders      | `testRepositoryFolderTests("X", "folder", "true")`      |

Then any **filters**, all optional, combined with AND:

| Filter flag          | Meaning                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--jql <clause>`     | Extra JQL ANDed onto the scope (the escape hatch for anything else)                                        |
| `--search <text>`    | Keyword in summary or description: `(summary ~ "t" OR description ~ "t")`                                  |
| `--linked-to <keys>` | Tests linked to any of these issues (stories, bugs, requirements), by any link type. Repeatable.           |
| `--limit <n>`        | Maximum tests to return. `test list` defaults to 25, like every list here. `test export` defaults to 1000. |

**JQL first.** Scopes and filters are written as one JQL query wherever Xray's JQL functions
allow. This means filtering happens on the server, paging is ordinary Jira search paging, and the
user's `--jql` is just ANDed on. The user's clause is wrapped in parentheses, so an `OR` inside it
cannot widen the scope. `--search` is escaped the same way `--jql` text is escaped elsewhere in
this repo. `--linked-to` becomes `issue in linkedIssues("K")` for each key, ORed together.

**When JQL is not enough.** If a JQL function is missing on the installed Xray version (confirm
which exist), the scope falls back to the matching Xray REST call:

- plan: `GET /rest/raven/1.0/api/testplan/{key}/test`
- set: `GET /rest/raven/1.0/api/testset/{key}/test`
- path: `GET /rest/raven/1.0/api/testrepository/{project}/folders/{id}/tests`

That call yields a list of keys, which is then searched as `key in (…)` in chunks of 100 so the
filters still apply. Which route was used is an internal detail. Both give the same result, and
tests cover both.

**Plan → Set → Test.** A plan can contain tests directly and through Test Sets. `--plan` returns
both, without duplicates. Each test records how it was reached: `via: "direct"`, or
`via: "set:PROJ-31"` (one entry per set when a test is reachable more than one way). `test list`
shows this as a `VIA` column. `--direct-only` limits the result to tests added to the plan itself.

Paging, the total count and the truncation notice follow `issue search`.

### `test get <test>`

Takes an issue key. The output covers:

- **Header:** type (Manual / Cucumber / Generic), status, summary, repository path.
- **Steps (Manual):** a table with `#`, action, data and expected result. Attachments are listed by
  name only.
- **Definition:** the Gherkin scenario or generic definition (Cucumber / Generic).
- **Preconditions:** key and summary of each.
- **Links:** every issue link, as link type with direction ("tests", "is tested by", "relates to",
  "is blocked by"…), key, issue type, status and summary. This is how the requirement or bug a test
  verifies is shown. Links are a standard Jira field, so they need no Xray endpoint.
- **Membership:** which plans and sets contain the test.

**Called tests (modular tests).** An Xray DC step can call another test instead of describing an
action (confirm the version that added this, and the shape of the step).

- **Detected:** a calling step renders as `→ calls PROJ-9 "Log in as admin"`, not as an empty row.
- **`--expand-calls`:** inlines the called test's steps in place, numbered `3.1`, `3.2`… and
  marked with the called key. Expansion is recursive.
  - It stops at a cycle (A calls B calls A) and marks the step `↺ cycle: PROJ-9`.
  - It also stops at a depth of 5, overridable with `--max-call-depth`.
  - A called test the user cannot see is marked `⚠ not accessible: PROJ-9`.

  None of these stops is an error, because a partial export is more useful than none.

- Called tests are fetched in batches (one `key in (…)` search for each level of calls), not one
  at a time.

`--json` returns the **export record** described next, not a raw payload. A test assembled from a
search, its steps and its membership has no single raw payload to pass through. This is different
from the raw-JSON rule in 0011 and is deliberate. `--raw` returns the underlying Jira issue for
anyone who wants it.

### `test export <scope>`

The bulk version of `test get`, using the scopes and filters above. It writes one **export record**
per test:

```json
{
  "key": "PROJ-12",
  "id": "10452",
  "summary": "Admin can reset a user's password",
  "status": "Ready",
  "type": "Manual",
  "path": "/O&M/Accounts",
  "via": ["direct"],
  "preconditions": [{ "key": "PROJ-3", "summary": "Admin account exists" }],
  "steps": [
    { "index": "1", "action": "Open Users", "data": "", "result": "List shown" },
    { "index": "2", "call": { "key": "PROJ-9", "summary": "Log in as admin" }, "steps": [] }
  ],
  "definition": null,
  "links": [{ "type": "Tests", "direction": "outward", "key": "PROJ-40", "issueType": "Story", "summary": "…" }],
  "plans": ["PROJ-7"],
  "sets": ["PROJ-31"],
  "fields": { "components": ["Accounts"] }
}
```

The `steps` array of a call entry stays empty unless `--expand-calls` is given.

- **`--format`:**
  - `json` (default): one array.
  - `jsonl`: one record per line. This streams as pages arrive and suits large exports and
    pipelines.
  - `markdown`: one section per test, readable by people and models.

  All three write to stdout.

- **`--expand-calls`** and **`--fields`** work as in `test get`.
- **Progress.** Pages are fetched sequentially at 100 tests per page, and progress goes to stderr
  (for example "fetched 300 of 1240"). An export that hits `--limit` says so on stderr and exits 0.
- **Data the user cannot see.** It is skipped and noted, never fatal: a called test the user cannot
  see, or a link to a project they cannot browse.

The export record's shape is our own and is **documented as a contract** in the Xray guide.
Changing a key's meaning or removing a key is a breaking change. This is the one place this CLI
defines its own schema instead of passing Atlassian's through. It is justified because the record
is assembled from several sources, and its whole point is to be consumed by scripts.

### `plan list`, `set list`, `path list`

These are the discovery commands. People do not know plan keys by heart.

- **`plan list --project <key>`**: key, summary, status, number of tests. `--jql`, `--search`,
  `--fields` and `--limit` work as in `test list`.
- **`set list --project <key>`**: the same columns, for Test Sets.
- **`path list --project <key>`**: the test repository's folder tree, with a test count for each
  folder. `--path <folder>` starts at a subfolder, and `--depth <n>` limits how deep it goes.
  `--json` returns the nested structure. Paths are written the way Xray shows them
  (`/O&M/Accounts`), and `--path` accepts them with or without the leading slash.

Each command's output feeds the next one: `plan list` → `test list --plan`, `path list` →
`test export --project X --path …`.

### Write safety

All seven commands are reads. None declares `isWrite`, and all of them work under
`ATLASSIAN_READ_ONLY`. The one thing they write is the local instance record, which is a cache, not
a change to Atlassian data, so the read-only guard does not apply to it.

### Commands, topics and MCP tools

```
simply atlassian jira xray fields --refresh
simply atlassian jira xray plan list --project OM
simply atlassian jira xray test list --plan OM-7 --search "password"
simply atlassian jira xray test export --project OM --path "/O&M/Accounts" --recursive --expand-calls --format jsonl
simply atlassian jira xray test export --project OM --linked-to OM-40,OM-41 --fields components,labels
```

New oclif topics:

- `atlassian:jira:xray`: "Read Xray tests, plans, sets, and repository paths (Server/Data Center)."
- `atlassian:jira:xray:test`
- `atlassian:jira:xray:plan`
- `atlassian:jira:xray:set`
- `atlassian:jira:xray:path`

The MCP server gets one `read` tool per command:

- `jira_xray_fields`
- `jira_xray_test_get`
- `jira_xray_test_list`
- `jira_xray_test_export`
- `jira_xray_plan_list`
- `jira_xray_set_list`
- `jira_xray_path_list`

How they are exposed:

- **They are registered only when the server is started with `--xray`.** A host lists every
  registered tool to its model, and most people running the server have no Xray. Detecting Xray
  from the environment does not work, because DC needs no Xray-specific settings.
- The **catalogue** still contains all seven, so the test that compares the catalogue with
  `command-snapshot.json` still holds. Only `selectTools` filters.
- `jira_xray_test_export` returns records as JSON and takes `limit`, which defaults to **100** in
  MCP. A host has to hold the whole tool result in context, so an agent should ask for more on
  purpose. `format` is not exposed.

## Deferred

### Xray Cloud

Xray Cloud is a separate service with its own host and its own API-key → token authentication. It
uses GraphQL, and GraphQL takes issue ids rather than keys. It also has no custom-field problem,
because GraphQL returns Xray data by name. Supporting it would need:

- an `XRAY_CLIENT_ID`/`XRAY_CLIENT_SECRET`/`XRAY_URL` config spec;
- a token cache;
- a second backend behind the operations in this doc.

The operations are written against an `XrayBackend` interface for that reason. It is an interface
with one implementation; the Cloud error message above becomes the place where the second one is
chosen. The earlier draft of this doc (PR #40, first commit) has the full Cloud design.

### Writes

The first draft's writes (`execution import`, `execution add`, `plan add`, `run update`) and their
reasoning are deferred together. Two points from that draft should carry forward when they are
picked up:

- Xray credentials have no read-only scope, so 0004's one real security boundary does not exist
  here.
- Importing JUnit, TestNG, NUnit, xUnit or Robot reports **creates** Test issues as a side effect.

The DC write endpoints would reuse the field discovery from this doc.

## Alternatives considered

**`simply atlassian xray …` as a sibling product.** Rejected. Xray is a Marketplace app, not an
Atlassian product, and on DC it is literally a Jira plugin that uses Jira's credentials. If the
depth turns out to bother people, an oclif alias can add the short form later.

**A separate repo or plugin.** Rejected. Field discovery, JQL search, paging, redaction and the
base command are all things this repo already has. A second repo would copy them or force them into
core's public API, and agents would have to configure a second MCP server.

**Hard-code the field ids, or require them in `.env` (`XRAY_STEPS_FIELD=customfield_…`).** Rejected.
It is the manual introspection reviewers had to do, moved into a config file that silently goes
stale on reinstall. Discovering by schema type, with `overrides` for the rare ambiguous case, gets
the same result with no setup.

**Look fields up by display name.** Rejected. Names are renamed and translated; schema types are
fixed by the app.

**Discover on every command, with no cache.** Rejected. It is one extra request per command, and on
large instances `/field` returns thousands of entries. The cache costs one file, and it refreshes
itself on the one failure that makes it stale.

**Store the record in the user's `.env` or in oclif's config directory.** Rejected:

- The `.env` is the user's file. Rewriting it from a cache refresh would be unwelcome, and it holds
  secrets the CLI should not be editing around.
- oclif's directory is unavailable to core and to the MCP server.

**Fetch steps per test through `/rest/raven/1.0/api/test/{key}/step`.** Rejected as the main route:
it means N+1 requests on export. It remains the fallback if the steps field value turns out not to
contain the steps on some Xray versions (confirm).

**Keep raw JSON for `test get --json`, as 0011 does.** Rejected, for the reason given under
`test get`. `--raw` keeps access to the raw issue.

**One `test list` with `--full` instead of a separate `export`.** Considered. They share all their
scope and filter code. They are kept separate because they differ in output contract, default limit
and cost: a table of 25 rows versus 1000 assembled records. One command with a flag that changes
all three would be hard to document.

## Implementation plan

**Core (`packages/simply-atlassian-core/src`)**

1. `xray-fields.ts`:
   - the role → schema-type table and `discoverXrayFields(client)` (on top of `listFields`);
   - `XrayInstanceRecord` with load and save (directory passed in; atomic write; tolerant of an
     unwritable directory);
   - `resolveFieldNames(record, names)` for `--fields`;
   - the ambiguity and override rules.
2. `xray-backend.ts`: the `XrayBackend` interface and `XrayServerBackend`.
   - It sends Jira searches through `JiraClient.searchAllIssues` with discovered fields.
   - Its REST fallbacks (plan, set and repository) go to `/rest/raven/1.0` on the Jira host.
   - It re-discovers once on an unknown-field error.
   - `createXrayBackend` throws the Cloud `ConfigError`.
3. `xray-scope.ts`: scope and filter → JQL (with parenthesising and escaping), the key-list
   fallback, and set expansion for plans with `via`.
4. `xray-tests.ts`:
   - step and definition parsing;
   - call detection and batched `--expand-calls` with cycle and depth handling;
   - the export record builder;
   - the Markdown renderer.
5. `xray-catalogue.ts`: `plan list`, `set list`, `path list` (the folder tree and counts).
6. `index.ts` exports. Xray routes and fixtures for the fake instance in `testing.ts`, including an
   instance whose Xray fields carry non-default ids and names.

**CLI (`packages/simply-atlassian`)**

7. `shared/base-command.ts`:
   - `XrayCommand extends JiraCommand` with `xray()`, which supplies the default cache directory;
   - the shared `scopeFlags` and `filterFlags`.
8. `src/commands/atlassian/jira/xray/{fields,test/get,test/list,test/export,plan/list,set/list,path/list}.ts`.
9. Topics in `package.json`. Run `pnpm run build` (regenerates `command-snapshot.json`) and
   `pnpm run readme`.
10. A new guide, `docs/guides/xray.md`, covering setup, field discovery and the record, the export
    record contract, and recipes (export a plan, find tests for a story).

**MCP (`packages/simply-atlassian-mcp`)**

11. `context.ts`: `xray()`. `tools.ts`: the seven read specs, marked `app: 'xray'`. `server.ts`:
    `selectTools(allowWrites, xray)` and an Xray line in `INSTRUCTIONS`. `bin/run.js`: `--xray`.
12. README tables, the MCP guide, and the root README's capability sentence.

**Docs:** this doc's status and the index row.

Suggested PR split:

- (a) field discovery, `fields`, `test get`;
- (b) scopes, filters, `test list`, `test export`, and the three list commands;
- (c) MCP.

## Testing

All against `startTestServer` from `@simplysf/simply-atlassian-core/testing`. Fixtures use
deliberately unusual field ids and renamed fields, so nothing passes by accident on default values.

- **discovery:**
  - Roles are mapped by schema type, even when fields are renamed.
  - Unmapped Xray fields are recorded.
  - Two candidates for a role produce the `ConfigError` naming both ids and the record path;
    `overrides` resolves it and survives a refresh.
  - An unwritable cache directory still lets the command succeed.
  - An unknown-field error triggers one rediscovery and a retry; a second failure surfaces.
  - The instance record makes later commands send no `/field` request.
- **Cloud refusal:** a `*.atlassian.net` URL produces a `ConfigError` with no request sent.
- **`--fields`:** role names, Xray display names, and plain Jira ids/names all resolve; an unknown
  name fails before the search; the requested fields become columns or appear in `fields`.
- **scopes:**
  - Each scope produces the expected JQL.
  - The user's `--jql` is parenthesised, so a test with `OR` in it cannot widen the scope.
  - `--search` text is escaped.
  - `--linked-to` handles several keys.
  - The REST fallback gives the same result as the JQL route.
  - Plan → Set → Test is deduplicated, `via` is correct for a test reachable two ways, and
    `--direct-only` works.
  - Path with and without `--recursive`.
- **called tests:**
  - A calling step is detected and rendered.
  - `--expand-calls` inlines recursively with `3.1`-style numbering.
  - Cycle, depth limit and inaccessible markers appear.
  - One search per call level.
- **export:**
  - Every record key is asserted (the contract).
  - `jsonl` streams per page.
  - Markdown renders.
  - `--limit` truncation is noted on stderr.
  - Progress goes to stderr only.
- **lists:**
  - `plan list` and `set list` include test counts.
  - `path list` shows the tree, `--depth` and `--path`, with or without a leading slash.
- **read-only:** every command runs under `ATLASSIAN_READ_ONLY`, and none is in the write list.
- **MCP:**
  - The seven tools are in the catalogue (the snapshot test still passes).
  - None is registered without `--xray`, and all are `read`.
  - Export's MCP `limit` defaults to 100.
- **live (manual), against a DC instance with Xray:**
  - Discover fields.
  - Export a plan that reaches tests through a set.
  - Export a path recursively with `--expand-calls`.
  - Find tests linked to a story with `--linked-to`.
  - Run `--search` against a messy project.

## Facts to confirm

These come from Xray's public documentation and have **not** been checked against a live instance:

- The `com.xpandit.plugins.xray:*` schema types in the role table, and which Xray version
  introduced each one.
- Whether the steps field's value, as returned by `/rest/api/2/search`, contains the full steps
  (action, data, result, and calls), or only a summary. This decides whether export is one request
  per page or needs the per-test fallback.
- How a "call test" step is represented, and the minimum Xray DC version that has it.
- Which JQL functions exist, and their exact signatures: `testPlanTests`, `testSetTests`,
  `testRepositoryFolderTests` (with its recursive argument).
- The REST fallbacks under `/rest/raven/1.0`: plan tests, set tests, repository folders and folder
  tests.
- That a plan can include a Test Set as a unit, and how that shows up in the plan's test list
  (already expanded, or as the set).
- Whether Xray's issue-type name mapping is readable through REST, which would let it be discovered
  instead of configured.
- How the repository path is shown, and how folder names with `/` are escaped.

## Open questions

- **`--only-fields`**, to replace the default fields instead of adding to them. Wait for a request.
- **Precondition, Test Execution and Test Run reads.** `execution runs`, and preconditions as a
  scope of their own. These fit naturally with the deferred writes.
- **Exporting attachments.** Step attachments are listed by name; downloading them is a separate
  decision about where files go.
- **Parameterised tests and datasets.** When a called test takes parameters, should
  `--expand-calls` substitute the values? It depends on how they are represented (confirm).
- **Sharing the instance record across a team**, so one person's `overrides` can be committed to a
  repo and used by CI. This would probably be an `--xray-record <path>` flag. Wait until someone
  needs it.
- **Xray Cloud and writes**, deferred above, each with its own revision of this doc when needed.
