# 0021 — Xray test authoring (Server/Data Center)

**Status:** In progress
**Package:** `packages/simply-atlassian-core` (behaviour); `packages/simply-atlassian` and
`packages/simply-atlassian-mcp` (surfaces)
**Date:** 2026-10-31

## Problem

`jira xray` ([0015](0015-jira-xray.md)) reads tests but cannot write them. A person or an agent who
has just read a story cannot turn it into a test here, and a test exported, reviewed and corrected
has no way back. Tests can be written with `jira issue create --body`, but only by someone who knows
the instance's `customfield_…` ids and Xray's value shapes, which is the problem field discovery
exists to remove.

## Decision

Add **test authoring**: create and update Tests, with their steps, Gherkin or generic definition,
and a link to the requirement they verify. It goes into core first, then the CLI and the MCP server.

- **Data Center only.** Cloud stays deferred, and `createXrayBackend` keeps refusing it.
- **Built from Xray's published documentation, with no live checks.** No sandbox was available.
  Every request shape cites its source below, and nothing here has been run against a real instance.
- **An undocumented shape is left out, not shipped as experimental.** Datasets, called tests
  (`testCallBean`), step reordering and writing custom step columns all stay out.
- **Authoring only.** Out of scope: preconditions, creating sets, plans or executions, `--path` on
  create, membership add/remove, repository folders, runs and results, and import.

## Documented facts

These are **documented, not confirmed**: they come from Xray's pages, read on 2026-10-31 (each page's
last edit is July 2025), and nobody has checked them against an instance. When someone has access to
one, this list is the checklist.

- **Tests** = [Tests - REST](https://docs.getxray.app/space/XRAY/301474262/Tests%20-%20REST)
- **Steps** = [Test Steps - REST](https://getxraydocs.atlassian.net/wiki/spaces/XRAY/pages/301506828)
- **Columns** = [Configuring Test Step Custom Fields](https://getxraydocs.atlassian.net/wiki/spaces/XRAY/pages/301698079)
- **v2** = [REST API v2.0](https://getxraydocs.atlassian.net/wiki/spaces/XRAY/pages/301405521)

| Fact                 | Documented shape                                                                                                   | Source |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| Create a test        | `POST /rest/api/2/issue` with `issuetype: { name }`                                                                | Tests  |
| Test type            | select: `{ "value": "Manual" }`, `"Cucumber"`, `"Generic"`                                                         | Tests  |
| Gherkin              | Cucumber Scenario field, a plain string                                                                            | Tests  |
| Generic definition   | Generic Test Definition field, a plain string                                                                      | Tests  |
| Cucumber type        | select: `{ "value": "Scenario" }`. Required before Xray 7.3.0; from 7.3.0 Xray detects it, and it need not be sent | Tests  |
| Steps on create      | `{ "steps": [{ "index": 1, "fields": { "action", "data", "expected result" } }] }` in the steps field              | Tests  |
| Add a step           | `PUT /rest/raven/1.0/api/test/{key}/step`, body `{ step, data, result }`. No position in the body                  | Steps  |
| Update a step        | `POST /rest/raven/1.0/api/test/{key}/step/{id}`, with "the information you want to update"                         | Steps  |
| Delete a step        | `DELETE /rest/raven/1.0/api/test/{key}/step/{id}`                                                                  | Steps  |
| Read steps           | `GET /rest/raven/1.0/api/test/{key}/step`: `id`, `index`, and `step`/`data`/`result` as `{ raw, rendered }`        | Steps  |
| Step write responses | `200 text/plain`, with no body shown                                                                               | Steps  |
| v1.0 stays available | "all endpoints from version 1.0 are also available in version 2.0"; the step API has no v2 replacement listed      | v2     |

Facts looked for and **not** found, and what follows from each:

- **Reordering steps.** No move or position endpoint or field is documented, so
  `test step move` and `--at` are cut. See [Whole-list replace](#whole-list-replace).
- **Writing custom step columns.** Neither step body shows them, and the Columns page covers only
  the administration screens. They are never sent; existing values are left alone, with a note.
- **Called tests.** Still undocumented (0015). A call step in a record is refused.
- **The `Tests` link type.** Xray's pages do not state it. 0015's live checks saw it, and the link
  code already resolves a phrase against the instance's own types, so nothing depends on the name.

### One inference: the search id and the step API's id

Step ids reach a record from the steps field of `/rest/api/2/search`, which 0015 confirmed live
carries `id`. Update and delete take the `id` that `GET …/step` returns. **No page says these are
the same number.** Tests shows an id in that shape (`"id":10940`) under Xray's own export, which
points that way but does not settle it.

The design is built so being wrong fails safely. Every write first reads `GET …/step`, the
documented source, and checks each id against that list. If the two kinds of id differed, a step
command or an id-matched replace would stop with "no such step" before sending anything. The cost
would be a feature that refuses, not a wrong step edited. This is the first item to check live.

## Behavior

### Commands

| Command                                    | What it does                                                                                       | Kind                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `jira xray test create`                    | Creates a Test from `--file` and/or flags; `--verifies KEY` (repeatable) adds the requirement link | write                                          |
| `jira xray test update <test>`             | Applies a record or flags. If the input has `steps`, the step list is **replaced**                 | write; `--confirm` when steps would be deleted |
| `jira xray test step add <test>`           | `--action`, `--data`, `--result`. Appends                                                          | write                                          |
| `jira xray test step update <test> <step>` | Edits one step's action, data or result                                                            | write                                          |
| `jira xray test step delete <test> <step>` | Deletes one step                                                                                   | write; `--confirm`                             |

Input flags on `create` and `update`:

| Flag                            | Meaning                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--file`                        | One export record, as `test get --json` prints it or one line of `test export --format jsonl`                                                                           |
| `--summary`                     | The summary                                                                                                                                                             |
| `--type`                        | `manual`, `cucumber`, `generic`, or another value the type field allows; matched against the field's allowed values, and an unknown one is a `ConfigError` listing them |
| `--step 'action\|data\|result'` | Repeatable. `\|` in the text is written `\\                                                                                                                             | `   |
| `--gherkin`, `--gherkin-file`   | The Cucumber scenario                                                                                                                                                   |
| `--definition`                  | The generic definition                                                                                                                                                  |
| `--field role=value`            | Repeatable. A role or field name, never needing a `customfield_…` id                                                                                                    |
| `--body`, `--body-file`         | Raw `{ "fields": … }`, merged underneath, as on `issue create`                                                                                                          |

The allowed values come from Jira's create metadata. If it will not say, a known type is sent with
its documented spelling, one note says it was not checked, and Jira's own 400 reports a mistake.

`create` also takes `--project` and `--verifies`. Flags override the record, and the record overrides
`--body`. With no type given, `create` infers it: steps mean Manual, Gherkin means Cucumber, and a
definition means Generic.

**Cucumber before Xray 7.3.0.** Those versions require the Cucumber type. Nothing guesses it from the
text: when the recorded version is below 7.3.0 and none was given, `create` stops and says to pass
`--field cucumberType=Scenario`. When the version is unknown (0015: reading it needs an
administrator), it is omitted, as current Xray expects, and an older instance's own 400 reaches the
caller.

### Read changes (additive to 0015)

- `XrayActionStep` gains `id: string | null`. `test get` shows an `ID` column, and JSON output of
  `test get` and `test export` carries it. The markdown export leaves it out, since it is for reading
  and not for round trips. There is no `test step list`: `test get` shows what the step commands
  target.

### Record round trip

`--file` takes one record, so `test export --format json`, which writes an array, is refused with a
pointer to a loop over `--format jsonl`.

- **Applied:** `summary`, `type`, `steps`, `definition`, and `fields`, whose keys resolve as `--fields`
  does.
- **Ignored, named in one note:** `key`, `id`, `status`, `path`, `preconditions`, `plans`, `sets`,
  `links`, and any key this version does not know. Use `--verifies` for a link on `create`.
- **A step carrying `testCallBean`** is refused, so a round trip never drops a call without saying so.
- **Custom step columns** (`extra.fields`) and **attachments** are not sent. Existing ones are left
  alone, and one note names the columns.
- **`fields` values** are simplified in a record (`components: ["Accounts"]`), so they are written back
  in the shape the field's schema calls for, and on `update` only when they differ from the current
  value. Xray's own roles (`steps`, `testType`, `preconditions`, …) cannot be set this way, apart from
  `cucumberType`. In a record they are noted and skipped; as a `--field` they are refused.

An unchanged `export → update` sends **no write at all**.

### Whole-list replace

`test update` with steps diffs against a fresh `GET …/step`, in a pure planner that `--dry-run` prints:

| Input step                                                       | Result                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| Id the test has, content differs                                 | **update**, sending only the changed columns          |
| Id the test has, content equal                                   | nothing                                               |
| No id, after every kept step                                     | **add**                                               |
| Current id missing from the input                                | **delete**, which needs `--confirm`                   |
| Id the test does not have (stale, or from another test)          | **refused** before anything is sent                   |
| Kept steps in a different order, or a new step before a kept one | **refused**, with a pointer to deleting and re-adding |

The last row differs from the first plan, which had a new step added "at its position" and a move
where documented. `PUT` documents no position and no move exists, so either would need an
undocumented call.

A record with **no ids at all** (hand-written, or exported before this version) is diffed by
position instead: differing content is an update, extra input steps are adds, and extra current steps
are deletes. It warns when a step with attachments changes content, since attachments stay with the
step's id. A call step whose content would change is refused.

Writes run in the order updates, adds, deletes, so what cannot be undone comes last.

### Output

Every write re-reads the test and returns `{ record, notes }`: the record is the one `test get`
returns. The terminal shows the table view with notes on stderr; `--json` and MCP return the object.
If the write succeeded but the re-read failed, `record` is `null` and a note says why, because
reporting a failure would invite a retry of something that landed. `--dry-run` returns the plan, sends
no write, and may still read.

Xray's step writes answer `200 text/plain`, and a plain-text body is not an error. The client's
JSON parsing would have called it "malformed JSON" after the write landed, so these calls accept text.

### Partial failure

Steps travel in the create request, so a test is created with its steps or not at all, which
improves on the non-atomic issue → steps → links order first assumed. What remains non-atomic:

- **`create` with `--verifies`:** the links follow the issue. Link types and keys are checked before
  the issue is created, so an instance without a matching type fails with nothing created. A link
  that still fails is reported with the created key, the links made, the links not made, and the
  `issue link create` command to finish. The created issue is never deleted automatically.
- **`update`:** fields first, then each step. A failure names what was applied and what was not, and
  says to read the test again before retrying.

These are `XrayPartialWriteError` (exit 1).

### Write safety

`static isWrite = true`, `--dry-run` and `--json` on all; `--confirm` on `test step delete` and on
`test update`, where it is needed only when the plan deletes a step. Requests go through the client's
mutating path, so they get the 403 write-scope hint and 0017's no-retry-on-5xx rule.

**Xray credentials have no read-only scope.** `ATLASSIAN_READ_ONLY` is the only guard here, and 0004's
one real boundary, a read-scoped token, does not exist.

### MCP

`jira_xray_test_create`, `jira_xray_test_update`, `jira_xray_test_step_add`,
`jira_xray_test_step_update` and `jira_xray_test_step_delete`, following the existing naming, marked
`app: 'xray'`. They register only with `--xray` and `--allow-writes`. They take the record as a JSON
object rather than a path, and `steps` as objects rather than `action|data|result`.
`jira_xray_test_update` is `destructive` with `requiresConfirm` off, because whether it deletes is only
known after the read, so core enforces `confirm` once the plan is known.

## Alternatives considered

**Replace the list through the steps field (`PUT /rest/api/2/issue/{key}`).** One atomic request that
could also reorder. Tests says the field can be modified, but not what happens to existing step ids
or attachments, and a guess there would lose data. Rejected in favour of per-step calls.

**Create the issue, then add steps through the step API.** Rejected: the steps field is documented on
create, and one request removes a whole class of partial failure.

**Infer the Cucumber type from `Examples:`.** Rejected: a wrong guess on an old version is a wrong
field value, where a refusal costs one flag.

**Assume the search id and step API id are equal, unchecked.** Rejected: a read before each write
makes a wrong assumption harmless, at the cost of one request.

## Testing

All against `startTestServer`, with non-default field ids and the documented request shapes. The
request bodies the fixtures assert are checked against the citations above in review, which stands in
for live verification.

- **Planner tables:** by id (equal, add, delete, edit, reorder, stale id, new step mid-list, duplicate
  id); by position (equal, grow, shrink, edit middle, attachment warning, call step).
- **CLI:** `--dry-run` sends no write and prints the plan; `ATLASSIAN_READ_ONLY` exits 2; a delete or
  shrinking replace without `--confirm` exits 2; a 403 has the write-scope hint and a 5xx is not
  retried; roles map to non-default ids; an unknown `--type` lists the values; a call step is refused;
  custom columns are noted; ignored keys are named; all three types send the right fields; create and
  update return the re-read record; a partial failure names the created key; an `export → update`
  round trip sends no write; a plain-text 200 is success.
- **MCP:** catalogue and snapshot parity; absent without both gates; `confirm` enforced.

## Open questions

- **Batch create** from an array or JSONL, which would pair with `test export --format jsonl`. Refused
  for now.
- **Changing `type` on a test that has steps.** Refused for now, saying to delete the steps first.
  Whether Xray keeps or clears them is undocumented, and refusing is the choice that can be relaxed
  later.
