---
title: Xray
description: Read Xray tests, plans, sets, and the test repository on Jira Server/Data Center, and export them in bulk as records with a documented shape.
---

[Xray](https://www.getxray.app/) keeps its tests, test sets, test plans, and preconditions as Jira
issues, so `jira issue view` already shows their summary and status. The parts that make them
tests live in Xray's own fields and API: a test's steps, its preconditions, the plans and sets
that contain it, and where it sits in the test repository. The `jira xray` commands read those.

They are **read-only** and support **Xray on Jira Server/Data Center** only. Xray Cloud is a
separate service with its own API, and is not supported yet: pointed at an `*.atlassian.net` site,
every `jira xray` command stops with a configuration error (exit code 2) before sending anything.

## Setup

There is nothing to set up beyond the Jira connection. Xray Server/Data Center is a plugin on the
Jira host, so `JIRA_URL` and `JIRA_PERSONAL_TOKEN` (or their flags) are all it needs. See
[Credentials](/guides/credentials/).

```sh
simply atlassian jira xray fields
```

## Field discovery and the instance record

Xray's Jira field ids are assigned when the app is installed, so the field holding a test's steps
is `customfield_12100` on one instance and something else on the next. Xray's issue types can be
renamed too. So the first `jira xray` command against an instance discovers them:

- **Fields** are recognised by their schema type (`com.xpandit.plugins.xray:…`), never by display
  name, because a field can be renamed or translated but its schema type cannot. Each is given a
  **role** — `steps`, `testType`, `repositoryPath`, and so on.
- **Issue types** are recognised by the description Xray installs ("Represents a Test…") or by the
  icon the plugin serves, never by name. An administrator can change both; if a type's description
  was edited and its icon replaced, it is not recognised, and the first command that needs it says
  so and shows the `overrides` entry to add (below).

The result is saved as an **instance record**, one JSON file per instance:

```
${XDG_CACHE_HOME:-~/.cache}/simply-atlassian/xray/<host>[_<path>].json
```

Later commands read the record instead of asking again. `jira xray fields` shows it: each role,
the field id and name behind it, the Xray fields no role claims, the issue types, and the record's
path. `--refresh` rediscovers, and `--json` prints the record itself.

You rarely need to refresh by hand. After a reinstall or an upgrade, Jira stops returning the
recorded field ids (it leaves unknown ids out rather than failing), or rejects a renamed issue type.
A command that sees either rediscovers once and retries.

If the cache directory cannot be written, the command still works; it prints one line on stderr
and uses the discovered layout for that run only.

### When two fields claim one role

A reinstall can leave an orphaned copy of a field behind, so two fields share a schema type.
Discovery does not guess between them. A command that needs that role stops and names both ids
and the record's path. Pin the right one in the record's `overrides`, which every later refresh
keeps:

```json
{
  "overrides": {
    "fields": { "steps": "customfield_12100" },
    "issueTypes": {}
  }
}
```

The same works for an issue type, by name: `"issueTypes": { "test": "Prüfung" }`.

### When a field is missing

Older Xray releases lack some of these fields, and a role the instance does not have is simply not
found. A command that needs it, such as `--fields repositoryPath` on an instance without it, stops
with an error that names the role. Where the release that added the field is known (the repository path
arrived in Xray 3.0.0), the error compares it with your installed version: on an older Xray it
says an upgrade is needed; on a newer one it says discovery missed the field. Then run
`jira xray fields --refresh`, and if the field does exist and is still not recognised, pin its id
in `overrides` as above.

## Commands

| Command                         | What it answers                                                            |
| ------------------------------- | -------------------------------------------------------------------------- |
| `jira xray fields`              | Which Jira fields hold Xray's data on this instance                        |
| `jira xray test get <test>`     | One test: type, steps, definition, preconditions, links, plans, sets, path |
| `jira xray test list <scope>`   | A table of tests in a project, plan, set, or folder                        |
| `jira xray test export <scope>` | Full test records for the same scopes, in bulk                             |
| `jira xray plan list`           | Test plans in a project, with test counts                                  |
| `jira xray set list`            | Test sets in a project, with test counts                                   |
| `jira xray path list`           | The test repository's folder tree for a project, with test counts          |

Each command's output feeds the next: `plan list` gives the key `test list --plan` takes, and
`path list` gives the path `test export --project X --path` takes.

## Scopes and filters

`test list` and `test export` need exactly one **scope**:

| Scope                             | Selects                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| `--project <key>`                 | Every Test in the project                                       |
| `--plan <key>`                    | The plan's tests, **including those added through a Test Set**  |
| `--set <key>`                     | The set's tests                                                 |
| `--project <key> --path <folder>` | Tests in a repository folder; `--recursive` adds its subfolders |

A folder path is written the way Xray stores it, `/O&M/Accounts`. The leading slash is optional,
and a trailing or doubled slash is ignored; `/` is the repository root. `/` always separates
folders, so a folder name cannot contain one.

Then any **filters**, ANDed together:

| Filter               | Narrows to                                                                         |
| -------------------- | ---------------------------------------------------------------------------------- |
| `--jql <clause>`     | Any extra JQL. It is parenthesised, so an `OR` inside it cannot widen the scope    |
| `--search <text>`    | Text in the summary or description, matched as typed                               |
| `--linked-to <keys>` | Tests linked to any of these issues, by any link type. Comma-separated or repeated |

The scope and filters become one JQL query, so filtering happens on the server and paging is
ordinary Jira paging. Results are ordered by key unless `--jql` ends in its own `ORDER BY`.

`--search` treats its text literally: characters such as `+`, `-`, `*` and `?` are matched as
typed, so `--search C++` finds "C++". For wildcards or other text-search operators, write the
clause yourself with `--jql`, for example `--jql 'summary ~ "pass*"'`.

On an older Xray without the JQL function a scope needs, the scope's test keys come from Xray's
REST API instead and are searched in batches, so the filters still apply. The tests, their order,
and what `--limit` keeps are the same as on the JQL route, with one exception: an `ORDER BY` in
`--jql` cannot be applied across batches, so on that route it is an error that says to remove it.

**Plans that contain sets.** Adding a Test Set to a plan adds the set's tests, not the set, so
`--plan` already returns every test however it was added. Xray keeps no record of which tests
arrived through a set, so neither can this CLI; a test's `sets` shows which sets contain it.

## Choosing fields

`--fields` adds fields to what a command returns; it never removes the defaults. Each value is one
of:

- an Xray role, such as `steps` or `repositoryPath`;
- the name of an Xray field, including one no role claims;
- any Jira field id or name, such as `components`, `customfield_10400`, or `"Story Points"`.

A name that matches nothing is an error before any search runs. On `test list`, `plan list`, and
`set list` each field becomes a column; on `test get` and `test export` it goes in the record's
`fields` object, under the name you used.

## Steps this version does not fully read

A step can carry more than its action, data and expected result: a column your administrator added
to the step table, or, on Xray 6.0 and later, a call to another test. This version reads the three
standard columns and passes anything else through untouched, so nothing is lost:

- In the record, it goes under the step's `extra`, exactly as Xray sent it. (`testVersionId`, which
  every step carries, is Xray's own bookkeeping and is left out; `--raw` still shows it.)
- In the step table, a step with no action of its own shows what it carries, such as
  `(not interpreted: testCallBean)`, rather than an empty row.
- Each such name is noted once on stderr.

Called tests are not yet interpreted: a calling step shows up this way, with its `testCallBean`
under `extra`. A later version may read it and give such steps a typed form of their own.

## Exporting

```sh
simply atlassian jira xray test export --plan OM-7 > plan.json
simply atlassian jira xray test export --project OM --path "/O&M/Accounts" --recursive --format jsonl
```

`--format` picks what goes to stdout: `json` (the default) writes one array, `jsonl` writes one
record per line as each page of 100 arrives, and `markdown` writes one section per test. `jsonl`
and `markdown` hold only one page in memory, so they suit exports of any size; `json` has to hold
the whole export to print one array. Progress
(`fetched 300 of 1240`), skipped tests, and a note when `--limit` (default 1000) stopped the
export all go to stderr, so stdout is only ever the export. Reaching the limit still exits 0.

With `--json`, the command returns `{ records, total, complete, notes }` instead, so a script can
tell a truncated export from a complete one. `--json` replaces `--format` and the progress lines.

## The export record

`test export` writes, and `test get --json` returns, one record per test. Unlike the rest of this
CLI's output it is not an Atlassian payload but a shape of this project's own, assembled from the
issue, Xray's fields, and its preconditions, so **it is a contract**: a key's meaning will not
change and no key will be removed without a breaking release.

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
    { "index": "2", "action": "Pick a user", "data": "bob", "result": "Details shown", "attachments": [] }
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
      "summary": "Reset passwords"
    }
  ],
  "plans": ["PROJ-7"],
  "sets": ["PROJ-31"],
  "fields": { "components": ["Accounts"] }
}
```

| Key             | Meaning                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`, `id`     | The test issue's key and id.                                                                                                                                                                                                                                         |
| `summary`       | The issue summary.                                                                                                                                                                                                                                                   |
| `status`        | The workflow status name.                                                                                                                                                                                                                                            |
| `type`          | `Manual`, `Cucumber`, `Generic`, or the instance's own test type name; null if the test has none.                                                                                                                                                                    |
| `path`          | Repository folder, with a leading slash; null if the test is in none.                                                                                                                                                                                                |
| `preconditions` | Each precondition's key and summary. `summary` is null for one you cannot see.                                                                                                                                                                                       |
| `steps`         | Each step's `index`, `action`, `data`, `result`, and `attachments` (as file names), plus `extra` when the step carries data this version does not interpret (below). Empty if not manual.                                                                            |
| `definition`    | The Cucumber scenario or generic definition; null for a manual test.                                                                                                                                                                                                 |
| `links`         | Every issue link, read from this test's side: the link `type` name, which end the other issue is on (`direction`), the phrase from this side (`relationship`, such as `tests` or `is tested by`), and the other issue's `key`, `issueType`, `status`, and `summary`. |
| `plans`, `sets` | Keys of the plans and sets that contain the test.                                                                                                                                                                                                                    |
| `fields`        | Every `--fields` value, under the name you used. Named Jira objects become their name, so components read `["Accounts"]`.                                                                                                                                            |

`extra`, when present, holds a step's properties and columns that this version does not interpret,
as Xray sent them; step columns beyond action, data and expected result are under `extra.fields`.
Its contents are Xray's, not part of this contract, and a later version may give some of them a
typed form of their own.

## Recipes

Export everything in a plan, including tests added through its sets:

```sh
simply atlassian jira xray plan list --project OM
simply atlassian jira xray test export --plan OM-7 > release-1.json
```

Find the tests that verify a story:

```sh
simply atlassian jira xray test list --project OM --linked-to OM-40
```

Find tests in a poorly organised project by keyword:

```sh
simply atlassian jira xray test list --project OM --search password --limit 100
```

Pull one folder, with its subfolders, as Markdown for a reviewer or a model:

```sh
simply atlassian jira xray path list --project OM
simply atlassian jira xray test export --project OM --path "/O&M/Accounts" --recursive --format markdown > accounts.md
```

## Write safety

Every `jira xray` command is a read, and all of them work under `ATLASSIAN_READ_ONLY`. The one
thing they write is the local instance record, which is a cache of the instance's layout rather
than a change to Jira, so the read-only guard does not apply to it.

## In the MCP server

The MCP server has one tool per command, registered only when it is started with `--xray`. See
the [MCP server guide](/guides/mcp-server/#xray-tools---xray).
