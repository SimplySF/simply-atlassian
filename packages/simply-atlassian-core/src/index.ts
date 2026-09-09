/*
 * Copyright (c) 2026, SimplySF.
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

// --- Configuration, transport, clients, errors ---
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
  MAX_ISSUES_PER_SPRINT_MOVE,
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

// --- Safety: the read-only guard and credential redaction, shared by every consumer ---
export { assertWritesAllowed, isReadOnly, READ_ONLY_ENV } from './write-safety.js';
export { collectSecrets, redactSecrets, sanitiseDeep, SECRET_ENV, secretValues } from './redaction.js';

// --- Shared input handling and rendering ---
export {
  isIssueKey,
  issueUrl,
  jiraTargetUrl,
  pageIdForInstance,
  pageIdFromInput,
  pageUrl,
  projectUrl,
} from './atlassian-url.js';
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
export { markdownToStorage } from './markdown-storage.js';
export { storageToMarkdown } from './storage-markdown.js';

// --- Operations: what each command does between parsing its input and rendering its result ---
export { addIssuesToSprint, numericId, sprintChunkSizes, type SprintAddResult } from './jira-agile.js';
export {
  buildCommentBody,
  buildCommentEditBody,
  deleteComment,
  type CommentInput,
  type DeleteCommentInput,
  type DeleteCommentResult,
} from './jira-comments.js';
export {
  changelogJson,
  compareCreated,
  filterChangelog,
  normalizeField,
  touchesField,
  type ChangelogJson,
} from './jira-history.js';
export {
  assertIssueKey,
  browseUrl,
  buildCreateIssueBody,
  buildUpdateIssueBody,
  deleteIssue,
  readBackIssue,
  type CreateIssueInput,
  type DeleteIssueInput,
  type DeleteIssueResult,
  type IssueFieldInput,
  type IssueReadBack,
  type UpdateIssueInput,
} from './jira-issues.js';
export {
  assertLinkId,
  buildIssueLinkBody,
  deleteIssueLink,
  describeIssueLink,
  issueLinkCreated,
  type DeleteIssueLinkResult,
  type IssueLinkCreated,
  type IssueLinkRequest,
} from './jira-links.js';
export {
  buildTransitionBody,
  resolveTransitionId,
  type Transition,
  type TransitionInput,
  type TransitionsResponse,
} from './jira-transitions.js';
export { assertAccount, currentAccount, userList, type JiraUser } from './jira-users.js';
export {
  BODY_FORMATS,
  buildPageCommentBody,
  buildPageCreateBody,
  deletePage,
  pageExpand,
  preparePageUpdate,
  renderPageBody,
  updatePage,
  webUrl,
  type BodyFormat,
  type ConfluencePageSummary,
  type CreatePageInput,
  type DeletePageInput,
  type DeletePageResult,
  type PageBodyInput,
  type PageUpdatePlan,
  type UpdatePageInput,
} from './confluence-pages.js';
