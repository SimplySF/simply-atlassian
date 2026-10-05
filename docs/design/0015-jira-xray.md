# 0015 — Xray test management under `jira xray`

**Status:** Implemented (core PR #45; CLI commands and MCP tools PR #46; docs PR #49)
**Package:** `packages/simply-atlassian-core` (field discovery, client, behaviour);
`packages/simply-atlassian` and `packages/simply-atlassian-mcp` (surfaces)
**Date:** 2026-10-02, revised 2026-10-02 after review, corrected 2026-10-05 to match the implementation

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

Endpoint, field-type and JQL-function names below have been confirmed
(see [Facts to confirm](#facts-to-confirm)).

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

| Role                | Field schema type (`com.xpandit.plugins.xray:…`)        | On issue type |
| ------------------- | ------------------------------------------------------- | ------------- |
| `testType`          | `test-type-custom-field`                                | Test          |
| `steps`             | `manual-test-steps-custom-field`                        | Test          |
| `cucumberType`      | `automated-test-type-custom-field` (Scenario / Outline) | Test          |
| `cucumberScenario`  | `steps-editor-custom-field`                             | Test          |
| `genericDefinition` | `path-editor-custom-field`                              | Test          |
| `preconditions`     | `test-precondition-custom-field`                        | Test          |
| `testSets`          | `test-sets-custom-field`                                | Test          |
| `testPlans`         | `test-plans-associated-with-test-custom-field`          | Test          |
| `repositoryPath`    | `test-repository-path-custom-field`                     | Test          |
| `testSetTests`      | `test-sets-tests-custom-field`                          | Test Set      |
| `testPlanTests`     | `tests-associated-with-test-plan-custom-field`          | Test Plan     |

Any other field with the `com.xpandit.plugins.xray:` prefix is still recorded in the instance
record, with no role, so it can be requested by name through `--fields`. This way a new Xray
version that adds fields does not need a CLI release before those fields can be read.

Roles arrived over several Xray versions: manual steps and the core types in 1.x, Cucumber types
in 2.x, called tests and the test repository (`repositoryPath`) in 3.x–4.x, and datasets in 5.x. On
an older Xray a later role is simply not discovered. A command that needs a missing role, such as
`--path` or `path list` without `repositoryPath`, fails with a `ConfigError` that names the role
and the Xray version that introduced it.

The issue type names (Test, Test Set, Test Plan, Test Execution, Precondition) can be changed in
Xray's settings too, so they are discovered the same way. Xray has no settings endpoint for the
mapping, but Jira's `GET /rest/api/2/issuetype` lists every issue type, and Xray's are recognisable
whatever they are called: each has a constant `iconUrl` served by the Xray plugin and a description
that starts "Represents a Test…". Each type is mapped to its role by those two properties, never by
name, and the ambiguity and `overrides` rules below apply to issue types as they do to fields. The
description is checked first; a type whose description was edited is still recognised by its icon,
which must be served from a path containing `com.xpandit.plugins.xray` and whose file name carries
the role (`testplan`, `testset`, …).

The Xray version is read from `GET /rest/plugins/1.0/com.xpandit.plugins.xray-key`. That endpoint
often needs administrator rights, so a failure records `null` and never stops discovery; the version
is informational only.

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
  "fieldNames": { "customfield_12100": "Manual Test Steps", "…": "…" },
  "issueTypes": { "test": "Test", "testSet": "Test Set", "testPlan": "Test Plan" },
  "ambiguous": { "fields": {}, "issueTypes": {} },
  "overrides": { "fields": {}, "issueTypes": {} }
}
```

`fieldNames` holds every Xray field's display name, so `--fields` can resolve Xray names with no
request. `ambiguous` holds the candidates for any role more than one field or type claimed, and
`overrides` is written empty so a person can see where a pin goes.

- **When discovery runs.** The first time an Xray command is used against an instance, discovery
  runs once and saves the record. Later commands read the record and make no discovery request.
- **Refreshing.** `jira xray fields --refresh` rediscovers and rewrites the record. A command whose
  query fails because a recorded field id is gone (Jira reports it as an unknown field) rediscovers
  **once** and retries. A second failure is reported as a normal error. This covers a reinstall or
  upgrade without the user having to know the cache exists. "Fails because of the record" means a
  400 whose text names a recorded field id, or a recorded issue type name alongside `issuetype`.
  The retry happens only if no page has been emitted yet, so a streaming export never repeats one.
- **A corrupt record is an error, not a cache miss.** A record file that is not valid JSON may hold
  hand-edited overrides, so the command stops and names the file instead of silently rediscovering
  and overwriting it.
- **Overrides survive refreshes.** An `overrides` object in the record, edited by hand, beats
  discovery and is kept when the record is rewritten. This is the fix for the ambiguity case below.
- **Ambiguity.** If two fields share one role's schema type (it happens after an app reinstall
  leaves orphaned fields), discovery does not guess. It records both. Commands that need that role
  fail with a `ConfigError` that names both field ids and the record's path, and says how to pin
  one in `overrides`.
- **No cache.** If the cache directory cannot be written (read-only home, sandboxed agent),
  discovery still runs and its result is used for the current process; only saving it fails, with
  one line on stderr. A file the CLI cannot write must not stop a read. Saving is atomic (a
  temporary file renamed into place).

Core is still forbidden from touching terminals and processes, as 0012 requires. The record's
directory is passed in by the caller, and reading the environment goes through the usual `env`
parameter: core exports `defaultXrayCacheDir(env)`, which the CLI and the MCP server both use, and
the backend reports an unsaved record through an `onWarning` callback rather than writing anywhere.

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
dropped. Role and Xray names resolve from the record; any other name needs the instance's field list
(Jira's `fields` parameter takes ids, so "Story Points" must become `customfield_…`), which is
fetched once, and only when such a name is present. A display name two fields share is an error that
lists both ids. With `--fields` alone, the defaults are the minimum each command needs (shown per command
below). A separate `--only-fields` flag can come later if replacing the defaults turns out to be
needed (open question).

On the table commands (`test list`, `plan list`, `set list`), each requested field becomes an extra
column. On `test get` and `test export`, requested fields go into a `fields` object in each record,
keyed by the name the caller used.

### Scopes and filters (shared by `test list` and `test export`)

Exactly **one scope** is required:

| Scope flag                           | Tests it selects                                                | How                                                |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------- |
| `--project <key>`                    | Every Test in the project                                       | JQL `project = X AND issuetype = <test type>`      |
| `--plan <key>`                       | Tests in the plan, **including those added through a Test Set** | `testPlanTests("KEY")` JQL function                |
| `--set <key>`                        | Tests in the set                                                | `testSetTests("KEY")` JQL function                 |
| `--path <folder>` (with `--project`) | Tests in a repository folder; `--recursive` includes subfolders | `testRepositoryFolderTests("X", "folder", "true")` |

`testRepositoryFolderTests` takes the path as a string, with `""` meaning the repository root, so
`--path /` becomes `""`. Other paths are accepted with or without a leading slash and passed as
given. `/` is always a folder delimiter, so a folder name cannot contain one. Any other character is
escaped with standard JQL string quoting, as `--search` is. Its recursive argument must be a quoted string (`"true"` or `"false"`),
not a bare boolean; `--recursive` sets `"true"` and its absence sets `"false"`.

`--recursive` without `--path`, `--path` without `--project`, and more than one of `--project`,
`--plan` and `--set` are all configuration errors. Plan, set and `--linked-to` values must be shaped
like issue keys, and `--project` like a project key.

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

A trailing `ORDER BY` in `--jql` is moved to the end of the combined query, where JQL requires it;
without one, results are ordered `ORDER BY key ASC` so a paged export is stable.

**When JQL is not enough.** All three JQL functions exist on current Xray DC. If one is missing on
an older installed version, the scope falls back to the matching Xray REST call:

- plan: `GET /rest/raven/1.0/api/testplan/{key}/test`
- set: `GET /rest/raven/1.0/api/testset/{key}/test`
- path: `GET /rest/raven/1.0/api/testrepository/{project}/folders/{id}/tests`

That call yields a list of keys, which is then searched as `key in (…)` in chunks of 100 so the
filters still apply. The path fallback finds the folder's id by walking the repository tree. Every
`key in (…)` search, here and for called tests, is sent with `validateQuery=false`, so a key the
caller cannot see is skipped rather than failing the whole query. A fallback stopped by `--limit`
with chunks still unsearched reports itself incomplete, conservatively. Which route was used is an internal detail. Both give the same result, and
tests cover both.

**Plan → Set → Test.** A Test Set can be added to a plan, but Xray expands it on the way in: the
plan's tests field then holds the set's individual Test keys and never the set's own key. So
`--plan` needs no set expansion of its own; `testPlanTests` already returns every test, however it
was added. Because Xray keeps no record of which tests arrived through a set, the CLI cannot tell a
directly added test from one added through a set, and does not try. A test's own `sets` field shows
which sets contain it, which is the closest available answer.

Paging, the total count and the truncation notice follow `issue search`.

### `test get <test>`

Takes an issue key. An issue whose type is not the discovered Test type is refused with a
`ConfigError` naming both types. The output covers:

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
action (added in Xray 3.x–4.x).

- **Detected** in either of the two forms Xray uses: a `testCallBean` property on the step object
  holding the called test's key, or, in older data, action text of the form `Call Test PROJ-9`,
  matched by regex. `testCallBean` wins when both are present.
- **Rendered:** a calling step renders as `→ calls PROJ-9 "Log in as admin"`, not as an empty row.
- **`--expand-calls`:** inlines the called test's steps in place, numbered `3.1`, `3.2`… and
  marked with the called key. Expansion is recursive.
  - It stops at a cycle (A calls B calls A) and marks the step `↺ cycle: PROJ-9`.
  - It also stops at a depth of 5, overridable with `--max-call-depth`: the top test's calls are
    level 1, and a call at a level beyond the limit is marked `… (call depth limit reached)`. Its
    summary is null, because that level is never fetched.
  - A called test the user cannot see is marked `⚠ not accessible: PROJ-9`.

  None of these stops is an error, because a partial export is more useful than none.

- Called tests are fetched in batches (one `key in (…)` search for each level of calls), not one
  at a time. Without `--expand-calls` only the first level is fetched, for the summaries the call
  rows show. Preconditions ride along in the first level's search, for their summaries.

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
  "preconditions": [{ "key": "PROJ-3", "summary": "Admin account exists" }],
  "steps": [
    { "index": "1", "action": "Open Users", "data": "", "result": "List shown", "attachments": [] },
    { "index": "2", "call": { "key": "PROJ-9", "summary": "Log in as admin" }, "steps": [] }
  ],
  "definition": null,
  "links": [
    {
      "type": "Tests",
      "direction": "outward",
      "relationship": "tests",
      "key": "PROJ-40",
      "issueType": "Story",
      "status": "Done",
      "summary": "…"
    }
  ],
  "plans": ["PROJ-7"],
  "sets": ["PROJ-31"],
  "fields": { "components": ["Accounts"] }
}
```

The `steps` array of a call entry stays empty unless `--expand-calls` is given. A call entry whose
expansion stopped carries `"stop": "cycle" | "depth" | "inaccessible"`. Action steps list their
attachments by file name. Links carry the phrase read from this test's side (`relationship`) and the
other issue's status, which the human view shows. Values in `fields` are simplified: a named Jira
object becomes its name, so components read `["Accounts"]`.

- **`--format`:**
  - `json` (default): one array.
  - `jsonl`: one record per line. This streams as pages arrive and suits large exports and
    pipelines.
  - `markdown`: one section per test, readable by people and models.

  All three write to stdout. `--json` returns `{ records, total, complete, notes }` instead, so a
  caller can detect truncation; the MCP tool returns the same object.

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
  `--json` returns the nested structure. Paths are written the way Xray stores them, as a
  string with a leading slash (`/O&M/Accounts`), and `--path` accepts them with or without the leading slash.

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
- `--xray` exists on both the `simply-atlassian-mcp` binary and `simply atlassian mcp`, whose
  `--list` honours it.

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

**Fetch steps per test through `/rest/raven/1.0/api/test/{key}/step`.** Rejected: it means N+1
requests on export, and it is not needed, because the steps field returned by `/rest/api/2/search`
contains the full steps.

**Keep raw JSON for `test get --json`, as 0011 does.** Rejected, for the reason given under
`test get`. `--raw` keeps access to the raw issue.

**One `test list` with `--full` instead of a separate `export`.** Considered. They share all their
scope and filter code. They are kept separate because they differ in output contract, default limit
and cost: a table of 25 rows versus 1000 assembled records. One command with a flag that changes
all three would be hard to document.

## Implementation plan

**Core (`packages/simply-atlassian-core/src`)**

0. `jira-client.ts`: `getIssueTypes()`, `getFromRoot()` (a GET on an absolute path, for
   `/rest/raven/1.0` and the plugin endpoint), and a Server/DC-only `validateQuery` search option.
1. `xray-fields.ts`:
   - the role → schema-type table and `discoverXrayFields(client)` (on top of `listFields`);
   - issue-type discovery from `/rest/api/2/issuetype` by `iconUrl` and description (a new
     `listIssueTypes` beside `listFields` in `jira-discovery.ts`);
   - `XrayInstanceRecord` with load and save (directory passed in; atomic write; tolerant of an
     unwritable directory);
   - `resolveFieldNames(record, names)` for `--fields`;
   - the ambiguity and override rules.
2. `xray-backend.ts`: the `XrayBackend` interface and `XrayServerBackend`.
   - It sends Jira searches through `JiraClient.searchAllIssues` with discovered fields.
   - Its REST fallbacks (plan, set and repository) go to `/rest/raven/1.0` on the Jira host.
   - It re-discovers once on an unknown-field error.
   - `createXrayBackend` throws the Cloud `ConfigError`.
3. `xray-scope.ts`: scope and filter → JQL (with parenthesising and escaping), and the key-list
   fallback.
4. `xray-tests.ts`:
   - step and definition parsing;
   - call detection and batched `--expand-calls` with cycle and depth handling;
   - the export record builder;
   - the Markdown renderer.
5. `xray-catalogue.ts`: `plan list`, `set list`, `path list`, and the rows `fields` shows;
   `xray-folders.ts`: the tolerant folder-tree reader shared by `path list` and the path fallback.
6. `index.ts` exports. Xray routes and fixtures for the fake instance in `testing.ts`, including an
   instance whose Xray fields carry non-default ids and names (`routeXrayDiscovery`,
   `routeJiraSearch`, `xrayFixtureIssue`).

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

It did not ship that way. The MCP catalogue test requires every CLI command to have a tool, so CLI
commands and their MCP tools must land in the same commit. It shipped as three stacked PRs: core
(#45), the CLI commands and MCP tools together (#46), then docs (#49).

## Testing

All against `startTestServer` from `@simplysf/simply-atlassian-core/testing`. Fixtures use
deliberately unusual field ids and renamed fields, so nothing passes by accident on default values.

- **discovery:**
  - Roles are mapped by schema type, even when fields are renamed.
  - Renamed Xray issue types are found by `iconUrl` and description.
  - A command that needs a role the instance lacks fails with a `ConfigError` naming the role and
    the version that introduced it.
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
  - A plan to which a Test Set was added returns the set's tests.
  - Path with and without `--recursive` (sent as `"true"` / `"false"`), and `--path /` as `""`.
- **called tests:**
  - A calling step is detected and rendered, in both the `testCallBean` and `Call Test KEY` forms.
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

- **Confirmed: the `com.xpandit.plugins.xray:*` schema types in the role table.** The first draft
  had `steps`, `cucumberType`, `cucumberScenario` and `testPlanTests` wrong and `testSets` and
  `testSetTests` swapped; the table now shows the verified types.
- **Confirmed: the Xray version that introduced each role.** Manual steps and core types arrived in
  1.x, Cucumber in 2.x, called tests and repository paths in 3.x–4.x, and datasets in 5.x.
- **Confirmed: the steps field returned by `/rest/api/2/search` contains the full steps.** Export
  is one request per page; no per-test fallback is needed.
- **Confirmed: how a "call test" step is represented.** A `testCallBean` property on the step holds
  the called key; older data uses `Call Test KEY` action text. Called tests need Xray 3.x–4.x.
- **Confirmed: the JQL functions and their signatures.** `testPlanTests("PLAN")`,
  `testSetTests("SET")` and `testRepositoryFolderTests("PROJECT", "PATH", "RECURSIVE")` exist; `""`
  is the root path, and the recursive argument is a quoted string.
- **Confirmed: the REST fallbacks under `/rest/raven/1.0`** work as listed.
- **Confirmed: a plan can include a Test Set, which Xray expands.** The plan's tests field lists
  the individual Test keys, never the set's key.
- **Confirmed: issue types are discoverable, but not through Xray.** `/rest/raven/1.0` has no
  settings endpoint (404); Jira's `/rest/api/2/issuetype` identifies Xray's types by their constant
  `iconUrl` and "Represents a Test…" description.
- **Confirmed: how repository paths are shown and escaped.** They are stored as a string with a
  leading slash (`/NewFolder`), and `testRepositoryFolderTests` accepts them with or without that
  slash. `/` is always a delimiter, and other characters use standard JQL string escaping.

## Open questions

- **`--only-fields`**, to replace the default fields instead of adding to them. Wait for a request.
- **Precondition, Test Execution and Test Run reads.** `execution runs`, and preconditions as a
  scope of their own. These fit naturally with the deferred writes.
- **Exporting attachments.** Step attachments are listed by name; downloading them is a separate
  decision about where files go.
- **Parameterised tests and datasets.** When a called test takes parameters, should
  `--expand-calls` substitute the values? Datasets need Xray 5.x. The answer depends on how they
  are represented, which is not yet known.
- **Sharing the instance record across a team**, so one person's `overrides` can be committed to a
  repo and used by CI. This would probably be an `--xray-record <path>` flag. Wait until someone
  needs it.
- **Xray Cloud and writes**, deferred above, each with its own revision of this doc when needed.
