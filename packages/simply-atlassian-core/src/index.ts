/*
 * Copyright (c) 2026, Clay Chipps.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Everything exported from this file is this package's public API and is semver-covered: adding
// an export is a minor/patch change, but removing or renaming one is breaking.
// `test/index.test.ts` pins the exported-key list so an accidental removal fails a test instead
// of silently shipping in a patch release. See docs/design/0012-simply-atlassian-core.md for why
// this package is split out from `@simplysf/simply-atlassian` (the CLI).
//
// Nothing here touches a terminal or a process: no oclif, no child processes, no `process.argv`,
// nothing written to stdout or stderr. `process.env` is read only through an injectable `env`
// parameter that defaults to it. The repo's lint config enforces the import side of that rule.

export { buildAuthHeaders } from './auth.js';
export {
  resolveConfluenceConfig,
  resolveJiraConfig,
  type AtlassianAuth,
  type AtlassianConfig,
  type BasicAuth,
  type BearerAuth,
  type ConfigOverrides,
  type Deployment,
  type EnvLike,
} from './config.js';
export { ConfluenceClient, type ConfluencePage } from './confluence-client.js';
export { loadEnvFile, parseEnvFile } from './env-file.js';
export { AuthError, CliError, ConfigError, HttpError, NetworkError } from './errors.js';
export { HttpTransport, type JsonCall, type QueryValue, type TransportTarget } from './http.js';
export {
  JiraClient,
  type JiraAgileResult,
  type JiraChangelogEntry,
  type JiraChangelogItem,
  type JiraChangelogPage,
  type JiraChangelogResult,
  type JiraSearchOptions,
  type JiraSearchPage,
  type JiraSearchResult,
} from './jira-client.js';
export { stripControl, stripControlOneLine } from './text.js';

export { issueUrl, pageIdForInstance, pageIdFromInput, pageUrl, projectUrl } from './atlassian-url.js';
export { resolveStorageBody, type StorageBody } from './confluence-body.js';
export {
  describeLinkFromIssue,
  resolveLinkDirection,
  type IssueLink,
  type LinkType,
  type LinkTypesResponse,
  type LinkedIssue,
  type ResolvedLink,
} from './issue-links.js';
export { jiraIssueColumns, type JiraIssueRow } from './issue-table.js';
export { mergeFields, parseBodyInput } from './json-input.js';
export { appendMentions, resolveMentions, type ResolvedMention } from './mentions.js';
export { formatKeyValue, formatTable, type Column, type Pair } from './output.js';
export { storageToMarkdown } from './storage-markdown.js';
