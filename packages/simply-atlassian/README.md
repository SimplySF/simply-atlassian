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

- [`atlassian jira issue search`](#atlassian-jira-issue-search)
- [`atlassian jira issue view ISSUE`](#atlassian-jira-issue-view-issue)
- [`atlassian jira whoami`](#atlassian-jira-whoami)

## `atlassian jira issue search`

Search issues with JQL.

```
USAGE
  $ atlassian jira issue search --jql <value> [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
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

EXAMPLES
  $ atlassian jira issue search --jql "project = PROJ AND statusCategory != Done"

  $ atlassian jira issue search --jql "assignee = currentUser()" --limit 10

  $ atlassian jira issue search --jql "order by updated desc" --limit 5 --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export. A path that cannot be read is an error.
```

_See code: [lib/commands/jira/issue/search.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/jira/issue/search.js)_

## `atlassian jira issue view ISSUE`

Show a single Jira issue.

```
USAGE
  $ atlassian jira issue view ISSUE [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>]
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
  $ atlassian jira issue view PROJ-123

  $ atlassian jira issue view PROJ-123 --json

  $ atlassian jira issue view PROJ-123 --fields summary,status,assignee

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export. A path that cannot be read is an error.
```

_See code: [lib/commands/jira/issue/view.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/jira/issue/view.js)_

## `atlassian jira whoami`

Show the account the configured credentials belong to.

```
USAGE
  $ atlassian jira whoami [--json] [-e <value>] [--jira-url <value>] [--jira-username <value>] [--jira-api-token
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
  $ atlassian jira whoami

  $ atlassian jira whoami --env-file .env

  $ atlassian jira whoami --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export. A path that cannot be read is an error.
```

_See code: [lib/commands/jira/whoami.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/jira/whoami.js)_
<!-- commandsstop -->

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
