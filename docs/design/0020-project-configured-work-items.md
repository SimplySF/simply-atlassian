# 0020 — Project-configured work items: one Jira issue, one Confluence page

**Status:** Implemented on branch `design/0020-project-configured-work-items`, not yet merged. This
document has been corrected to match what was built; the corrections are listed under
[What changed in implementation](#what-changed-in-implementation).
**Package:** `packages/simply-atlassian-core` (config, field codecs, Markdown ↔ Jira, pair logic);
`packages/simply-atlassian` (`jira work` commands); `packages/simply-atlassian-mcp` (`jira_work_*` tools)
**Date:** 2026-10-26

## Problem

The way teams actually move work from idea to code looks like this:

1. **Product riffs on an idea with an agent.** The agent creates or updates a Jira issue. If the
   work is complex enough, it also creates or updates a Confluence page. Often one or both already
   exist, and product is iterating on them.
2. **The issue moves through the team's workflow outside the agent.** Review, sign-off by business
   users who never touch an agent, prioritisation.
3. **Engineering picks the issue up** and iterates on the Confluence page until the design is good.
4. **An agent implements** from the issue and the page.

Every write that needs already exists behind `--allow-writes`: `jira_issue_create`,
`jira_issue_update`, `jira_issue_remotelink_create`, `confluence_page_create`,
`confluence_page_update`. What doesn't exist is everything that makes those primitives usable for
this flow:

- **Nothing knows what an issue should contain.** Every project has different fields. Acceptance
  criteria might be a custom field or a heading in the description. Component, labels and
  priority rules differ too. Today an agent has to discover `customfield_10045` with
  `jira_fields`, guess what belongs in it, and hand-build a raw `body`. The result depends on the
  model, the prompt and the day. Business reviewers then sign off on whatever shape came out.
- **Rich text is flattened on Cloud.** `JiraClient.descriptionValue()` turns text into ADF
  paragraphs and nothing else. Headings, numbered acceptance criteria, lists and tables collapse.
  That is not something an outside reviewer can sign off on.
- **Nothing ties the issue and the page together.** The agent has to find the other half, link
  them, and keep track of which page belongs to which issue.
- **Every write is last-write-wins.** Product, engineering, business reviewers and several agents
  all edit the same two documents over days. An agent that writes from a stale read silently
  wipes out someone else's edit.

## Decision

Add a **project config file**, `.simply/atlassian.json`, checked into the team's repository. It
declares everything about the shape and content of a work item:

- which Jira fields exist, and what goes in each one (as guidance for the agent);
- which fields are required, fixed, defaulted or limited to certain values;
- what the Confluence page is, where it lives, and which sections it needs.

On top of that config, add **three tools**. Each has a matching CLI command, as the parity rule
requires.

| Tool                     | Kind  | Purpose                                                                                                                                       |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `jira_work_get`          | read  | Reads the pair: the issue as configured fields, and the page as Markdown. Includes the guidance from the config and a revision for each half. |
| `jira_work_save`         | write | Creates or updates either half from what was read. Enforces the config and the read-before-write rule, and links the pair.                    |
| `jira_work_config_check` | read  | Checks the config against the live instance.                                                                                                  |

The server is a **generic engine**. It owns the mechanics:

- type conversion for each deployment;
- `required`, `always`, `default` and `allowed`;
- read-before-write;
- linking;
- never changing status.

The **project owns the content**. There are no built-in templates and no built-in idea of what a
story is. If a team wants Given/When/Then acceptance criteria in a custom field, the config says
so. If a team wants a "Rollout" section on every design page, the config says so too.

Skills and plugins are deliberately not part of this. Everything runs through MCP tools, so it
works the same way in Claude Code, Codex, Gemini CLI or any other MCP client. The rules are
enforced by the server, not left to a model following a prompt.

## Behavior

### The config file

**Discovery.** The first match wins:

1. the `--config <path>` flag (CLI and `atlassian mcp`);
2. the `ATLASSIAN_CONFIG` environment variable;
3. `.simply/atlassian.json`, searching upward from the working directory.

The config is resolved **on each call**, like `resolveJiraConfig`. Editing the file takes effect
on the next tool call, with no server restart. A missing config is a `config` error, and only the
`jira_work_*` tools need one.

**No credentials.** The file never holds credentials, which stay in the environment or
`--env-file` as they do today. A config that contains a key named like a credential (`token`,
`password`, `apiToken`) is refused. This makes the file safe to commit.

**Schema.** The file has a published JSON Schema
(`packages/simply-atlassian-core/schema/work-config.schema.json`). A `$schema` reference gives
editors validation and completion.

```jsonc
{
  "$schema": "https://unpkg.com/@simplysf/simply-atlassian-core/schema/work-config.schema.json",
  "guidance": "We build O&M tooling for field technicians. Write for business reviewers outside engineering: plain language, no jargon.",

  "jira": {
    "project": "PAY",
    "issueType": "Story",
    "fields": [
      {
        "name": "Summary",
        "key": "summary",
        "type": "text",
        "required": true,
        "description": "Under 80 characters, outcome-focused, no ticket-speak.",
      },
      {
        "name": "Description",
        "key": "description",
        "type": "markdown",
        "required": true,
        "description": "As a / I want / So that, then business context, then an explicit Out of scope list.",
      },
      {
        "name": "Acceptance Criteria",
        "key": "customfield_10045",
        "type": "markdown",
        "required": true,
        "description": "Numbered AC-1, AC-2… in Given/When/Then. Each must be checkable by a business user without reading code.",
      },
      { "name": "Component/s", "key": "components", "type": "components", "value": ["O&M"], "always": true },
      {
        "name": "Priority",
        "key": "priority",
        "type": "option",
        "allowed": ["High", "Medium", "Low"],
        "default": "Medium",
        "description": "High only if a field operation is blocked today.",
      },
      {
        "name": "Epic",
        "key": "parent",
        "type": "issue",
        "description": "The parent epic's key, only if the PM names one. Never guess.",
      },
      { "name": "Labels", "key": "labels", "type": "labels", "value": ["agent-drafted"], "always": true },
    ],
  },

  "confluence": {
    "space": "ENG",
    "parent": "123456",
    "title": "{issue.key}: {issue.Summary}",
    "labels": ["tech-design"],
    "when": "Create a page when the work spans more than one system, changes a data model or API, or needs design discussion. Otherwise the issue alone is enough.",
    "sections": [
      { "heading": "Problem", "required": true, "description": "The issue's problem restated for engineers." },
      {
        "heading": "Design",
        "required": true,
        "description": "The chosen approach and the components it touches. Sequence diagrams as Mermaid code blocks.",
      },
      { "heading": "Data / API changes", "description": "Schemas and endpoints, before and after." },
      { "heading": "Risks", "description": "Each with likelihood, impact and mitigation." },
      {
        "heading": "Test strategy",
        "required": true,
        "description": "Every AC-n from the issue, and how it is verified.",
      },
      { "heading": "Open questions" },
    ],
  },
}
```

#### Top level

| Property     | Required | Meaning                                                                            |
| ------------ | -------- | ---------------------------------------------------------------------------------- |
| `guidance`   | no       | Project-wide direction for the agent. Returned by `get`, never sent anywhere.      |
| `jira`       | yes      | The issue half.                                                                    |
| `confluence` | no       | The page half. Without it, the pair is issue-only and any `page` input is refused. |

#### `jira`

| Property    | Required | Meaning                                                                                                                                        |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`   | yes      | The project key that new issues are created in.                                                                                                |
| `issueType` | yes      | The issue type for new issues. Adopting an existing issue of a different type is a `config` error, so a Bug isn't silently treated as a Story. |
| `fields`    | yes      | An ordered list of field specs (below). **This is the whole contract.** Fields not listed are neither returned by `get` nor written by `save`. |

#### Field specs

| Property      | Required | Meaning                                                                                                                                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | The label the agent reads and writes against. Unique within the config.                                                                                                                      |
| `key`         | yes      | The Jira field ID, for example `summary`, `components` or `customfield_10045`.                                                                                                               |
| `type`        | yes      | How the value is encoded (table below).                                                                                                                                                      |
| `description` | no       | What belongs in the field, as instructions to the agent. Returned by `get`, never sent to Jira.                                                                                              |
| `required`    | no       | `save` refuses an issue where this field would end up empty.                                                                                                                                 |
| `value`       | no       | Only with `always: true`: the value the server applies. Must be valid for `type`. A `value` without `always` is refused, since it would do nothing.                                          |
| `always`      | no       | Needs `value`. The server always applies `value`. If the agent sends something different, it is ignored and reported in `adjusted` (see `save` below). The agent cannot remove or change it. |
| `default`     | no       | Applied on create when the agent omits the field. The agent may override it. Cannot be combined with `always`.                                                                               |
| `allowed`     | no       | For `option`, `options`, `components`, `versions` and `labels`: any other value is refused.                                                                                                  |

#### Field types

Each type encodes the agent's value into the request body for each deployment, and decodes the
issue's value back. `get` returns the decoded form, and `save` accepts exactly the same form, so a
value read and written unchanged makes no change.

| `type`       | Agent value                   | Cloud (REST v3)                                                           | Server/DC (REST v2) |
| ------------ | ----------------------------- | ------------------------------------------------------------------------- | ------------------- |
| `text`       | string                        | string                                                                    | string              |
| `markdown`   | Markdown string               | ADF document                                                              | wiki markup         |
| `number`     | number                        | number                                                                    | number              |
| `date`       | `YYYY-MM-DD`                  | string                                                                    | string              |
| `option`     | string                        | `{ "value": … }`                                                          | `{ "value": … }`    |
| `options`    | string[]                      | `[{ "value": … }]`                                                        | `[{ "value": … }]`  |
| `components` | string[]                      | `[{ "name": … }]`                                                         | `[{ "name": … }]`   |
| `versions`   | string[]                      | `[{ "name": … }]`                                                         | `[{ "name": … }]`   |
| `labels`     | string[]                      | string[]                                                                  | string[]            |
| `user`       | email, account ID or username | `{ "accountId": … }`, resolved through user search                        | `{ "name": … }`     |
| `issue`      | issue key                     | `{ "key": … }` for `parent`; the key itself for an Epic Link custom field | same                |
| `raw`        | any JSON                      | passed through                                                            | passed through      |

`priority` uses `option` semantics, but Jira encodes it as `{ "name": … }`. The codec knows the
handful of system fields that encode differently (`priority`, `assignee`, `reporter`, `parent`),
so the config never has to.

`raw` is the escape hatch for field types the server doesn't model. It is checked against nothing
but `required`, and `config-check` warns that it exists.

#### `confluence`

| Property   | Required | Meaning                                                                                                                                                                                                                                                 |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space`    | yes      | The space key that new pages are created in.                                                                                                                                                                                                            |
| `parent`   | no       | The page ID that new pages are created under.                                                                                                                                                                                                           |
| `title`    | no       | The pattern for new page titles. `{issue.key}` and `{issue.<field name>}` are substituted. The default is `{issue.key}: {issue.Summary}`, or the first configured `text` field if there is no `Summary`.                                                |
| `labels`   | no       | Labels the server adds to every page it creates or updates. They are kept even if the agent's Markdown would drop them.                                                                                                                                 |
| `when`     | no       | The project's rule for when a page is warranted. Returned by `get` for the agent to apply. The server never decides this.                                                                                                                               |
| `sections` | no       | An ordered list of `{ heading, description?, required? }`. Every `required` heading must exist (as an `#` or `##` heading, case-insensitive) in the page Markdown, or `save` refuses. Other headings are allowed. Order is guidance only, not enforced. |

The page is **one Markdown document**. Sections guide the agent's writing and set the minimum
content, but they do not split the page into parts that different people own. Product and
engineering edit the same document. The read-before-write rule below is what makes that safe.

### Read before write

Every update must build on the latest read. This is enforced, not merely suggested.

**The revision returned by `get`.** `get` returns a `revision` for each half that exists.

- **Issue:** a hash of the configured fields' current decoded values. This is deliberately **not**
  `fields.updated`. The issue moves through the workflow outside the agent, and a status change,
  comment or sprint move must not count as a conflicting edit. Only a change to a field the project
  configured does.
- **Page:** the Confluence version number.

**Updating with `basedOn`.** `save` updating an existing half requires `basedOn`, the revision the
agent read. The server then re-reads that half:

| Situation                        | Result                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `basedOn` on an update        | `read-required` and no write. The error says to call `jira_work_get` first.                                                                                                                              |
| The half changed since `basedOn` | `stale` and no write. The result carries the **current** content, its revision, and a diff from current to what the agent tried to save, so the agent can see which lines its save would undo and merge. |
| Unchanged                        | The write goes ahead, and the result carries the new content and revision for the next round.                                                                                                            |

Creating a half that doesn't exist yet needs no `basedOn`.

**Closing the race.** On Confluence the race between the re-read and the write is closed by the
page's own version check: `save` sends `basedOn + 1`, and a concurrent edit makes Confluence
refuse it, which is reported as `stale`. **Jira has no conditional update**, so a window of a few
hundred milliseconds remains between the re-read and the `PUT`. This design narrows the problem
from "any stale read" to that window, and does not claim to close it.

### `jira_work_get` / `atlassian jira work get`

| Input     | Meaning                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| `issue`   | An issue key. Its page is the Confluence page its remote links point at.                |
| `page`    | A page ID, read on its own. No issue is looked up from it.                              |
| (neither) | A new idea: returns the empty shape with guidance, and no revisions.                    |
| (both)    | Chooses one of several linked pages, or reads an unlinked pair until a `save` links it. |

**The issue is the table of contents.** The pair is whatever the issue's remote links say, which
is the link Jira already shows and the one a person adds or removes in Jira. Every remote link to a
page on the configured Confluence counts, whoever made it and whatever its relationship. One link
is the page; several are refused unless `page` names one, because guessing would mean the next
save edits the wrong document. `links.paired` is `true` when the issue links to the page that was
read.

Result:

```jsonc
{
  "guidance": "…",
  "issue": {
    "key": "PAY-412", // absent for a new idea
    "url": "https://…/browse/PAY-412",
    "status": "In Business Review", // informational; the tools never change it
    "revision": "sha256:…",
    "fields": [
      {
        "name": "Acceptance Criteria",
        "description": "Numbered AC-1…",
        "required": true,
        "type": "markdown",
        "value": "1. **AC-1** Given …",
      },
      { "name": "Component/s", "type": "components", "always": true, "value": ["O&M"] },
      // … every configured field, in config order
    ],
  },
  "page": {
    // absent when there is no confluence config
    "id": "987654",
    "url": "…",
    "title": "…",
    "revision": 7,
    "markdown": "# Problem\n…", // absent when no page exists yet
    "when": "Create a page when …",
    "sections": [{ "heading": "Design", "required": true, "description": "…" }],
  },
  "links": { "paired": true },
  "missingRequired": ["page: Test strategy"],
}
```

The implementing agent needs nothing beyond this. The result is the spec.

### `jira_work_save` / `atlassian jira work save`

Input:

```jsonc
{
  "issue": { "key": "PAY-412", "basedOn": "sha256:…", "fields": { "Acceptance Criteria": "…", "Priority": "High" } },
  "page": { "id": "987654", "basedOn": 7, "markdown": "# Problem\n…" },
  "dryRun": true,
}
```

**Supplying the halves.**

- Either half may be given alone. At least one must be.
- **Create:** `issue` without `key` creates the issue in `jira.project` as `jira.issueType`. `page`
  without `id` creates the page in `confluence.space` under `confluence.parent`. When there is no
  existing issue, the page is created after the issue so its title can use the issue key.
- **Partial fields:** only the fields the agent passes are changed. Omitted fields keep their
  current values, except that `always` values are re-applied and `default`s are applied on create.
  The page Markdown is the whole page body.

**Linking.** After any successful save that touches a pair, the server makes sure the issue has a
remote link to the page, with Jira's own relationship for a Confluence page (`Wiki Page`). It is
idempotent, because Jira keys the link by URL. Adopting an existing page or issue is a matter of
passing its `id` or `key`; adopting a page only adds the link and never rewrites the page.

When the server writes a page's body, it puts a line naming the issue at the top, for people
reading the page. It is a convenience only: nothing reads it to pair the halves, and a page saved
on its own keeps the line it has.

**Validation.** `save` validates everything before sending anything, and reports every failure
at once rather than one per attempt. It checks:

- unknown field names;
- type mismatches;
- `allowed` violations;
- missing `required` fields (computed on the final state, after merging with current values);
- missing `required` page headings;
- Markdown that can't be converted (the 0013 rule: never drop content silently).

**Status.** `save` never changes status, and it accepts no input that would.

**`dryRun`.** Returns the exact request bodies and a Markdown diff for each half against current
content. No writes are made.

**Result.** For each half, the result carries the new content, the new `revision`, the URL, and
`adjusted`: a list of what the server changed relative to the agent's input (`always` values
re-applied, `default`s filled in). The agent can tell the user what the project's rules did.

**Partial failure.** The issue is written first, then the page, then the links. If a later step
fails, the result says which steps landed. For example: "issue PAY-412 updated; page not saved:
…". The earlier writes are not rolled back. The next `get` and `save` start from whatever is
there.

### `jira_work_config_check` / `atlassian jira work config-check`

This tool loads the config and checks it against the live instance:

- the project and issue type exist;
- every `key` is on that issue type's create screen (an edit-only field is reported, since a create would fail), and every field Jira requires on create is configured;
- `option` and `options` values and `allowed` lists match the field's options;
- `components` and `versions` exist in the project;
- the space and parent page exist.

It returns `errors[]` and `warnings[]`, and the CLI exits 1 on any error. It is meant to be run
once when setting up a project, and then in CI.

### Errors

These are the existing `mapError` codes, plus two new ones:

| Code            | When                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`        | The config is missing or invalid, a field is unknown, or an issue type doesn't match. The message names the property path, for example `jira.fields[2].allowed`. |
| `read-required` | An update without `basedOn`.                                                                                                                                     |
| `stale`         | The content changed since `basedOn`. Carries the current content, its revision and a diff.                                                                       |
| `config`        | Also every validation failure of a save, all listed in one message.                                                                                              |

### Server instructions

The fixed mechanics are added to the MCP `instructions` the server already sends at initialize,
so every client reads them the same way:

> For work items: call `jira_work_get` first and follow `guidance` and each field's and section's
> `description`. Save with `jira_work_save`, passing the `revision` you read as `basedOn`. Run
> `dryRun` first and show the user the diff. On `stale`, merge the returned current content into
> your edit and save again. Never discard the other person's change. Create a page only when the
> page's `when` rule says so. These tools never change issue status; status belongs to the team.

Nothing about content lives in the server's text. Content comes from the project's config through
`get`.

## Alternatives considered

**Built-in story and design templates.** This was the first version of this design. The server
would dictate a story shape that every project then has to work around: some keep acceptance
criteria in a custom field and some in the description, and some need a component on every issue.
If the shape is going to be configured anyway, the configuration should be the whole thing.

**Markdown templates in the repo plus a separate field mapping.** That gives two sources of truth
for one contract, plus a parsing step to work out which heading maps to which field. One structured
config carries the shape, the mapping and the guidance together.

**Skills or plugins** (`SKILL.md` per client) to carry the workflow. The stack publishes none
today, so this would be a new kind of release. Skills behave differently in each client, and a
skill is followed rather than enforced: a model having a bad day ignores it. MCP tools with server
instructions work in every client, and the rules that matter are refusals, not requests.

**Section-scoped page edits** with headings owned by product and engineering, and a tool that
replaces one section. Real documents don't split cleanly by role, and it adds a tool and a concept
for something the revision check solves more generally.

**Issue revision = `fields.updated`.** It is simpler, but every status move or comment made outside
the agent would make the next save `stale`. That is noise in exactly the flow this design is for.

**Remembering reads in the server session** instead of passing revision tokens. The CLI has no
session, a restarted server loses it, and the agent can't see it. A token in the result is explicit
and works everywhere.

**Last write wins.** That is the status quo. It silently drops someone's edit, and nobody re-reads
a page they just published (0013's argument about dropped content applies here).

**A JSON Schema validator dependency in core** (zod, ajv). Core has no runtime dependencies, and
the config is small and fixed. It gets a hand-written validator whose error messages name the
path. A test checks that the published JSON Schema agrees with it, using the same fixture
configs for both.

**Letting the tools transition issues.** Status is how the team's off-line process (review,
business sign-off, prioritisation) shows up in Jira. An agent moving it would undercut the process
the issue exists to support.

## Implementation plan

Each step is a separate PR:

1. **This document.**
2. **Markdown ↔ Jira** (`simply-atlassian-core`):
   - Split `src/markdown-storage.ts` into a parser producing an AST (`src/markdown-ast.ts`) and
     emitters: storage (the existing behavior, unchanged), `src/markdown-adf.ts` and
     `src/markdown-wiki.ts`.
   - Add the reverse conversions, ADF → Markdown and wiki → Markdown, for `get` and diffs, plus a
     storage reader (`src/storage-reading.ts`) that round-trips what `markdownToStorage` writes.
     Content they can't convert is named in `lossy` (see below).
   - Side benefit: a `markdown` input on `jira_issue_create`, `jira_issue_update`,
     `jira_issue_comment_add` and `jira_issue_comment_edit`, with matching `--markdown` flags.
3. **Config and field codecs** (`simply-atlassian-core`):
   - `src/work-config.ts`: discovery, validation, and errors with property paths.
   - `schema/work-config.schema.json`.
   - `src/work-fields.ts`: one encode/decode per type, for each deployment. `user` reuses the
     existing user search.
4. **Pair logic** (`simply-atlassian-core`, `src/work-item.ts`):
   - Finding the pair, revisions, validation, `always`/`default`, diffing, and request building.
   - Reuses `buildCreateIssueBody` / `buildUpdateIssueBody` through the raw `body` path
     (`jira-issues.ts`), `buildRemoteLinkBody` (`jira-remote-links.ts`), and the version-checked
     page create/update in `confluence-pages.ts`.
5. **CLI** (`simply-atlassian`):
   - `atlassian jira work get|save|config-check`, plus a `--config` flag on the base command.
   - `save` takes `--file <json>`, or `--file -` for stdin, and `--accept-loss`.
   - Regenerate `command-snapshot.json` and the README.
6. **MCP** (`simply-atlassian-mcp`):
   - Three `tool({...})` entries in `src/tools.ts`, with `jira_work_save` using `WRITE_SHAPE`.
   - `--config` on `atlassian mcp`.
   - Add to `instructions`.
   - Update `docs/guides/mcp-server.md` with the worked config above.
   - Bring 0007's out-of-date tool counts up to date while there.

## Testing

- **`markdown-adf` / `markdown-wiki`:**
  - Golden outputs for headings, nested and ordered lists, bold and italic, links, code blocks
    with language, and tables.
  - Errors on unsupported constructs.
  - The reverse conversion round-trips every golden case to the same Markdown.
- **`work-config`:**
  - The example above validates.
  - Each invalid case fails with its property path: missing `key`, duplicate `name`, `always`
    without `value`, `default` with `always`, `allowed` on `text`, a credential-like key.
  - Upward discovery and precedence (flag > env > file).
  - The JSON Schema accepts and rejects the same fixtures.
- **`work-fields`:**
  - Encode and decode for every type, on both deployments.
  - `priority` / `assignee` / `parent` special cases.
  - `user` resolution through the test server.
- **`work-item`:**
  - `required` is checked on the merged final state.
  - `always` overrides the agent's value and is reported in `adjusted`.
  - `default` applies on create only.
  - Each `allowed` violation is reported, and all errors come back together.
  - Required page headings are enforced.
  - **Revision rules:**
    - no `basedOn` → `read-required`;
    - a configured field changed → `stale` with a diff;
    - only status or comments changed → not stale;
    - a page version bump → `stale`;
    - a Confluence 409 on write → `stale`.
- **Fake-server tests** (`@simplysf/simply-atlassian-core/testing`), on Cloud and Server/DC:
  - Create the pair from nothing (issue first, title from its key).
  - Adopt an existing issue and add a page.
  - Adopt an existing page and create the issue, without rewriting the page.
  - `get` from the issue follows its remote links, including one added in Jira; `get` from a page
    alone reads only the page; several linked pages are refused unless one is named.
  - Partial failure reports which steps landed.
  - `config-check` catches an unknown `customfield`, a missing component, and an `allowed` value
    that isn't one of the field's options.
- **MCP** (`test/server.test.ts`):
  - `jira_work_get` and `jira_work_config_check` are registered without `--allow-writes`, and
    `jira_work_save` only with it.
  - `dryRun` sends no requests and returns a diff.
  - `ATLASSIAN_READ_ONLY` refuses the save.
  - `instructions` mention `basedOn`.
- **Parity:** `test/tools.test.ts` stays green with the new commands in `command-snapshot.json`.
- **Manual:**
  - In a sandbox project with the example config, run idea → issue and page → status moved by
    hand → engineering iterations with a deliberate concurrent edit in the browser → an
    implementing agent reads the spec.
  - Run it once each in Claude Code, Codex and Gemini CLI.

## What changed in implementation

- **Lossy content is refused, not carried.** The draft proposed keeping macros, mentions and
  panels as opaque fenced blocks that pass through a save. Building it showed the cost: carrying
  raw storage or ADF through Markdown would let Markdown inject macros, which 0013 deliberately
  forbids, unless every block were checked against the current document. Instead:
  - `get` names what a field or page holds that Markdown cannot carry, in `lossy`.
  - `save` refuses to replace such a field or page unless `acceptLoss` is passed.
  - Fields the save does not touch are never re-sent, so they are never at risk.
  - Linking an existing page without `markdown` writes nothing to the page, so a hand-made page
    keeps its macros.
- **The stale diff runs from current to proposed.** Neither product serves the content at an old
  revision cheaply (Jira not at all), so the diff shows what the refused save would have changed,
  which is the agent's own edit plus the other person's change it would undo.
- **Validation failures are `config` errors**, like every other usage error in this server, with
  every problem in one message. There is no separate validation code.
- **`value` requires `always`.** A fixed value without `always` would have done nothing, so it is
  refused rather than silently ignored.
- **The issue's summary is required on create** whatever the config says, because Jira refuses an
  issue without one. A config must also list the summary field.
- **The config accepts trailing commas** as well as comments, because JSONC formatters (Prettier
  among them) add them. A test parses the examples in this document and the guide exactly as
  written.
- **Schema and validator agreement** is checked by comparing the schema's property and type lists
  with the keys the validator exports (`WORK_CONFIG_KEYS`, `WORK_FIELD_TYPES`), not by running a
  JSON Schema validator, which would have meant a new development dependency.
- **Page reading has its own reader.** `storageToMarkdown` is a display renderer and stays lossy
  by design: it turns a `<br />` into a space and leaves asterisks unescaped. Editing needs an
  exact round trip, so `storage-reading.ts` reads storage into the same tree `markdown-ast.ts`
  produces.
- **Wiki markup escaping is minimal.** A formatting character is escaped only where it could open
  formatting, so `AC-1` stays readable in Jira's text editor. A literal backslash cannot be
  escaped in wiki markup (`\\` is a line break), so one directly before a markup character does
  not round-trip.
- **The pair lives in Jira only.** The first build linked both ways: a remote link with a custom
  `Confluence page` relationship that won over other links, plus the issue line on the page, which
  `get` parsed to find the issue from the page and `save` used to refuse a page owned by another
  issue. Review pointed out that Jira already links issues to Confluence pages, and that keeping
  the connection anywhere else splits it. Now the issue's remote links are the only record, so a
  link a person adds or removes in Jira is the pairing; the issue line is for readers; and adopting
  a page no longer rewrites it to add that line.
- **The `--xray` and 0007 doc counts** were not updated; that remains a follow-up.

## Open questions

- **Several issue types.** For example, Story and Bug with different fields. A `jira.types` map
  keyed by issue type, with `get` picking the spec by the issue's type? This design starts with one
  type. Decided by: the first team that needs two.
- **Content the converters can't express.** Settled in implementation: refuse to replace it unless
  the caller passes `acceptLoss`, rather than carrying it as opaque blocks (see below). Opaque
  blocks remain a possible later improvement; the maintainer should confirm the choice.
- **Config inheritance.** An organisation with many repos may want `"extends": "<path or package>"`
  for shared fields such as components and labels. This design leaves it out until it's asked for.
- **Acceptance criteria in two places.** When the page restates the issue's acceptance criteria,
  should `get` flag differences between the two? That would mean the server understanding content,
  which this design otherwise avoids. Leaning no.
