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

- [`simply atlassian confluence open PAGE`](#simply-atlassian-confluence-open-page)
- [`simply atlassian confluence page children PAGE`](#simply-atlassian-confluence-page-children-page)
- [`simply atlassian confluence page comment add PAGE`](#simply-atlassian-confluence-page-comment-add-page)
- [`simply atlassian confluence page comment list PAGE`](#simply-atlassian-confluence-page-comment-list-page)
- [`simply atlassian confluence page create`](#simply-atlassian-confluence-page-create)
- [`simply atlassian confluence page delete PAGE`](#simply-atlassian-confluence-page-delete-page)
- [`simply atlassian confluence page get PAGE`](#simply-atlassian-confluence-page-get-page)
- [`simply atlassian confluence page label add PAGE`](#simply-atlassian-confluence-page-label-add-page)
- [`simply atlassian confluence page label list PAGE`](#simply-atlassian-confluence-page-label-list-page)
- [`simply atlassian confluence page search`](#simply-atlassian-confluence-page-search)
- [`simply atlassian confluence page update PAGE`](#simply-atlassian-confluence-page-update-page)
- [`simply atlassian jira board list`](#simply-atlassian-jira-board-list)
- [`simply atlassian jira fields`](#simply-atlassian-jira-fields)
- [`simply atlassian jira issue comment add ISSUE`](#simply-atlassian-jira-issue-comment-add-issue)
- [`simply atlassian jira issue comment delete ISSUE COMMENT`](#simply-atlassian-jira-issue-comment-delete-issue-comment)
- [`simply atlassian jira issue comment edit ISSUE COMMENT`](#simply-atlassian-jira-issue-comment-edit-issue-comment)
- [`simply atlassian jira issue comment list ISSUE`](#simply-atlassian-jira-issue-comment-list-issue)
- [`simply atlassian jira issue create`](#simply-atlassian-jira-issue-create)
- [`simply atlassian jira issue delete ISSUE`](#simply-atlassian-jira-issue-delete-issue)
- [`simply atlassian jira issue history ISSUE`](#simply-atlassian-jira-issue-history-issue)
- [`simply atlassian jira issue link create FROM TYPE TO`](#simply-atlassian-jira-issue-link-create-from-type-to)
- [`simply atlassian jira issue link delete LINK-ID`](#simply-atlassian-jira-issue-link-delete-link-id)
- [`simply atlassian jira issue link list ISSUE`](#simply-atlassian-jira-issue-link-list-issue)
- [`simply atlassian jira issue link types`](#simply-atlassian-jira-issue-link-types)
- [`simply atlassian jira issue remotelink create ISSUE`](#simply-atlassian-jira-issue-remotelink-create-issue)
- [`simply atlassian jira issue remotelink delete ISSUE LINK-ID`](#simply-atlassian-jira-issue-remotelink-delete-issue-link-id)
- [`simply atlassian jira issue remotelink list ISSUE`](#simply-atlassian-jira-issue-remotelink-list-issue)
- [`simply atlassian jira issue search`](#simply-atlassian-jira-issue-search)
- [`simply atlassian jira issue transition ISSUE TRANSITION`](#simply-atlassian-jira-issue-transition-issue-transition)
- [`simply atlassian jira issue transitions ISSUE`](#simply-atlassian-jira-issue-transitions-issue)
- [`simply atlassian jira issue update ISSUE`](#simply-atlassian-jira-issue-update-issue)
- [`simply atlassian jira issue view ISSUE`](#simply-atlassian-jira-issue-view-issue)
- [`simply atlassian jira open TARGET`](#simply-atlassian-jira-open-target)
- [`simply atlassian jira project versions PROJECT`](#simply-atlassian-jira-project-versions-project)
- [`simply atlassian jira projects`](#simply-atlassian-jira-projects)
- [`simply atlassian jira sprint add SPRINT ISSUE`](#simply-atlassian-jira-sprint-add-sprint-issue)
- [`simply atlassian jira sprint create`](#simply-atlassian-jira-sprint-create)
- [`simply atlassian jira sprint issues SPRINT`](#simply-atlassian-jira-sprint-issues-sprint)
- [`simply atlassian jira sprint list BOARD`](#simply-atlassian-jira-sprint-list-board)
- [`simply atlassian jira sprint update SPRINT`](#simply-atlassian-jira-sprint-update-sprint)
- [`simply atlassian jira user search QUERY`](#simply-atlassian-jira-user-search-query)
- [`simply atlassian jira user view ACCOUNT`](#simply-atlassian-jira-user-view-account)
- [`simply atlassian jira whoami`](#simply-atlassian-jira-whoami)

## `simply atlassian confluence open PAGE`

Open a Confluence page in the browser.

```
USAGE
  $ simply atlassian confluence open PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--print]

ARGUMENTS
  PAGE  Page id, or a page URL to read the id from.

FLAGS
  --print  Print the URL without opening a browser.

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
  Open a Confluence page in the browser.

  Builds the browser URL for a page id or page URL and opens it in the default browser. Use --print (or --url) to print
  the URL without launching a browser.

EXAMPLES
  $ simply atlassian confluence open 123456

  $ simply atlassian confluence open https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title --print

  $ simply atlassian confluence open 123456 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/open.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/open.js)_

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

_See code: [lib/commands/atlassian/confluence/page/children.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/children.js)_

## `simply atlassian confluence page comment add PAGE`

Add a comment to a Confluence page.

```
USAGE
  $ simply atlassian confluence page comment add PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--dry-run] [--text <value>] [--body <value>]
    [--body-file <value>] [--markdown <value>] [--markdown-file <value>]

ARGUMENTS
  PAGE  Page id, or a page URL.

FLAGS
  --body=<value>           Comment as raw storage-format XHTML.
  --body-file=<value>      Path to a file holding storage-format XHTML.
  --dry-run                Print the request that would be sent and exit without sending it.
  --markdown=<value>       Body as Markdown; converted to storage format.
  --markdown-file=<value>  Path to a Markdown file; converted to storage format.
  --text=<value>           Comment as plain text; becomes paragraphs, markup escaped.

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
  Add a comment to a Confluence page.

  A Confluence comment is content in its own right rather than a field on the page, so it takes the same body flags as a
  page: --text for plain prose, or --body/--body-file for storage-format XHTML. Markdown is not supported yet.

EXAMPLES
  $ simply atlassian confluence page comment add 123456 --text "Reviewed, looks right."

  $ simply atlassian confluence page comment add 123456 --body "<p>See <strong>section 2</strong>.</p>"

  $ simply atlassian confluence page comment add 123456 --text "wip" --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/page/comment/add.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/comment/add.js)_

## `simply atlassian confluence page comment list PAGE`

List a Confluence page's comments.

```
USAGE
  $ simply atlassian confluence page comment list PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--limit <value>]

ARGUMENTS
  PAGE  Page id, or a page URL.

FLAGS
  --limit=<value>  [default: 25] Maximum number of comments to return.

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
  List a Confluence page's comments.

  One line per comment. Bodies are stored as XHTML, so the preview column is flattened text; use --json for the
  unmodified payload. The ID column is what any later reply or removal needs and is not otherwise discoverable.

EXAMPLES
  $ simply atlassian confluence page comment list 123456

  $ simply atlassian confluence page comment list 123456 --limit 5 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/page/comment/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/comment/list.js)_

## `simply atlassian confluence page create`

Create a Confluence page.

```
USAGE
  $ simply atlassian confluence page create --space <value> --title <value> [--json] [-e <value>] [--confluence-url <value>]
    [--confluence-username <value>] [--confluence-api-token <value>] [--confluence-personal-token <value>] [--dry-run]
    [--parent <value>] [--text <value>] [--body <value>] [--body-file <value>] [--markdown <value>] [--markdown-file
    <value>]

FLAGS
  --body=<value>           Body as raw storage-format XHTML.
  --body-file=<value>      Path to a file holding storage-format XHTML.
  --dry-run                Print the request that would be sent and exit without sending it.
  --markdown=<value>       Body as Markdown; converted to storage format.
  --markdown-file=<value>  Path to a Markdown file; converted to storage format.
  --parent=<value>         Parent page id or URL, making this a child of it.
  --space=<value>          (required) Space key the page belongs to.
  --text=<value>           Body as plain text; becomes paragraphs, markup escaped.
  --title=<value>          (required) Page title.

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
  Create a Confluence page.

  The body is Confluence storage format — XHTML plus Atlassian macro tags — supplied with --body or --body-file.
  Markdown input is not supported yet; --text is the shortcut for plain prose, which becomes paragraphs with its markup
  characters escaped. Use --parent to place the page under another rather than at the space root, and --dry-run to see
  the exact request without sending it.

EXAMPLES
  $ simply atlassian confluence page create --space DOCS --title "Release notes" --text "Shipped today."

  $ simply atlassian confluence page create --space DOCS --title "Design" --body-file ./page.xml --parent 123456

  $ simply atlassian confluence page create --space DOCS --title "Draft" --text "wip" --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --parent=<value>  Parent page id or URL, making this a child of it.

    Without this the page lands at the space root. A page URL is accepted as well as a bare id.
```

_See code: [lib/commands/atlassian/confluence/page/create.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/create.js)_

## `simply atlassian confluence page delete PAGE`

Move a Confluence page to the trash, or destroy it.

```
USAGE
  $ simply atlassian confluence page delete PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--dry-run] [--confirm] [--purge]

ARGUMENTS
  PAGE  Page id, or a page URL.

FLAGS
  --confirm  Required to proceed with an irreversible change.
  --dry-run  Print the request that would be sent and exit without sending it.
  --purge    Destroy the page permanently instead of trashing it. Requires --confirm.

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
  Move a Confluence page to the trash, or destroy it.

  By default this trashes the page, which is reversible — it can be restored from the space trash — so no --confirm is
  required. --purge destroys it permanently and does require --confirm, because nothing brings it back. A page that is
  already trashed is purged directly; one that is not is trashed and then purged, so --purge always means "gone".

EXAMPLES
  $ simply atlassian confluence page delete 123456

  $ simply atlassian confluence page delete 123456 --purge --confirm

  $ simply atlassian confluence page delete 123456 --purge --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --confirm  Required to proceed with an irreversible change.

    There is deliberately no short form: a single letter is too easy to add by habit. It also takes no value — pass it
    bare, never --confirm=true or --confirm=false.
```

_See code: [lib/commands/atlassian/confluence/page/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/delete.js)_

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

_See code: [lib/commands/atlassian/confluence/page/get.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/get.js)_

## `simply atlassian confluence page label add PAGE`

Add labels to a page.

```
USAGE
  $ simply atlassian confluence page label add PAGE --label <value>... [--json] [-e <value>] [--confluence-url <value>]
    [--confluence-username <value>] [--confluence-api-token <value>] [--confluence-personal-token <value>] [--dry-run]
    [--prefix <value>]

ARGUMENTS
  PAGE  Page id, or a page URL.

FLAGS
  --dry-run           Print the request that would be sent and exit without sending it.
  --label=<value>...  (required) Label to add. Repeatable.
  --prefix=<value>    [default: global] Label namespace.

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
  Add labels to a page.

  Labels are additive and idempotent: adding one the page already has is not an error, and this reports what the page
  carries afterwards rather than implying everything was new. No --confirm, because adding a label loses nothing.

EXAMPLES
  $ simply atlassian confluence page label add 123456 --label runbook

  $ simply atlassian confluence page label add 123456 --label runbook --label on-call

  $ simply atlassian confluence page label add 123456 --label draft --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --prefix=<value>  Label namespace.

    Confluence namespaces labels; global is what the UI applies and what you almost always want.
```

_See code: [lib/commands/atlassian/confluence/page/label/add.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/label/add.js)_

## `simply atlassian confluence page label list PAGE`

List a page's labels.

```
USAGE
  $ simply atlassian confluence page label list PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--limit <value>]

ARGUMENTS
  PAGE  Page id, or a page URL.

FLAGS
  --limit=<value>  [default: 25] Maximum number of labels to show.

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
  List a page's labels.

  The PREFIX column is shown because Confluence namespaces labels — global, my, team — and the prefix is part of the
  identity, so two different labels can share a name.

EXAMPLES
  $ simply atlassian confluence page label list 123456

  $ simply atlassian confluence page label list 123456 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/confluence/page/label/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/label/list.js)_

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

_See code: [lib/commands/atlassian/confluence/page/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/search.js)_

## `simply atlassian confluence page update PAGE`

Replace a Confluence page's body or title.

```
USAGE
  $ simply atlassian confluence page update PAGE [--json] [-e <value>] [--confluence-url <value>] [--confluence-username <value>]
    [--confluence-api-token <value>] [--confluence-personal-token <value>] [--dry-run] [--title <value>] [--text
    <value>] [--body <value>] [--body-file <value>] [--markdown <value>] [--markdown-file <value>] [--append]

ARGUMENTS
  PAGE  Page id, or a page URL.

FLAGS
  --append                 Add the new body to the end of the page instead of replacing it.
  --body=<value>           Body as raw storage-format XHTML.
  --body-file=<value>      Path to a file holding storage-format XHTML.
  --dry-run                Print the request that would be sent and exit without sending it.
  --markdown=<value>       Body as Markdown; converted to storage format.
  --markdown-file=<value>  Path to a Markdown file; converted to storage format.
  --text=<value>           Body as plain text; becomes paragraphs, markup escaped.
  --title=<value>          New title. Defaults to the page's current title.

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
  Replace a Confluence page's body or title.

  The version number is handled for you: the page is read, its version incremented, and the result sent. There is no
  --version flag, because Confluence refuses a stale version with a conflict rather than overwriting — so if someone
  edits the page while this runs, the command fails and says so instead of discarding their work. Re-run it to pick up
  their change. This REPLACES the body by default; use --append to add to the end instead.

EXAMPLES
  $ simply atlassian confluence page update 123456 --text "Updated status."

  $ simply atlassian confluence page update 123456 --body-file ./page.xml

  $ simply atlassian confluence page update 123456 --title "Renamed" --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --append  Add the new body to the end of the page instead of replacing it.

    Reads the page's existing body and puts the new content after it. Without this the body is replaced, which is what a
    bare update has always done.
```

_See code: [lib/commands/atlassian/confluence/page/update.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/confluence/page/update.js)_

## `simply atlassian jira board list`

List Jira agile boards.

```
USAGE
  $ simply atlassian jira board list [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>] [--project <value>] [--type <value>] [--limit <value>]

FLAGS
  --limit=<value>    [default: 50] Maximum number of boards to return.
  --project=<value>  Filter by project key or id.
  --type=<value>     Filter by board type: scrum or kanban.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List Jira agile boards.

  Lists boards visible to the current Jira user. Use --project to restrict boards by project key or id, and --json for
  the complete paginated response.

EXAMPLES
  $ simply atlassian jira board list

  $ simply atlassian jira board list --project PROJ --type scrum

  $ simply atlassian jira board list --limit 10 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/board/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/board/list.js)_

## `simply atlassian jira fields`

List Jira fields, including custom field ids.

```
USAGE
  $ simply atlassian jira fields [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>] [--custom] [--search <value>] [--limit <value>]

FLAGS
  --custom          Only custom fields.
  --limit=<value>   [default: 50] Maximum number of fields to show.
  --search=<value>  Match against the field name or id, case-insensitively.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List Jira fields, including custom field ids.

  This is what makes --body usable on issue create and update. A custom field is addressed by an id like
  customfield_10016, which differs between instances and cannot be guessed — so without this command the escape hatch
  for untyped fields is unusable by anyone who has not read it off an admin screen. --search matches the name or the id,
  so it answers both "what is Story Points called" and "what is customfield_10016".

EXAMPLES
  $ simply atlassian jira fields --custom

  $ simply atlassian jira fields --search "story points"

  $ simply atlassian jira fields --search customfield_10016 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/fields.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/fields.js)_

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

_See code: [lib/commands/atlassian/jira/issue/comment/add.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/add.js)_

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

    There is deliberately no short form: a single letter is too easy to add by habit. It also takes no value — pass it
    bare, never --confirm=true or --confirm=false.
```

_See code: [lib/commands/atlassian/jira/issue/comment/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/delete.js)_

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

_See code: [lib/commands/atlassian/jira/issue/comment/edit.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/edit.js)_

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

_See code: [lib/commands/atlassian/jira/issue/comment/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/comment/list.js)_

## `simply atlassian jira issue create`

Create a Jira issue.

```
USAGE
  $ simply atlassian jira issue create [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>] [--dry-run] [--project <value>] [--type <value>] [--parent <value>]
    [--summary <value>] [--description <value>] [--assignee <value>] [--priority <value>] [--label <value>...] [--body
    <value> | --body-file <value>]

FLAGS
  --assignee=<value>     Assignee: account id on Cloud, username on Server/DC.
  --body=<value>         Raw JSON request body.
  --body-file=<value>    Path to a file holding the raw JSON request body.
  --description=<value>  Issue description as plain text.
  --dry-run              Print the request that would be sent and exit without sending it.
  --label=<value>...     Label to apply. Repeatable.
  --parent=<value>       Parent issue key, making this a subtask of it.
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

  $ simply atlassian jira issue create --project PROJ --type Subtask --parent PROJ-1 --summary "Write the tests"

  $ simply atlassian jira issue create --body-file ./issue.json --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --parent=<value>  Parent issue key, making this a subtask of it.

    Pair with --type Subtask for a subtask. On team-managed projects this is also how an issue is placed under an epic,
    so it is not validated against the issue type — Jira rejects the combinations that are genuinely wrong, and its
    error is more current than any rule encoded here.
```

_See code: [lib/commands/atlassian/jira/issue/create.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/create.js)_

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

    There is deliberately no short form: a single letter is too easy to add by habit. It also takes no value — pass it
    bare, never --confirm=true or --confirm=false.

  --delete-subtasks  Also delete the issue's subtasks.

    Without this, Jira refuses to delete an issue that has subtasks.
```

_See code: [lib/commands/atlassian/jira/issue/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/delete.js)_

## `simply atlassian jira issue history ISSUE`

Show an issue field-change history.

```
USAGE
  $ simply atlassian jira issue history ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--limit <value>] [--field <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --field=<value>  Only show entries that changed this field, case-insensitively.
  --limit=<value>  [default: 50] Maximum number of history entries to fetch.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show an issue field-change history.

  Lists who changed which fields, when, and the previous and new values. History is grouped by changelog entry and
  rendered oldest first. Use --json for raw changelog entries and completeness metadata.

EXAMPLES
  $ simply atlassian jira issue history PROJ-123

  $ simply atlassian jira issue history PROJ-123 --field status

  $ simply atlassian jira issue history PROJ-123 --limit 10 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/history.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/history.js)_

## `simply atlassian jira issue link create FROM TYPE TO`

Link two Jira issues.

```
USAGE
  $ simply atlassian jira issue link create FROM TYPE TO [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--comment <value>]

ARGUMENTS
  FROM  Issue the relationship is stated from, for example PROJ-1.
  TYPE  Relationship phrase or type name, for example "blocks".
  TO    Issue the relationship points at, for example PROJ-2.

FLAGS
  --comment=<value>  Comment to add to the link.
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
  Link two Jira issues.

  The relationship is given the way it would be said out loud: "A blocks B". Either direction of a type works — "A
  blocks B" and "B is blocked by A" state the same fact and produce the same link — so the phrasing can follow whatever
  the source text used. The type may also be given by name, which is read as its outward phrase. An unmatched type lists
  what the instance offers. Use "issue link types" to see them, or --dry-run to check without sending.

EXAMPLES
  $ simply atlassian jira issue link create PROJ-1 blocks PROJ-2

  $ simply atlassian jira issue link create PROJ-2 "is blocked by" PROJ-1

  $ simply atlassian jira issue link create PROJ-1 relates PROJ-3 --comment "same root cause"

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/link/create.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/link/create.js)_

## `simply atlassian jira issue link delete LINK-ID`

Delete an issue link.

```
USAGE
  $ simply atlassian jira issue link delete LINK-ID [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run]

ARGUMENTS
  LINK-ID  Link id, as shown by "issue link list".

FLAGS
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
  Delete an issue link.

  Takes the link id, which "issue link list" prints. The link is resolved first, so both the dry run and the result name
  the relationship being removed rather than only its id — a link id is instance-global and identifies nothing on its
  own. Unlike issue and comment deletion this does not require --confirm: what it prints is enough to re-create the link
  in one command, so it is not the irreversible loss of data that --confirm exists to guard.

EXAMPLES
  $ simply atlassian jira issue link delete 10201

  $ simply atlassian jira issue link delete 10201 --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/link/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/link/delete.js)_

## `simply atlassian jira issue link list ISSUE`

List an issue's links.

```
USAGE
  $ simply atlassian jira issue link list ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--limit <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --limit=<value>  [default: 25] Maximum number of links to show.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List an issue's links.

  Each relationship is phrased from the perspective of the issue asked about, so "blocks" means this issue blocks the
  one named. The ID column is what "issue link delete" needs and is not otherwise discoverable.

EXAMPLES
  $ simply atlassian jira issue link list PROJ-123

  $ simply atlassian jira issue link list PROJ-123 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/link/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/link/list.js)_

## `simply atlassian jira issue link types`

List the issue link types this instance offers.

```
USAGE
  $ simply atlassian jira issue link types [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>] [--limit <value>]

FLAGS
  --limit=<value>  [default: 25] Maximum number of link types to show.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List the issue link types this instance offers.

  Both phrases are shown because either one can be passed to "issue link create", and neither is guessable from the type
  name — Duplicate offers "duplicates" and "is duplicated by". Link types are configured per instance, so this list is
  the authority.

EXAMPLES
  $ simply atlassian jira issue link types

  $ simply atlassian jira issue link types --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/link/types.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/link/types.js)_

## `simply atlassian jira issue remotelink create ISSUE`

Link an issue to something outside Jira.

```
USAGE
  $ simply atlassian jira issue remotelink create ISSUE --url <value> [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--title <value>] [--summary <value>]
    [--relationship <value>]

ARGUMENTS
  ISSUE  Issue key, for example PROJ-123.

FLAGS
  --dry-run               Print the request that would be sent and exit without sending it.
  --relationship=<value>  How the issue relates to the target, e.g. "documented by".
  --summary=<value>       A line of description shown under the link.
  --title=<value>         Link text. Defaults to the URL.
  --url=<value>           (required) Absolute http or https URL to link to.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Link an issue to something outside Jira.

  Most usefully, the Confluence page an issue came from. Writing a hyperlink into the page body only links one way and
  Jira cannot see it; this is the direction that makes the relationship visible from the issue. Get a page URL with
  "confluence open <page> --print". Re-running with the same URL updates the existing link rather than adding a
  duplicate.

EXAMPLES
  $ simply atlassian jira issue remotelink create PROJ-123 --url https://wiki.example.com/pages/456 --title "Requirements"

  $ simply atlassian jira issue remotelink create PROJ-123 --url https://x.test/doc --relationship "documented by"

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.

  --relationship=<value>  How the issue relates to the target, e.g. "documented by".

    Jira renders this as the heading the link is grouped under on the issue.
```

_See code: [lib/commands/atlassian/jira/issue/remotelink/create.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/remotelink/create.js)_

## `simply atlassian jira issue remotelink delete ISSUE LINK-ID`

Remove a remote link from an issue.

```
USAGE
  $ simply atlassian jira issue remotelink delete ISSUE LINK-ID [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run]

ARGUMENTS
  ISSUE    Issue key, for example PROJ-123.
  LINK-ID  Remote link id, as shown by "remotelink list".

FLAGS
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
  Remove a remote link from an issue.

  Takes the link id, which "remotelink list" prints. No --confirm: the link holds no content and is re-creatable in one
  command from the URL, so it is not the irreversible loss that flag guards.

EXAMPLES
  $ simply atlassian jira issue remotelink delete PROJ-123 10001

  $ simply atlassian jira issue remotelink delete PROJ-123 10001 --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/remotelink/delete.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/remotelink/delete.js)_

## `simply atlassian jira issue remotelink list ISSUE`

List an issue's links to things outside Jira.

```
USAGE
  $ simply atlassian jira issue remotelink list ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
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
  List an issue's links to things outside Jira.

  Remote links point at anything with a URL — most usefully the Confluence page an issue came from. Distinct from "issue
  link", which only joins two Jira issues. The ID column is what "remotelink delete" needs.

EXAMPLES
  $ simply atlassian jira issue remotelink list PROJ-123

  $ simply atlassian jira issue remotelink list PROJ-123 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/issue/remotelink/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/remotelink/list.js)_

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

_See code: [lib/commands/atlassian/jira/issue/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/search.js)_

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

_See code: [lib/commands/atlassian/jira/issue/transition.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/transition.js)_

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

_See code: [lib/commands/atlassian/jira/issue/transitions.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/transitions.js)_

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

_See code: [lib/commands/atlassian/jira/issue/update.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/update.js)_

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

_See code: [lib/commands/atlassian/jira/issue/view.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/issue/view.js)_

## `simply atlassian jira open TARGET`

Open a Jira issue or project in the browser.

```
USAGE
  $ simply atlassian jira open TARGET [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--print]

ARGUMENTS
  TARGET  Jira issue key or project key.

FLAGS
  --print  Print the URL without opening a browser.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Open a Jira issue or project in the browser.

  Builds the browser URL for an issue or project and opens it in the default browser. Use --print (or --url) to print
  the URL without launching a browser.

EXAMPLES
  $ simply atlassian jira open PROJ-123

  $ simply atlassian jira open PROJ --print

  $ simply atlassian jira open PROJ-123 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/open.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/open.js)_

## `simply atlassian jira project versions PROJECT`

List a project's versions.

```
USAGE
  $ simply atlassian jira project versions PROJECT [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--limit <value>]

ARGUMENTS
  PROJECT  Project key, for example PROJ.

FLAGS
  --limit=<value>  [default: 25] Maximum number of versions to show.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List a project's versions.

  Versions are how Jira models releases. The ID column is what sets fixVersions through --body on issue create or
  update.

EXAMPLES
  $ simply atlassian jira project versions PROJ

  $ simply atlassian jira project versions PROJ --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/project/versions.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/project/versions.js)_

## `simply atlassian jira projects`

List Jira projects.

```
USAGE
  $ simply atlassian jira projects [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
    <value>] [--jira-personal-token <value>] [--limit <value>]

FLAGS
  --limit=<value>  [default: 25] Maximum number of projects to show.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List Jira projects.

  The KEY column is the point: it is what every other command takes and what a caller most often does not have. Cloud
  paginates this endpoint and Server/DC returns the whole list; both are handled.

EXAMPLES
  $ simply atlassian jira projects

  $ simply atlassian jira projects --limit 100 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/projects.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/projects.js)_

## `simply atlassian jira sprint add SPRINT ISSUE`

Add existing issues to a sprint.

```
USAGE
  $ simply atlassian jira sprint add SPRINT ISSUE... [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run]

ARGUMENTS
  SPRINT    Numeric sprint id.
  ISSUE...  Issue key to move; repeat for multiple issues.

FLAGS
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
  Add existing issues to a sprint.

  Moves one or more existing issues into a numeric sprint. Jira accepts at most 50 issue keys per request, so larger
  lists are sent in chunks. Use --dry-run to inspect the payload without sending it; adding to a sprint is reversible
  and does not require --confirm.

EXAMPLES
  $ simply atlassian jira sprint add 101 PROJ-1 PROJ-2

  $ simply atlassian jira sprint add 101 PROJ-1 --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/sprint/add.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/sprint/add.js)_

## `simply atlassian jira sprint create`

Create a sprint on a board.

```
USAGE
  $ simply atlassian jira sprint create --board <value> --name <value> [--json] [-e <value>] [--jira-url <value>] [--jira-username
    <value>] [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--goal <value>] [--start <value>]
    [--end <value>]

FLAGS
  --board=<value>  (required) Board id the sprint belongs to.
  --dry-run        Print the request that would be sent and exit without sending it.
  --end=<value>    End date, ISO-8601.
  --goal=<value>   Sprint goal.
  --name=<value>   (required) Sprint name.
  --start=<value>  Start date, ISO-8601.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Create a sprint on a board.

  The board is given by numeric id; agile commands do not resolve names, because a board name is neither unique nor
  stable — run "board list" first. Dates are ISO-8601.

EXAMPLES
  $ simply atlassian jira sprint create --board 42 --name "Sprint 7"

  $ simply atlassian jira sprint create --board 42 --name "Sprint 7" --start 2026-09-15 --end 2026-09-29

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/sprint/create.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/sprint/create.js)_

## `simply atlassian jira sprint issues SPRINT`

List issues in a sprint.

```
USAGE
  $ simply atlassian jira sprint issues SPRINT [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--fields <value>] [--limit <value>]

ARGUMENTS
  SPRINT  Numeric sprint id.

FLAGS
  --fields=<value>  Comma-separated field names to request.
  --limit=<value>   [default: 50] Maximum number of issues to return.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List issues in a sprint.

  Lists issues for a numeric sprint id using the same compact issue columns as issue search. Use --json for the complete
  paginated response.

EXAMPLES
  $ simply atlassian jira sprint issues 101

  $ simply atlassian jira sprint issues 101 --fields summary,status,assignee --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/sprint/issues.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/sprint/issues.js)_

## `simply atlassian jira sprint list BOARD`

List a board's sprints.

```
USAGE
  $ simply atlassian jira sprint list BOARD [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--state <value>] [--limit <value>]

ARGUMENTS
  BOARD  Numeric agile board id.

FLAGS
  --limit=<value>  [default: 50] Maximum number of sprints to return.
  --state=<value>  [default: active,future] Sprint states as CSV: active, future, closed.

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List a board's sprints.

  Lists sprints for a numeric agile board id. Board names are intentionally not resolved; use "jira board list" first
  when you do not have the id.

EXAMPLES
  $ simply atlassian jira sprint list 42

  $ simply atlassian jira sprint list 42 --state closed --limit 10

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/sprint/list.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/sprint/list.js)_

## `simply atlassian jira sprint update SPRINT`

Change a sprint's name, dates, goal, or state.

```
USAGE
  $ simply atlassian jira sprint update SPRINT [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
    [--jira-api-token <value>] [--jira-personal-token <value>] [--dry-run] [--name <value>] [--goal <value>] [--start
    <value>] [--end <value>] [--state future|active|closed]

ARGUMENTS
  SPRINT  Sprint id, numeric.

FLAGS
  --dry-run         Print the request that would be sent and exit without sending it.
  --end=<value>     End date, ISO-8601.
  --goal=<value>    New sprint goal.
  --name=<value>    New sprint name.
  --start=<value>   Start date, ISO-8601.
  --state=<option>  Sprint state.
                    <options: future|active|closed>

CONNECTION FLAGS
  -e, --env-file=<value>             Path to a .env file holding connection settings.
      --jira-api-token=<value>       [env: JIRA_API_TOKEN] API token for Jira Cloud basic auth.
      --jira-personal-token=<value>  [env: JIRA_PERSONAL_TOKEN] Personal access token for Jira Server/Data Center.
      --jira-url=<value>             [env: JIRA_URL] Base URL of the Jira instance.
      --jira-username=<value>        [env: JIRA_USERNAME] Account email for Jira Cloud basic auth.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Change a sprint's name, dates, goal, or state.

  Jira treats a sprint update as a full replacement and clears anything the request omits, so the sprint is read first
  and your changes applied on top — passing only --name will not blank the goal. --state closed is how a sprint ends; it
  is reversible, so it takes no --confirm, and --dry-run shows what would be sent.

EXAMPLES
  $ simply atlassian jira sprint update 101 --name "Sprint 7 (extended)"

  $ simply atlassian jira sprint update 101 --state closed

  $ simply atlassian jira sprint update 101 --goal "Ship the CLI" --end 2026-10-01 --dry-run

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/sprint/update.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/sprint/update.js)_

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

  This adds no access the credential does not already have, but it does put colleagues' names and addresses wherever the
  output goes. When an AI agent is the caller, that means into its context — worth a thought before running it broadly
  against a work instance.

EXAMPLES
  $ simply atlassian jira user search ada

  $ simply atlassian jira user search ada@example.com

  $ simply atlassian jira user search ada --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only Atlassian connection variables are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/atlassian/jira/user/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/user/search.js)_

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

_See code: [lib/commands/atlassian/jira/user/view.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/user/view.js)_

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

_See code: [lib/commands/atlassian/jira/whoami.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.9.1/packages/simply-atlassian/lib/commands/atlassian/jira/whoami.js)_
<!-- commandsstop -->

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
