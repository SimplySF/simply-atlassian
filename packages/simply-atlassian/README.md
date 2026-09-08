# @simplysf/simply-atlassian

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian?label=@simplysf/simply-atlassian)](https://npmjs.com/@simplysf/simply-atlassian) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

Command-line interface for working with Atlassian products, built by [SimplySF](https://github.com/SimplySF).

Covers Jira issues — search, view, create, update, transition, and delete — plus reading
Confluence pages. Output is human-readable by default and raw JSON with `--json`, and every
command that changes data takes `--dry-run`, so it is usable both at a terminal and by a script
or agent. See [Commands](#commands) below for the full reference.

Verified against Jira and Confluence Cloud. Server/Data Center is implemented but not yet
verified against a live instance.

## Install

```bash
npm install -g @simplysf/simply-atlassian
```

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See the repo's [CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for the repo structure, how to set up and build the project, our commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## Credentials

Connection settings come from environment variables, or from a `.env` file named with
`-e/--env-file`. Only Atlassian connection variables are read from that file; anything else in
it is ignored.

```
JIRA_URL=https://your-site.atlassian.net
JIRA_USERNAME=you@example.com          # Cloud
JIRA_API_TOKEN=...                     # Cloud
JIRA_PERSONAL_TOKEN=...                # Server/Data Center, instead of the two above

CONFLUENCE_URL=https://your-site.atlassian.net
CONFLUENCE_USERNAME=you@example.com
CONFLUENCE_API_TOKEN=...
```

Explicit flags beat the environment, which beats the file's contents. Certificate verification
is always on: for an instance behind an internal or agency CA, trust that CA with
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem` rather than disabling verification.

## Write safety

The commands that change data — `issue create`, `update`, `transition` — and the one that
destroys it — `issue delete` — sit behind three layers. Only the last is a real boundary, and
it is worth being clear about which is which.

**`--confirm`** is required by `issue delete`, and by nothing else. It stops accidents: a
malformed command, a mistyped key. It does not stop a caller that decides to pass it, and
requiring it everywhere would train callers to pass it always — at which point it protects
nothing while still implying that it does.

**`--dry-run`** is accepted by every write command. It prints the request that would be sent
and sends nothing, which is the cheapest way to see what is about to happen.

**`ATLASSIAN_READ_ONLY`** — set it to `1`, `true`, `yes`, or `on` and every write command
refuses before making any request. Reads are unaffected. This guards against
misconfiguration: the wrong credential file, the wrong context. It is not a security boundary,
because anything that can run commands can also unset an environment variable.

**A read-scoped API token is the only layer that actually binds.** Atlassian's scoped API
tokens grant named scopes, so a token with read scopes and no write scopes cannot create,
edit, or delete anything — the instance refuses server-side, regardless of what this CLI sends
or what any caller is persuaded to attempt.

That matters most when an AI agent drives the CLI, because ticket and page text is written by
whoever can edit it, and an agent reading that text cannot reliably tell instructions from
content. The arrangement worth adopting is two credential files:

```
~/atlassian.env        # read-scoped token — what the agent uses by default
~/atlassian-write.env  # write-capable token — passed explicitly, by a person
```

```bash
simply atlassian jira issue search -e ~/atlassian.env --jql "project = PROJ"
simply atlassian jira issue delete PROJ-1 -e ~/atlassian-write.env --confirm
```

The agent's normal loop is then structurally incapable of changing anything, and a write
becomes a deliberate act. A 403 from a read-scoped token is reported as an authentication
error that says the credential cannot make changes, rather than looking like a permissions bug.

## Commands

<!-- commands -->

- [`simply atlassian confluence page children PAGE`](#simply-atlassian-confluence-page-children-page)
- [`simply atlassian confluence page get PAGE`](#simply-atlassian-confluence-page-get-page)
- [`simply atlassian confluence page search`](#simply-atlassian-confluence-page-search)
- [`simply atlassian jira issue comment add ISSUE`](#simply-atlassian-jira-issue-comment-add-issue)
- [`simply atlassian jira issue comment delete ISSUE COMMENT`](#simply-atlassian-jira-issue-comment-delete-issue-comment)
- [`simply atlassian jira issue comment edit ISSUE COMMENT`](#simply-atlassian-jira-issue-comment-edit-issue-comment)
- [`simply atlassian jira issue comment list ISSUE`](#simply-atlassian-jira-issue-comment-list-issue)
- [`simply atlassian jira issue create`](#simply-atlassian-jira-issue-create)
- [`simply atlassian jira issue delete ISSUE`](#simply-atlassian-jira-issue-delete-issue)
- [`simply atlassian jira issue search`](#simply-atlassian-jira-issue-search)
- [`simply atlassian jira issue transition ISSUE TRANSITION`](#simply-atlassian-jira-issue-transition-issue-transition)
- [`simply atlassian jira issue transitions ISSUE`](#simply-atlassian-jira-issue-transitions-issue)
- [`simply atlassian jira issue update ISSUE`](#simply-atlassian-jira-issue-update-issue)
- [`simply atlassian jira issue view ISSUE`](#simply-atlassian-jira-issue-view-issue)
- [`simply atlassian jira user search QUERY`](#simply-atlassian-jira-user-search-query)
- [`simply atlassian jira user view ACCOUNT`](#simply-atlassian-jira-user-view-account)
- [`simply atlassian jira whoami`](#simply-atlassian-jira-whoami)

## `simply atlassian confluence page children PAGE`

List the direct child pages of a Confluence page.

```
USAGE
  $ simply atlassian confluence page children PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--limit <value>]

ARGUMENTS
  PAGE  Page id, or a page URL to read the id from.

FLAGS
  --limit=<value>  [default: 25] Maximum number of children to return.

CONNECTION FLAGS
  -e, --env-file=<value>                   Path to a .env file holding connection settings.
      --confluence-api-token=<value>       [env: CONFLUENCE_API_TOKEN] API token for Confluence Cloud basic auth.
      --confluence-personal-token=<value>  [env: CONFLUENCE_PERSONAL_TOKEN] Personal access token for Confluence
                                           Server/Data Center.
      --confluence-url=<value>             [env: CONFLUENCE_URL] Base URL of the Confluence instance.
      --confluence-username=<value>        [env: CONFLUENCE_USERNAME] Account email for Confluence Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List the direct child pages of a Confluence page.

  Lists pages one level below the given page. Use --json for the complete, unmodified API payload.

EXAMPLES
  $ simply atlassian confluence page children 123456

  $ simply atlassian confluence page children https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title

  $ simply atlassian confluence page children 123456 --limit 50 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/page/children.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/confluence/page/children.js)_

## `simply atlassian confluence page get PAGE`

Show a single Confluence page.

```
USAGE
  $ simply atlassian confluence page get PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--body-format markdown|storage|none]
    [--expand <value>]

ARGUMENTS
  PAGE  Page id, or a page URL to read the id from.

FLAGS
  --body-format=<option>  [default: markdown] How to render the page body.
                          <options: markdown|storage|none>
  --expand=<value>        Comma-separated Confluence expansions, replacing the default set.

CONNECTION FLAGS
  -e, --env-file=<value>                   Path to a .env file holding connection settings.
      --confluence-api-token=<value>       [env: CONFLUENCE_API_TOKEN] API token for Confluence Cloud basic auth.
      --confluence-personal-token=<value>  [env: CONFLUENCE_PERSONAL_TOKEN] Personal access token for Confluence
                                           Server/Data Center.
      --confluence-url=<value>             [env: CONFLUENCE_URL] Base URL of the Confluence instance.
      --confluence-username=<value>        [env: CONFLUENCE_USERNAME] Account email for Confluence Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show a single Confluence page.

  Prints page metadata followed by its body. The body is converted to Markdown by default; --body-format storage prints
  the stored XHTML verbatim, and none omits it entirely (and does not request it, which matters when listing pages whose
  content will not be read). Use --json for the complete, unmodified API payload.

EXAMPLES
  $ simply atlassian confluence page get 123456

  $ simply atlassian confluence page get https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title

  $ simply atlassian confluence page get 123456 --body-format none

  $ simply atlassian confluence page get 123456 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/page/get.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/confluence/page/get.js)_

## `simply atlassian confluence page search`

Search Confluence content with CQL.

```
USAGE
  $ simply atlassian confluence page search --cql <value> [--json] [-e <value>] [--confluence-url <value>] [--confluence-username
    <value>] [--confluence-api-token <value>] [--confluence-personal-token <value>] [--limit <value>]

FLAGS
  --cql=<value>    (required) CQL query to run.
  --limit=<value>  [default: 25] Maximum number of results to return across all pages.

CONNECTION FLAGS
  -e, --env-file=<value>                   Path to a .env file holding connection settings.
      --confluence-api-token=<value>       [env: CONFLUENCE_API_TOKEN] API token for Confluence Cloud basic auth.
      --confluence-personal-token=<value>  [env: CONFLUENCE_PERSONAL_TOKEN] Personal access token for Confluence
                                           Server/Data Center.
      --confluence-url=<value>             [env: CONFLUENCE_URL] Base URL of the Confluence instance.
      --confluence-username=<value>        [env: CONFLUENCE_USERNAME] Account email for Confluence Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Search Confluence content with CQL.

  Runs a CQL query and follows result pages until the limit is reached or the instance has no more matches. Use --json
  for the complete, unmodified API payload of every result.

EXAMPLES
  $ simply atlassian confluence page search --cql "type = page AND space = DOCS"

  $ simply atlassian confluence page search --cql 'text ~ "release notes"' --limit 10

  $ simply atlassian confluence page search --cql "type = page order by lastmodified desc" --limit 5 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/page/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/confluence/page/search.js)_

## `simply atlassian jira issue comment add ISSUE`

Add a comment to a Jira issue.

```
USAGE
  $ simply atlassian jira issue comment add ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--text <value>] [--mention <value>...]
    [--body <value> | --body-file <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --body=<value>        Raw JSON request body.
  --body-file=<value>   Path to a file holding the raw JSON request body.
  --dry-run             Print the request that would be sent and exit without sending it.
  --mention=<value>...  Account id, or a name or email to resolve. Repeatable.
  --text=<value>        Comment text.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Add a comment to a Jira issue.

  The comment text is passed as plain text and converted to the shape the deployment expects — Atlassian Document Format
  on Cloud, a string on Server/DC. Use --body or --body-file for anything the text alone cannot express, such as
  restricting visibility to a role or group. Use --dry-run to see what would be sent without sending it.

EXAMPLES
  $ simply atlassian jira issue comment add PROJ-123 --text "Deployed to staging"

  $ simply atlassian jira issue comment add PROJ-123 --text "See the runbook" --dry-run

  $ simply atlassian jira issue comment add PROJ-123 --body-file ./comment.json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --mention=<value>...  Account id, or a name or email to resolve. Repeatable.

    An email address is the term most likely to be unique. A term matching more than one user is an error listing the
    candidates, rather than a guess at who was meant.
```

_See code: [lib/commands/atlassian/jira/issue/comment/add.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/add.js)_

## `simply atlassian jira issue comment delete ISSUE COMMENT`

Delete a comment.

```
USAGE
  $ simply atlassian jira issue comment delete ISSUE COMMENT [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--confirm]

ARGUMENTS
  ISSUE    Issue key, for example PROJ-123.
  COMMENT  Comment id, from "issue comment list".

FLAGS
  --confirm  Required to proceed with an irreversible change.
  --dry-run  Print the request that would be sent and exit without sending it.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Delete a comment.

  A deleted comment cannot be recovered through the API, so --confirm is required — the same rule "issue delete"
  follows. Comment ids come from "issue comment list".

EXAMPLES
  $ simply atlassian jira issue comment delete PROJ-123 10001 --confirm

  $ simply atlassian jira issue comment delete PROJ-123 10001 --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --confirm  Required to proceed with an irreversible change.

    There is deliberately no short form: a single letter is too easy to add by habit.
```

_See code: [lib/commands/atlassian/jira/issue/comment/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/delete.js)_

## `simply atlassian jira issue comment edit ISSUE COMMENT`

Change an existing comment.

```
USAGE
  $ simply atlassian jira issue comment edit ISSUE COMMENT [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--text <value>] [--mention <value>...]
    [--body <value> | --body-file <value>]

ARGUMENTS
  ISSUE    Issue key, for example PROJ-123.
  COMMENT  Comment id, from "issue comment list".

FLAGS
  --body=<value>        Raw JSON request body.
  --body-file=<value>   Path to a file holding the raw JSON request body.
  --dry-run             Print the request that would be sent and exit without sending it.
  --mention=<value>...  Account id, or a name or email to resolve. Repeatable.
  --text=<value>        Replacement comment text.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Change an existing comment.

  Replaces the comment body — it does not append to it, since an edit that silently added text would be a surprising way
  to lose a comment's meaning. Comment ids come from "issue comment list"; they are not visible in the Jira UI.

EXAMPLES
  $ simply atlassian jira issue comment edit PROJ-123 10001 --text "Corrected: staging, not production"

  $ simply atlassian jira issue comment edit PROJ-123 10001 --text "please review" --mention ada@example.com

  $ simply atlassian jira issue comment edit PROJ-123 10001 --text "x" --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --mention=<value>...  Account id, or a name or email to resolve. Repeatable.

    A term matching more than one user is an error listing the candidates, rather than a guess.
```

_See code: [lib/commands/atlassian/jira/issue/comment/edit.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/edit.js)_

## `simply atlassian jira issue comment list ISSUE`

List an issue's comments.

```
USAGE
  $ simply atlassian jira issue comment list ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--limit <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --limit=<value>  [default: 25] Maximum number of comments to return.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List an issue's comments.

  Shows one line per comment. Bodies are Atlassian Document Format on Cloud, so the preview column is flattened text;
  use --json for the unmodified payload.

EXAMPLES
  $ simply atlassian jira issue comment list PROJ-123

  $ simply atlassian jira issue comment list PROJ-123 --limit 5 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/comment/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/list.js)_

## `simply atlassian jira issue create`

Create a Jira issue.

```
USAGE
  $ simply atlassian jira issue create [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>] [--dry-run] [--project <value>] [--type <value>] [--summary <value>]
    [--description <value>] [--assignee <value>] [--priority <value>] [--label <value>...] [--body <value> | --body-file
    <value>]

FLAGS
  --assignee=<value>     Assignee: account id on Cloud, username on Server/DC.
  --body=<value>         Raw JSON request body.
  --body-file=<value>    Path to a file holding the raw JSON request body.
  --description=<value>  Issue description as plain text.
  --dry-run              Print the request that would be sent and exit without sending it.
  --label=<value>...     Label to apply. Repeatable.
  --priority=<value>     Priority name.
  --project=<value>      Project key the issue belongs to.
  --summary=<value>      Issue summary.
  --type=<value>         Issue type name, for example Task or Bug.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Create a Jira issue.

  Common fields have flags; --body or --body-file supplies raw fields JSON for anything else, including custom fields.
  Typed flags are merged over the body, so a template file can provide the shape and a flag can override one value. Use
  --dry-run to see exactly what would be sent without sending it.

EXAMPLES
  $ simply atlassian jira issue create --project PROJ --type Task --summary "Fix the thing"

  $ simply atlassian jira issue create --project PROJ --type Bug --summary "Crash" --label urgent --label triage

  $ simply atlassian jira issue create --body-file ./issue.json --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/create.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/create.js)_

## `simply atlassian jira issue delete ISSUE`

Delete a Jira issue.

```
USAGE
  $ simply atlassian jira issue delete ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--confirm] [--delete-subtasks]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --confirm          Required to proceed with an irreversible change.
  --delete-subtasks  Also delete the issue's subtasks.
  --dry-run          Print the request that would be sent and exit without sending it.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Delete a Jira issue.

  Irreversible, so --confirm is required. There is no short form for it on purpose. Use --dry-run to see what would be
  deleted without deleting it.

EXAMPLES
  $ simply atlassian jira issue delete PROJ-123 --confirm

  $ simply atlassian jira issue delete PROJ-123 --confirm --delete-subtasks

  $ simply atlassian jira issue delete PROJ-123 --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --confirm  Required to proceed with an irreversible change.

    There is deliberately no short form: a single letter is too easy to add by habit.

  --delete-subtasks  Also delete the issue's subtasks.

    Without this, Jira refuses to delete an issue that has subtasks.
```

_See code: [lib/commands/atlassian/jira/issue/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/delete.js)_

## `simply atlassian jira issue search`

Search issues with JQL.

```
USAGE
  $ simply atlassian jira issue search --jql <value> [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--limit <value>] [--fields <value>]

FLAGS
  --fields=<value>  Comma-separated field names to request instead of the instance default.
  --jql=<value>     (required) JQL query to run.
  --limit=<value>   [default: 50] Maximum number of issues to return across all pages.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Search issues with JQL.

  Runs a JQL query and follows result pages until the limit is reached or the instance has no more matches. Use --json
  for the complete, unmodified API payload of every issue.

  Jira Cloud rejects an unbounded query, so include a restriction such as a project, an assignee, or a date range —
  "order by updated desc" alone returns an error there, while "updated >= -7d order by updated desc" works on both
  deployments.

EXAMPLES
  $ simply atlassian jira issue search --jql "project = PROJ AND statusCategory != Done"

  $ simply atlassian jira issue search --jql "assignee = currentUser()" --limit 10

  $ simply atlassian jira issue search --jql "updated >= -7d order by updated desc" --limit 5 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/search.js)_

## `simply atlassian jira issue transition ISSUE TRANSITION`

Move a Jira issue through a workflow transition.

```
USAGE
  $ simply atlassian jira issue transition ISSUE TRANSITION [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--comment <value>] [--by-name] [--body
    <value> | --body-file <value>]

ARGUMENTS
  ISSUE       Issue key, for example PROJ-123.
  TRANSITION  Transition id, or its name.

FLAGS
  --body=<value>       Raw JSON request body.
  --body-file=<value>  Path to a file holding the raw JSON request body.
  --by-name            Treat the transition argument as a name even if it is all digits.
  --comment=<value>    Comment to add as part of the transition.
  --dry-run            Print the request that would be sent and exit without sending it.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Move a Jira issue through a workflow transition.

  The transition may be given as an id or as a name, matched case-insensitively against the transitions currently
  available for the issue — a name is what a person or an agent actually knows. An unmatched name lists what is
  available. Use "issue transitions" to see the set, or --dry-run to check without sending.

EXAMPLES
  $ simply atlassian jira issue transition PROJ-123 Done

  $ simply atlassian jira issue transition PROJ-123 "In Progress"

  $ simply atlassian jira issue transition PROJ-123 31

  $ simply atlassian jira issue transition PROJ-123 Done --comment "shipped"

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --by-name  Treat the transition argument as a name even if it is all digits.

    A digits-only argument is otherwise taken as an id, which makes a workflow step literally named "41" unreachable.
```

_See code: [lib/commands/atlassian/jira/issue/transition.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/transition.js)_

## `simply atlassian jira issue transitions ISSUE`

List the transitions available for an issue.

```
USAGE
  $ simply atlassian jira issue transitions ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List the transitions available for an issue.

  Shows which transitions the issue can currently take, which is what makes "issue transition" usable: the available set
  depends on the workflow and the current status.

EXAMPLES
  $ simply atlassian jira issue transitions PROJ-123

  $ simply atlassian jira issue transitions PROJ-123 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/transitions.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/transitions.js)_

## `simply atlassian jira issue update ISSUE`

Update fields on a Jira issue.

```
USAGE
  $ simply atlassian jira issue update ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--summary <value>] [--description <value>]
    [--assignee <value>] [--priority <value>] [--label <value>...] [--body <value> | --body-file <value>] [--verify]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --assignee=<value>     New assignee: account id on Cloud, username on Server/DC.
  --body=<value>         Raw JSON request body.
  --body-file=<value>    Path to a file holding the raw JSON request body.
  --description=<value>  New description as plain text.
  --dry-run              Print the request that would be sent and exit without sending it.
  --label=<value>...     Label to set. Repeatable, and replaces the existing labels.
  --priority=<value>     New priority name.
  --summary=<value>      New summary.
  --[no-]verify          Re-read the issue after updating and print it.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Update fields on a Jira issue.

  Common fields have flags; --body or --body-file supplies raw fields JSON for anything else, including custom fields.
  Jira answers an update with an empty 204, so the issue is re-read afterwards and printed — silence is a poor
  confirmation that anything changed. Pass --no-verify to skip that second request.

EXAMPLES
  $ simply atlassian jira issue update PROJ-123 --summary "Clearer title"

  $ simply atlassian jira issue update PROJ-123 --label triage --label urgent

  $ simply atlassian jira issue update PROJ-123 --body-file ./fields.json --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/update.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/update.js)_

## `simply atlassian jira issue view ISSUE`

Show a single Jira issue.

```
USAGE
  $ simply atlassian jira issue view ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--fields <value>] [--expand <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --expand=<value>  Comma-separated Jira expand parameters (for example changelog).
  --fields=<value>  Comma-separated field names to request instead of the instance default.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show a single Jira issue.

  Prints a curated set of fields for one issue. Use --json for the complete, unmodified API payload, and --fields to
  control which fields the instance returns.

EXAMPLES
  $ simply atlassian jira issue view PROJ-123

  $ simply atlassian jira issue view PROJ-123 --json

  $ simply atlassian jira issue view PROJ-123 --fields summary,status,assignee

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/view.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/issue/view.js)_

## `simply atlassian jira user search QUERY`

Find users by name or email.

```
USAGE
  $ simply atlassian jira user search QUERY [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--limit <value>]

ARGUMENTS
  QUERY  Name or email to search for.

FLAGS
  --limit=<value>  [default: 20] Maximum number of users to return.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Find users by name or email.

  The account id column is the point of this command: it is what --mention and --assignee need, and it is not something
  anyone can guess. On Cloud, whether an email address is visible is a per-user privacy setting, so that column is often
  empty — searching by an email address still works even when it is not shown back.

EXAMPLES
  $ simply atlassian jira user search ada

  $ simply atlassian jira user search ada@example.com

  $ simply atlassian jira user search ada --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/user/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/user/search.js)_

## `simply atlassian jira user view ACCOUNT`

Show one user.

```
USAGE
  $ simply atlassian jira user view ACCOUNT [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>]

ARGUMENTS
  ACCOUNT  Account id (Cloud) or username (Server/DC).

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show one user.

  Takes an account id on Cloud, or a username on Server/Data Center — the same distinction the connection settings make.
  Use "user search" if you have a name rather than an id.

EXAMPLES
  $ simply atlassian jira user view 70121:8d8e579e-980f-49ed-93ec-0a0d519f60e4

  $ simply atlassian jira user view ada --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/user/view.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/user/view.js)_

## `simply atlassian jira whoami`

Show the account the configured credentials belong to.

```
USAGE
  $ simply atlassian jira whoami [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>]

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show the account the configured credentials belong to.

  Calls the Jira /myself endpoint. This is the cheapest way to confirm that the URL, credentials, and network path all
  work before running anything heavier.

EXAMPLES
  $ simply atlassian jira whoami

  $ simply atlassian jira whoami --env-file .env

  $ simply atlassian jira whoami --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/whoami.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/atlassian/jira/whoami.js)_
<!-- commandsstop -->

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
