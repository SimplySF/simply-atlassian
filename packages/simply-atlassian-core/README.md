# @simplysf/simply-atlassian-core

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian-core?label=@simplysf/simply-atlassian-core)](https://npmjs.com/@simplysf/simply-atlassian-core) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

Configuration, authentication, HTTP clients, and shared logic for working with Atlassian products
(Jira and Confluence), built by [SimplySF](https://github.com/SimplySF).

This is the library underneath the [`@simplysf/simply-atlassian`](../simply-atlassian) CLI and the
[`@simplysf/simply-atlassian-mcp`](../simply-atlassian-mcp) MCP server. It has no runtime
dependencies — HTTP is Node's native `fetch` — and nothing in it touches a terminal or a process,
so it can be imported by a script, a server, or an editor extension that wants Jira or Confluence
access without shelling out to the CLI.

Verified against Jira and Confluence Cloud. Server/Data Center is implemented but not yet
verified against a live instance.

## Install

```bash
npm install @simplysf/simply-atlassian-core
```

Requires Node.js 22 or later.

## Usage

```ts
import { JiraClient, resolveJiraConfig } from '@simplysf/simply-atlassian-core';

// Reads JIRA_URL and either JIRA_USERNAME + JIRA_API_TOKEN (Cloud) or JIRA_PERSONAL_TOKEN
// (Server/Data Center) from the environment; explicit overrides win over it.
const jira = new JiraClient(resolveJiraConfig());

const me = await jira.getCurrentUser();
const page = await jira.searchIssues({ jql: 'project = PROJ AND status != Done', fields: ['summary', 'status'] });
```

```ts
import { ConfluenceClient, resolveConfluenceConfig, storageToMarkdown } from '@simplysf/simply-atlassian-core';

const confluence = new ConfluenceClient(resolveConfluenceConfig());
const page = (await confluence.getPage('123456', { expand: ['body.storage'] })) as {
  body?: { storage?: { value?: string } };
};
const markdown = storageToMarkdown(page.body?.storage?.value ?? '');
```

Credentials, deployment detection (Cloud versus Server/Data Center), API-version selection, and
the retry and timeout policy are all described in the CLI's
[Credentials](https://simplysf.github.io/simply-atlassian/guides/credentials/) guide; this package
is where that behaviour is implemented, and the CLI inherits it.

## API

Everything below is exported from the package root and is semver-covered. Anything not listed is
internal.

### Configuration and authentication

| Export                                                   | Description                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveJiraConfig(overrides?, env?)`                    | Resolves a Jira `AtlassianConfig` from explicit overrides and the environment (`JIRA_*` variables). Throws `ConfigError` when required values are missing. |
| `resolveConfluenceConfig(overrides?, env?)`              | Same for Confluence (`CONFLUENCE_*`); appends `/wiki` to a Cloud URL.                                                                                      |
| `buildAuthHeaders(config)`                               | The `Authorization` header for a config: Basic for Cloud, Bearer for Server/DC.                                                                            |
| `loadEnvFile(path, env?)`                                | Loads Atlassian connection variables from a `.env` file into `env` without overriding values already present.                                              |
| `parseEnvFile(contents)`                                 | Parses `.env` text into a key/value map.                                                                                                                   |
| `AtlassianConfig`, `ConfigOverrides`, `EnvLike`          | Types: a resolved config; the per-call overrides; an environment-shaped map.                                                                               |
| `Deployment`, `AtlassianAuth`, `BasicAuth`, `BearerAuth` | Types: `'cloud' \| 'server'`, and the two credential shapes.                                                                                               |

### Clients

| Export                                                                                | Description                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JiraClient`                                                                          | Issues, search (with `nextPageToken`/`startAt` pagination handled), comments, users, links, transitions, changelog, and agile boards/sprints. Owns API-version selection. |
| `ConfluenceClient`                                                                    | Pages, CQL search, and page children, with pagination.                                                                                                                    |
| `HttpTransport`                                                                       | The JSON transport both clients use: full-exchange timeout, retry on 429/5xx with `Retry-After`, typed error triage. Public for a consumer that needs another endpoint.   |
| `JiraSearchOptions`, `JiraSearchPage`, `JiraSearchResult`, `JiraAgileResult`          | Types for search and agile results.                                                                                                                                       |
| `JiraChangelogEntry`, `JiraChangelogItem`, `JiraChangelogPage`, `JiraChangelogResult` | Types for issue history.                                                                                                                                                  |
| `ConfluencePage`, `JsonCall`, `QueryValue`, `TransportTarget`                         | Types for a Confluence page and the transport's request shape.                                                                                                            |

### Errors

| Export         | Description                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------- |
| `CliError`     | Base class; carries an `exitCode` (the CLI's exit code for this failure).                     |
| `ConfigError`  | Missing, malformed, or self-contradictory configuration or input. Exit code 2.                |
| `AuthError`    | 401 or 403 from the instance; carries `status`. Exit code 3.                                  |
| `HttpError`    | Any other non-2xx; carries `status` and the response `body`. Exit code 1.                     |
| `NetworkError` | The instance never answered: timeout, DNS miss, refused connection, or untrusted certificate. |

### Shared logic

| Export                                                                                                                                          | Description                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveLinkDirection(types, from, phrase, to)`                                                                                                 | Works out which issue goes in which end of a Jira link from a phrase said the natural way round. See the source for why this is centralised. |
| `describeLinkFromIssue(link)`                                                                                                                   | Renders a link from the perspective of the issue it was read from.                                                                           |
| `resolveMentions(client, terms)`                                                                                                                | Resolves account ids, names, or emails to users, erroring on ambiguity with the candidates listed.                                           |
| `appendMentions(client, body, mentions)`                                                                                                        | Appends resolved mentions to a comment body in the deployment's format (ADF on Cloud, wiki markup on Server/DC).                             |
| `parseBodyInput(body, bodyFile)`                                                                                                                | Reads a raw JSON request body from a string or a file path; exactly one source is allowed.                                                   |
| `mergeFields(body, fields)`                                                                                                                     | Merges typed fields over a raw body's `fields`, refusing top-level keys Jira would ignore.                                                   |
| `storageToMarkdown(storage)`                                                                                                                    | Converts Confluence storage-format XHTML to Markdown for terminal reading.                                                                   |
| `issueUrl`, `projectUrl`, `pageUrl`                                                                                                             | Browse URLs for an issue, project, or page on a given instance.                                                                              |
| `pageIdFromInput(value)`                                                                                                                        | Accepts a Confluence page id or page URL and returns the id.                                                                                 |
| `pageIdForInstance(value, instanceUrl)`                                                                                                         | Same, but a URL must belong to the given instance; a URL for another site is a `ConfigError`.                                                |
| `resolveStorageBody(flags)`                                                                                                                     | Reads a Confluence storage-format body from `--body`, `--body-file`, or Markdown input, exactly one source, control-stripped.                |
| `formatKeyValue(pairs)`, `formatTable(rows, columns)`                                                                                           | The CLI's aligned `Label: value` and columnar table renderers, control-stripped.                                                             |
| `jiraIssueColumns`                                                                                                                              | The column set the CLI uses for issue lists.                                                                                                 |
| `stripControl(text)`, `stripControlOneLine(text)`                                                                                               | Remove terminal control and invisible characters from instance-supplied text; the one-line variant also collapses whitespace.                |
| `LinkType`, `LinkTypesResponse`, `ResolvedLink`, `IssueLink`, `LinkedIssue`, `ResolvedMention`, `StorageBody`, `Pair`, `Column`, `JiraIssueRow` | Types for the above.                                                                                                                         |

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See [CONTRIBUTING.md](CONTRIBUTING.md) for what's specific to this package, and the repo's [root CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for repo structure, setup, commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
