---
title: Work items
description: Shape every Jira story and its Confluence design page from one config file in your repository, and let any agent read and write them safely.
---

A **work item** is one Jira issue plus, when the work needs one, a single Confluence page linked to
it. The `jira work` commands, and the `jira_work_*` tools of the [MCP server](/guides/mcp-server/),
read and write the pair as a unit.

What a work item contains is decided by your project, not by this tool. A config file checked into
your repository lists every Jira field, says what belongs in each one, and fixes the values that
must always be set. The same file describes the Confluence page. Any agent, whether Claude, Codex,
Gemini or another, reads that shape from the tools and is held to it, so every story ends up with
the same structure whichever model wrote it.

## The workflow

1. **Product shapes the idea.** A product manager talks it through with an agent. The agent reads
   the empty shape (`jira_work_get` with nothing), drafts the fields by following each field's
   `description`, previews the result with `dryRun`, and saves.
   - If the work is complex enough to meet the config's `when` rule, the agent also writes the
     page, and the two are linked both ways.
   - The issue or the page may already exist. Pass its key or id and the agent picks up from it.
2. **The issue moves through your process.** Reviews, sign-off by business users outside any agent
   tool, and prioritisation all happen as they do today. These tools never change an issue's
   status.
3. **Engineering refines the design.** An engineer and their agent read the work item and iterate
   on the page until the design is good.
4. **An agent implements.** It reads the work item. The issue and page Markdown together are the
   specification.

Every save has to build on a read. That is what makes it safe for product, engineering, reviewers
and several agents to edit the same two documents over days. How it works is described under
[Read before write](#read-before-write) below.

## The config file

Put it at `.simply/atlassian.json` in your repository. Commands and the MCP server find it by
searching upward from the working directory. To use a different file, pass `--config <path>` or set
`ATLASSIAN_CONFIG`.

The file never holds credentials, which stay in the environment or an `--env-file` as usual. A key
named like a credential is refused, so the file is always safe to commit. Comments are allowed.

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
    "when": "Create a page when the work spans more than one system, changes a data model or API, or needs design discussion.",
    "sections": [
      { "heading": "Problem", "required": true, "description": "The issue's problem restated for engineers." },
      { "heading": "Design", "required": true, "description": "The chosen approach and the components it touches." },
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

To find field keys such as `customfield_10045`, use `simply atlassian jira fields --search "acceptance"`.

### Fields

| Property      | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `name`        | The label the agent reads and writes against. Unique in the file.                                           |
| `key`         | The Jira field id.                                                                                          |
| `type`        | How the value is sent. See the table below.                                                                 |
| `description` | What belongs in the field, as instructions to the agent. Never sent to Jira.                                |
| `required`    | A save that would leave the field empty is refused.                                                         |
| `value`       | Used with `always: true`: the value the server applies on every save. The agent cannot change or remove it. |
| `default`     | Applied when an issue is created without this field. The agent may override it.                             |
| `allowed`     | For `option`, `options`, `components`, `versions` and `labels`: the only values a save may use.             |

Only the fields listed are read or written. Any other field on the issue is left untouched.

| `type`       | Value the agent passes               | Notes                                                                                      |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `text`       | string                               | Single-line text, such as the summary.                                                     |
| `markdown`   | Markdown                             | Converted to rich text: ADF on Cloud, wiki markup on Server/Data Center.                   |
| `number`     | number                               |                                                                                            |
| `date`       | `YYYY-MM-DD`                         |                                                                                            |
| `option`     | string                               | A select list. `priority` is handled too.                                                  |
| `options`    | list of strings                      | A multi-select list.                                                                       |
| `components` | list of names                        |                                                                                            |
| `versions`   | list of names                        | For example, `fixVersions`.                                                                |
| `labels`     | list of labels                       | Labels cannot contain spaces.                                                              |
| `user`       | email, name, account id, or username | On Cloud this is looked up and must match exactly one person. Ambiguous names are refused. |
| `issue`      | issue key                            | `parent` for an epic or parent issue, or an Epic Link custom field.                        |
| `raw`        | any JSON                             | Sent as-is, for field types not listed here. Nothing about it is checked.                  |

### The page

| Property   | Meaning                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `space`    | The space new pages are created in.                                                             |
| `parent`   | The page id new pages are created under.                                                        |
| `title`    | The title pattern for new pages. `{issue.key}` and `{issue.<field name>}` are filled in.        |
| `labels`   | Labels added to every page this tool creates or updates.                                        |
| `when`     | Your rule for when a work item deserves a page. The agent applies it; the server does not.      |
| `sections` | `{ heading, description, required }`. A required heading must exist for a page save to succeed. |

The page is a single Markdown document that product and engineering both edit. The sections guide
what goes in it and set the minimum content, but no part of the page belongs to one role.

Leave out `confluence` if your work items have no pages.

### Check the config against Jira and Confluence

```sh
simply atlassian jira work config-check
```

This checks that:

- the project and issue type exist;
- every field key is on the create screen;
- every fixed and allowed value is a real option, component or version;
- every field Jira requires on create is configured;
- the space and parent page exist.

It exits 1 if anything is wrong. Run it in CI so that a renamed component fails the build instead
of an agent's save.

## Read and save

```sh
simply atlassian jira work get                  # the empty shape, for a new idea
simply atlassian jira work get PAY-412          # the issue and its page
simply atlassian jira work get --page 987654    # the same pair, found from the page
```

A save takes JSON, in the same shape the MCP tool takes:

```json
{
  "issue": {
    "key": "PAY-412",
    "basedOn": "sha256:5f1c…",
    "fields": { "Acceptance Criteria": "1. **AC-1** Given…", "Priority": "High" }
  },
  "page": { "id": "987654", "basedOn": 7, "markdown": "# Problem\n…" }
}
```

```sh
simply atlassian jira work save --file change.json --dry-run   # show the diff, send nothing
simply atlassian jira work save --file change.json
```

How a save behaves:

- **Leave out `key` to create the issue, and `id` to create the page.** When both are new, the
  issue is created first so the page title and header can use its key.
- **Fields you omit keep their current values.** Fixed values are applied every time, and defaults
  are filled in on create. The result's `adjusted` list says what the config changed, so you can
  pass that on.
- **To link an existing page without rewriting it,** pass its `id` with no `markdown`. Only a line
  naming the issue is added at the top. The page's own content, macros included, is left exactly
  as it was.
- **Everything is checked before anything is sent,** and every problem is reported at once.
- **Writes happen in order: issue, then page, then links.** If a later step fails, the error says
  exactly what was already saved. Nothing is rolled back; read the work item again and save the
  rest.
- **A save never changes issue status.**

## Read before write

A read returns a `revision` for each half. To update a half, the save must pass that revision as
`basedOn`:

| Situation                        | Result                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| No `basedOn` on an update        | Refused as `read-required`. Read first.                                                                                                  |
| The half changed after your read | Refused as `stale`, with the current content and a diff from it to what you tried to save. Merge their change into yours and save again. |
| Unchanged                        | Saved. The result holds the new revisions for your next save.                                                                            |

The issue's revision only covers the fields you configured. A status change, comment or sprint
move made in Jira does not make your next save stale.

How fully this is enforced differs between the two products:

- **Confluence:** the page's own version check closes the gap completely.
- **Jira:** there is no conditional update, so an edit made in the fraction of a second between the
  server's re-check and its write can still be overwritten. The check narrows the problem a long
  way, but cannot close it.

## Content Markdown cannot carry

Some content has no Markdown form, for example:

- mentions;
- panels, macros and column layouts;
- images and attachments;
- status lozenges;
- text colour and strikethrough.

When a field or the page holds any of these, `get` lists them under `lossy` and shows the nearest
text. A save that would replace that field or page is refused unless it passes `acceptLoss: true`
(`--accept-loss` on the CLI), because saving would remove them. Make the edit in Jira or Confluence
instead, or accept the loss on purpose. Fields you do not touch are never rewritten, so a mention
in a field nobody edits is safe.
