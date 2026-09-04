# @simplysf/simply-atlassian

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian?label=@simplysf/simply-atlassian)](https://npmjs.com/@simplysf/simply-atlassian) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

Command-line interface for working with Atlassian products, built by [SimplySF](https://github.com/SimplySF).

This package is framework-only right now: one placeholder command (`hello world`) proving the
build/lint/test/oclif pipeline works end to end. Real Atlassian commands land next.

## Install

```bash
npm install -g @simplysf/simply-atlassian
```

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See the repo's [CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for the repo structure, how to set up and build the project, our commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## Commands

<!-- commands -->

- [`simply atlassian confluence page children PAGE`](#simply-atlassian-confluence-page-children-page)
- [`simply atlassian confluence page get PAGE`](#simply-atlassian-confluence-page-get-page)
- [`simply atlassian confluence page search`](#simply-atlassian-confluence-page-search)
- [`simply atlassian jira issue search`](#simply-atlassian-jira-issue-search)
- [`simply atlassian jira issue view ISSUE`](#simply-atlassian-jira-issue-view-issue)
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
