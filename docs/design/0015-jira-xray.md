# 0015 — Xray test management under `jira xray`

**Status:** Draft
**Package:** `packages/simply-atlassian-core` (config, auth, client, behaviour);
`packages/simply-atlassian` and `packages/simply-atlassian-mcp` (surfaces)
**Date:** 2026-10-02

## Problem

[Xray](https://www.getxray.app/) is the test-management app most Jira shops use, and nothing here
can talk to it. Its objects — Test, Test Set, Test Plan, Test Execution, Precondition — are Jira
issues, so `jira issue view` and `jira issue search` already read their summary, status and
labels. Everything that makes them _tests_ does not live on the issue, though: a test's steps, the
runs inside an execution and their PASS/FAIL status, which tests a plan covers. That data sits
behind Xray's own API, and the CLI cannot reach it.

The gap that hurts most is in CI. Getting a JUnit report into Xray today means a hand-rolled
`curl` that authenticates, picks the right import endpoint for the format, and passes the
project, plan and execution keys as query parameters. Each pipeline carries its own copy, and
none of them have `--dry-run`, credential redaction, or `ATLASSIAN_READ_ONLY`. For an agent it
is worse: the agent can read a Test issue but cannot see its steps, and cannot record whether the
test passed.

Xray is also the first Marketplace app this CLI would support, so where it goes sets the pattern
for the next one (Tempo, Zephyr, Structure).

## Decision

Xray is a **subtopic of Jira**: `simply atlassian jira xray <noun> <verb>`. It is built in this
monorepo in the usual order: behaviour in `simply-atlassian-core`, then exposed through the CLI
and the MCP server. The rule for later apps is the same: **an app lives under the product that
hosts it** (`jira tempo …`, `confluence drawio …`), not beside Jira and Confluence as a product of
its own.

The first version adds seven commands: three reads and four writes.

| Command                                        | Kind  | Cloud (Xray API)                           | Server/DC (Jira host, `/rest/raven/1.0`)           |
| ---------------------------------------------- | ----- | ------------------------------------------ | -------------------------------------------------- |
| `jira xray test get <test>`                    | read  | GraphQL `getTests(jql: "key = …")`         | `GET /api/test?keys=` + `GET /api/test/{key}/step` |
| `jira xray execution runs <execution>`         | read  | GraphQL `getTestExecutions` → `testRuns`   | `GET /api/testexec/{key}/test`                     |
| `jira xray plan tests <plan>`                  | read  | GraphQL `getTestPlans` → `tests`           | `GET /api/testplan/{key}/test`                     |
| `jira xray execution import <file>`            | write | `POST /api/v2/import/execution[/<format>]` | `POST /import/execution[/<format>]`                |
| `jira xray execution add <execution> --test …` | write | GraphQL `addTestsToTestExecution`          | `POST /api/testexec/{key}/test`                    |
| `jira xray plan add <plan> --test …`           | write | GraphQL `addTestsToTestPlan`               | `POST /api/testplan/{key}/test`                    |
| `jira xray run update <execution> <test>`      | write | GraphQL `updateTestRunStatus` (+ comment)  | `PUT /api/testrun/{id}` (id looked up first)       |

Endpoint names come from Xray's public documentation and **must be confirmed** against a Cloud
tenant and a DC instance before implementation (see [Facts to confirm](#facts-to-confirm)).

The two deployments are very different underneath, and the client hides that as `JiraClient`
already hides `/rest/api/3` versus `/rest/api/2`:

- **Xray Cloud** is a separate service on its own host (`https://xray.cloud.getxray.app`, or a
  regional `eu.`/`us.`/`au.` host). It has its own credentials: an API key (client id + secret)
  exchanged for a short-lived bearer token. Reads and most writes go through **GraphQL**, which
  takes Jira issue _ids_ rather than keys. Imports are plain REST.
- **Xray Server/DC** is a plugin on the Jira host, under `/rest/raven/1.0`. It uses the Jira
  personal access token and accepts issue keys.

## Behavior

### Connection settings

Which deployment Xray is depends on `JIRA_URL`, using the same `.atlassian.net` rule as
[0001](0001-atlassian-client-core.md). Xray has no separate deployment switch, because an Xray
Cloud tenant always belongs to a Jira Cloud site and vice versa.

| Variable / flag                                 | Used on   | Meaning                                                                                                                  |
| ----------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `JIRA_URL` / `--jira-url`                       | both      | Decides the deployment. On DC it is also the Xray base URL.                                                              |
| `JIRA_PERSONAL_TOKEN` / `--jira-personal-token` | Server/DC | The Xray credential on DC. Nothing new to configure there.                                                               |
| `XRAY_CLIENT_ID` / `--xray-client-id`           | Cloud     | Xray API key client id (Xray → API Keys in Jira settings).                                                               |
| `XRAY_CLIENT_SECRET` / `--xray-client-secret`   | Cloud     | Its secret. Redacted like every other credential.                                                                        |
| `XRAY_URL` / `--xray-url`                       | Cloud     | Optional. Defaults to `https://xray.cloud.getxray.app`. Set it to the regional host for data residency. Must be `https`. |

On **Cloud**, Xray commands **do not need `JIRA_USERNAME`/`JIRA_API_TOKEN`**. Every v1 command
can be answered by the Xray API alone, because GraphQL accepts JQL (`key = PROJ-12`), so issue
keys resolve there and the CLI needs no Jira-side key-to-id lookup. Requiring Jira credentials
the command never uses would be the same mistake 0007 avoided by not failing fast on
`CONFLUENCE_URL`.

Error messages follow `config.ts`:

- Cloud with no `XRAY_CLIENT_ID`/`XRAY_CLIENT_SECRET`: `ConfigError` naming the missing
  variables.
- Cloud with only `JIRA_PERSONAL_TOKEN` set: the same error, plus a hint that Jira tokens do not
  authenticate to Xray Cloud.
- DC with `XRAY_CLIENT_*` set: those variables are ignored and nothing is printed. They are
  harmless, and a shared `.env` used for both deployments is normal.

`--env-file` loads `XRAY_URL`, `XRAY_CLIENT_ID` and `XRAY_CLIENT_SECRET`, which means adding them
to the allowlist in `env-file.ts`.

### Authentication (Cloud)

`POST {XRAY_URL}/api/v2/authenticate` with `{ client_id, client_secret }` returns a bearer token
as a JSON string.

- The token is fetched lazily on the first Xray call and cached in memory for the life of the
  process, keyed by `(XRAY_URL, client id)`. The MCP server builds clients per tool call, so
  without a module-level cache it would authenticate on every call.
- A `401` on a later call drops the cached token, re-authenticates **once**, and retries. A
  second `401` is an `AuthError` (exit 3).
- The token is registered as a secret with the redaction layer as soon as it arrives, so it can
  never appear in an error message or `--dry-run` output. `XRAY_CLIENT_SECRET` joins
  `SECRET_ENV`, and `xray-client-secret` joins the CLI's `SECRET_FLAGS`.
- The authenticate call itself is not a write and is never refused by `ATLASSIAN_READ_ONLY`.

### Identifiers

Every command takes **issue keys** (`PROJ-12`). Numeric issue ids are also accepted. On Cloud,
keys are resolved to ids in the same GraphQL request where possible (via `jql`). An unknown key
is a `CliError` naming it, raised **before** any write is sent. `--test` is repeatable and
accepts a comma-separated list, as `sprint add --issue` does.

### Reads

**`test get <test>`** shows the test type (Manual / Cucumber / Generic), its steps as a table
(`#`, action, data, expected result) for Manual tests, the Gherkin or generic definition for the
others, and any linked preconditions. `--json` returns the raw payload.

**`execution runs <execution>`** lists one row per test run: test key, summary, status,
assignee/executed-by, started and finished. `--status <name>` filters (for example
`--status FAILED`), which is what an agent wants after a CI run. `--limit` defaults to 25 like
every other list. Pages are followed until the limit is met (GraphQL caps a page at 100), and
the footer says when the total exceeds what was shown.

**`plan tests <plan>`** lists the tests in a plan with their latest status in the plan. Paging
works as for `execution runs`.

**Output across deployments.** Terminal output is normalised to the same columns on both
deployments. `--json` returns what the instance returned, so a Cloud GraphQL payload and a DC
REST payload do not match. This is the split [0011](0011-jira-issue-history.md) made for issue
history, for the same reason: making the raw shape uniform would mean inventing a schema Xray
does not publish, and keeping it in step with two upstream APIs.

### Statuses

The built-in run statuses are named differently on the two deployments: Cloud uses
`PASSED`/`FAILED`, DC uses `PASS`/`FAIL`, and both have `TODO`, `EXECUTING` and `ABORTED`.

`run update --status` and `execution runs --status` take either spelling of a built-in, in any
case, and send the instance's spelling. Custom statuses (which Xray supports on both deployments)
are sent verbatim. An unknown status is refused by Xray, and that error is passed through rather
than guessed at, because the CLI cannot list custom statuses on every deployment (see open
questions).

### Writes

All four writes are `static isWrite = true`, take `--dry-run`, and are refused under
`ATLASSIAN_READ_ONLY`, as in [0004](0004-write-safety-and-jira-issue-writes.md). **None takes
`--confirm`**: each one adds or records something, and nothing is lost that cannot be put back.
Removing tests from a plan or execution is the exception. It discards the run results, so it is
deliberately out of scope here (see open questions).

GraphQL calls are always `POST`. Each call therefore **declares** `mutating`, exactly as
`JsonCall.mutating` says callers must, so a query is not treated as a write and a mutation is.

**`execution import <file>`** is the CI command.

| Flag                          | Meaning                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--format`                    | `xray` (Xray JSON, default), `junit`, `cucumber`, `testng`, `nunit`, `xunit`, `robot`, `behave`. Selects the endpoint. |
| `--project <key>`             | Project for a new execution. Required by Xray for most formats when `--execution` is absent.                           |
| `--execution <key>`           | Import into this existing execution instead of creating one.                                                           |
| `--plan <key>`                | Associate the execution with this plan.                                                                                |
| `--environment <name>`        | Test environment. Repeatable.                                                                                          |
| `--fix-version`, `--revision` | Passed through as Xray's query parameters.                                                                             |

- `<file>` may be `-` for stdin, so a pipeline can stream a report without writing it to disk.
- The output is the created or updated execution's key, plus a link built with the existing
  `atlassian-url.ts`. `--json` returns Xray's response.
- `--dry-run` prints the method, endpoint, query parameters, content type and the report's size
  and first lines. It does **not** print the whole report, which can be megabytes.
- Importing JUnit, TestNG, NUnit, xUnit or Robot **creates Test issues** for test cases Xray has
  not seen. The command help and the dry-run output both say so. That side effect surprises
  people the first time, and an agent should be told before it happens rather than after.

The multipart variants (an extra `info` JSON that sets fields on the new execution) are out of
scope for v1; see open questions.

**`execution add <execution> --test …`** and **`plan add <plan> --test …`** add tests. Adding a
test that is already present is not an error. As with `page label add`, the command reports it as
already present rather than implying it added it.

**`run update <execution> <test>`** finds a run by its execution and test, the pair a person
actually knows. `--status` and/or `--comment` must be given. On DC the run id is looked up first
with `GET /api/testrun?testExecIssueKey=&testIssueKey=`. On Cloud the run is read and then the
status is changed (comment via `updateTestRunComment`). If there is no run for that pair, the
error says to `execution add` the test first.

### Write safety: the honest part

0004's one real security boundary is a credential that **cannot** write, which Atlassian enforces
on the server. Xray does not offer that:

- Xray Cloud API keys have no scopes. A key acts with the full Xray permissions of the user who
  created it.
- DC personal access tokens carry the owning user's permissions.

The Xray guide therefore recommends the closest thing that does exist: create the agent's key
from a **dedicated Jira user with browse-only project permissions** and keep a separate key for
writes, mirroring the two-file arrangement in 0004. It must not imply that `ATLASSIAN_READ_ONLY`
or a missing `--allow-writes` is a security boundary for Xray. (Confirm that scope claim; see
below.)

### Commands, topics and MCP tools

```
simply atlassian jira xray test get PROJ-12
simply atlassian jira xray execution runs PROJ-40 --status FAILED
simply atlassian jira xray execution import report.xml --format junit --project PROJ --plan PROJ-7
simply atlassian jira xray run update PROJ-40 PROJ-12 --status PASSED --comment "Fixed in #812"
```

New oclif topics:

- `atlassian:jira:xray`: "Work with Xray tests, plans, and executions (Marketplace app)."
- `atlassian:jira:xray:test`
- `atlassian:jira:xray:execution`
- `atlassian:jira:xray:plan`
- `atlassian:jira:xray:run`

The MCP server gets one tool per command, named by the existing `<product>_<noun>_<verb>` rule:

| Kind    | Tools                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------- |
| `read`  | `jira_xray_test_get`, `jira_xray_execution_runs`, `jira_xray_plan_tests`                              |
| `write` | `jira_xray_execution_import`, `jira_xray_execution_add`, `jira_xray_plan_add`, `jira_xray_run_update` |

- **Xray tools are only registered when the server is started with `--xray`.** Most people
  running the server do not have Xray, and a host lists every registered tool to its model. Seven
  tools that can only fail are worse than none, for the reason 0007 gives for leaving write tools
  out entirely rather than registering them and having them refuse. Detecting Xray from the
  environment instead does not work: DC needs no Xray-specific variables, so there is nothing to
  detect. `--allow-writes` still governs the four writes.
- The **catalogue** still contains all seven, so the test that compares the catalogue with
  `command-snapshot.json` is unchanged. Only `selectTools` filters.
- `jira_xray_execution_import` takes the report as a `report` **string** plus `format`, not a
  path. That follows 0007's rule that an agent has no file to point at. A size cap on `report` is
  an open question.

## Alternatives considered

**`simply atlassian xray …` as a sibling product.** Shorter, and it matches the fact that Xray
Cloud has its own credentials, as Confluence does. Rejected for three reasons:

- Xray is a Marketplace app, not an Atlassian product, so putting it beside Jira and Confluence
  blurs the line the `atlassian` topic draws.
- Every later app would become a top-level "product" too.
- On DC an Xray command needs every Jira connection flag anyway, so the separation would be
  cosmetic.

An oclif `aliases` entry can add the short form later at no cost, if people ask for it.

**A separate repo or plugin (`@simplysf/simply-xray`, `-core`, `-mcp`, invoked as
`simply xray …`).** Independent releases, and users without Xray pay nothing. Rejected for v1
because it costs more than it saves:

- `AtlassianCommand`/`JiraCommand` and the argv redaction live in the **CLI** package, not core,
  so a second plugin would have to copy them or force them into core's public API.
- It needs its own repo, CI, docs-site section and `jitPlugins` entry, and agents would have to
  configure a **second MCP server**.
- Two JIT plugins both adding to the `atlassian` topic is awkward, which is why it would end up
  as `simply xray`.

The core modules below are self-contained (`xray-*.ts`), so moving them out later stays
mechanical if Xray grows past what belongs here.

**A raw GraphQL passthrough (`jira xray graphql <query>`) instead of typed commands.** Maximum
coverage for minimal code. Rejected as the _primary_ surface:

- It works only on Cloud.
- It cannot honour `--dry-run` or the read-only guard without parsing the operation to tell a
  query from a mutation.
- It gives an agent nothing to discover.

It may still be worth adding as an escape hatch, like `--body` (open question).

**Requiring Jira credentials for Xray Cloud commands too.** It would let `test get` show
Jira-side fields through `JiraClient`. Rejected: GraphQL already returns the summary and status,
and a setting the command never uses becomes a configuration error with no cause.

**Normalising `--json` across deployments.** Rejected for the reasons given under Reads, and for
consistency with 0011.

**Auto-registering Xray MCP tools when `XRAY_CLIENT_ID` is set.** Rejected: it can never fire on
DC, so it would quietly behave differently by deployment.

## Implementation plan

**Core (`packages/simply-atlassian-core/src`)**

1. `http.ts`: let a call carry a non-JSON body (`rawBody: { contentType, data }`), because
   imports post XML or text. Today `attempt()` always sets `Content-Type: application/json` and
   `JSON.stringify`s the body. The JSON path stays the default and is unchanged.
2. `xray-config.ts`: `XrayConfig` as a discriminated union:
   - `{ deployment: 'cloud'; url; clientId; clientSecret }`
   - `{ deployment: 'server'; jira: AtlassianConfig }`

   `resolveXrayConfig(overrides, env)` reuses `normalizeUrl`/`detectDeployment` from `config.ts`
   (export them) and, on DC, calls `resolveJiraConfig`.

3. `xray-auth.ts`: the token exchange, the module-level cache, re-authenticating once on 401, and
   registering the token with redaction.
4. `xray-client.ts`: one `XrayClient` interface with two implementations.
   - `XrayCloudClient` (GraphQL plus REST imports) turns a response carrying GraphQL `errors` into
     a `CliError` with sanitised messages. GraphQL reports failure in a 200, so the transport alone
     would miss it. Partial data is never returned.
   - `XrayServerClient` (`/rest/raven/1.0` on the Jira host).
   - `createXrayClient(config)` picks one.
5. Operations, each a pure request builder and renderer like `jira-agile.ts`:
   - `xray-tests.ts`
   - `xray-executions.ts` (runs, add, import, including the format → endpoint table and the
     dry-run preview)
   - `xray-plans.ts`
   - `xray-runs.ts`
   - `xray-status.ts` (the built-in spelling table)
6. `env-file.ts` allowlist, `redaction.ts` `SECRET_ENV`, `index.ts` exports, and Xray routes for
   the fake instance in `testing.ts`.

**CLI (`packages/simply-atlassian`)**

7. `shared/base-command.ts`: `xrayFlags` (`--xray-url`, `--xray-client-id`,
   `--xray-client-secret`, help group `CONNECTION`), `XrayCommand extends JiraCommand` with
   `xray(): XrayClient`, and `xray-client-secret` in `SECRET_FLAGS`.
8. `src/commands/atlassian/jira/xray/{test/get,execution/runs,execution/import,execution/add,plan/tests,plan/add,run/update}.ts`
   as parse → core → render.
9. Topics in `package.json`, the four writes in the write-safety list test, `pnpm run build`
   (regenerates `command-snapshot.json`) and `pnpm run readme`.
10. A new guide, `docs/guides/xray.md` (setup per deployment, the CI recipe, the write-safety
    section), plus an Xray section in `docs/guides/credentials.md`.

**MCP (`packages/simply-atlassian-mcp`)**

11. `context.ts`: `xrayConfig()`/`xray()`. `tools.ts`: the seven specs, marked as `app: 'xray'`.
    `server.ts`: `selectTools(allowWrites, xray)` and an Xray line in `INSTRUCTIONS`. `bin/run.js`:
    `--xray`.
12. README tables, the MCP guide, and the root README's capability sentence.

**Docs:** the index row in `docs/design/README.md`. Correct this doc and set its status when it
lands.

Suggested PR split: (a) core plus reads on both deployments; (b) writes and import; (c) the MCP
surface. Each is shippable alone, and (a) settles the two-backend client before anything writes
through it.

## Testing

All against `startTestServer` from `@simplysf/simply-atlassian-core/testing`, with Xray routes
added. Each behaviour runs once per deployment. What each area pins down:

- **config:**
  - Deployment follows `JIRA_URL`.
  - Cloud without `XRAY_CLIENT_*` names both variables, with the PAT hint when one is present.
  - DC ignores `XRAY_CLIENT_*`.
  - `XRAY_URL` must be https and defaults correctly.
  - `--env-file` loads the three new variables.
- **auth:**
  - Exactly one `/authenticate` call across several requests, and across two clients in one
    process.
  - On 401, re-authenticate once and retry; a second 401 → `AuthError`.
  - The token and the client secret never appear in error output or `--dry-run`.
- **GraphQL:**
  - A 200 with `errors` → `CliError`; partial data is dropped.
  - Queries are declared non-mutating and mutations mutating, asserted through the read-only
    guard and the 403 hint.
- **reads:**
  - Step table, Gherkin and generic definitions.
  - Paging stops at `--limit` and reports the total.
  - `--status` filter.
  - Empty execution or plan is not an error.
  - Columns are asserted from captured output, not the mock payload.
- **statuses:**
  - `PASS`/`PASSED`, in any case, maps to each deployment's spelling.
  - Custom statuses pass through verbatim.
- **import:**
  - Each `--format` hits its endpoint with the right content type.
  - Query parameters are passed through.
  - Stdin via `-`.
  - The dry run sends nothing and shows size plus a preview, not the whole body.
  - The created-tests warning appears for the formats that create tests.
- **add / update:**
  - An already-present test is reported as such.
  - An unknown key fails before any write.
  - `run update` with no run for the pair gives the "add it first" error.
  - On DC the run id is looked up.
- **write safety:**
  - The four writes are refused under `ATLASSIAN_READ_ONLY`, and none takes `--confirm`.
  - They appear in the reflective write-safety list.
- **MCP:**
  - The seven tools are in the catalogue (the snapshot test still passes).
  - None is registered without `--xray`.
  - Without `--allow-writes`, only the three reads are registered.
  - Kinds are asserted.
  - `report` is accepted as a string.
- **live (manual):** against an Xray Cloud tenant and a DC instance:
  - Read a manual test's steps.
  - Import a JUnit report into a new execution under a plan.
  - List its failed runs.
  - Mark one passed with a comment.
  - Add a test to the plan.
  - Leave the sandbox clean.

## Facts to confirm

These come from Xray's public documentation and have **not** been checked against a live
instance. Confirm them before implementation, and correct this doc where they differ:

- The Cloud authenticate endpoint and response shape (a bare JSON string), and the token lifetime
  (documented as 24 hours).
- The regional Cloud hosts, and whether a key issued for one region works against the global
  host.
- The GraphQL operation names and arguments used above (`getTests`, `getTestExecutions`,
  `getTestPlans`, `addTestsToTestExecution`, `addTestsToTestPlan`, `updateTestRunStatus`,
  `updateTestRunComment`), the page cap of 100, and the query complexity limits.
- DC paths under `/rest/raven/1.0` (and which endpoints moved to `/rest/raven/2.0`), especially
  test steps and run lookup.
- The built-in status names on each deployment.
- That Xray Cloud API keys have no read-only scope, which is what the write-safety section relies
  on.
- Which import formats create Test issues automatically, and whether `--project` is required per
  format.
- Xray Cloud's rate limits, and whether `HttpTransport`'s existing `429` handling with
  `Retry-After` covers them.

## Open questions

- **Removing tests from an execution or plan.** This deletes run results, so it is the first
  Xray command that would take `--confirm`, and it should be designed as that rather than added
  in passing.
- **Creating tests with steps** (`test create`, `test step add`). This is the next most-requested
  capability after import. Cloud does it in GraphQL; DC does it through Jira issue create plus
  custom fields. Big enough for its own doc.
- **Multipart import with `info` JSON**, which sets the summary, labels or custom fields of the
  new execution. Probably `--info-file`, with an `info` object in MCP.
- **A size cap for the MCP `report` input.** Hosts vary in how much a single tool argument can
  carry. Decide after trying a realistic report through Claude Desktop.
- **A read-only `jira xray graphql` escape hatch** that refuses anything but a `query`
  operation. Useful for gaps, but Cloud-only.
- **Listing custom statuses** so `--status` can be validated locally rather than by Xray.
- **Test Sets, Preconditions and the test repository folders** (Cloud). Not in v1, and nobody
  has asked yet.
- **The `simply atlassian xray` alias.** Add it only if the depth turns out to bother people.
