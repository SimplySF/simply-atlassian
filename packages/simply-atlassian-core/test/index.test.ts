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

import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

/**
 * Pins down this package's public API surface. Types are erased at runtime and so can't be
 * checked here — TypeScript's own compilation of the barrel is what catches a type export being
 * removed or renamed. This test guards the *value* exports (functions, classes, constants) that
 * survive to runtime.
 *
 * Updating this list is expected when the API deliberately grows. A test failure from a removed
 * or renamed key is the signal to treat the change as breaking (see `src/index.ts`'s header).
 */
describe('@simplysf/simply-atlassian-core', () => {
  it('exports the expected set of runtime values', () => {
    expect(Object.keys(api).sort()).toStrictEqual(
      [
        // configuration, transport, clients, errors
        'AuthError',
        'CliError',
        'ConfigError',
        'ConfluenceClient',
        'HttpError',
        'HttpTransport',
        'JiraClient',
        'MAX_ISSUES_PER_SPRINT_MOVE',
        'NetworkError',
        'buildAuthHeaders',
        'loadEnvFile',
        'parseEnvFile',
        'resolveConfluenceConfig',
        'resolveJiraConfig',
        'stripControl',
        'stripControlOneLine',
        // safety
        'READ_ONLY_ENV',
        'SECRET_ENV',
        'assertWritesAllowed',
        'collectSecrets',
        'isReadOnly',
        'redactSecrets',
        'sanitiseDeep',
        'secretValues',
        // shared input handling and rendering
        'appendMentions',
        'describeLinkFromIssue',
        'formatKeyValue',
        'formatTable',
        'isIssueKey',
        'issueUrl',
        'jiraIssueColumns',
        'jiraTargetUrl',
        'mergeFields',
        'pageIdForInstance',
        'pageIdFromInput',
        'pageUrl',
        'parseBodyInput',
        'projectUrl',
        'resolveLinkDirection',
        'resolveMentions',
        'resolveStorageBody',
        'storageToMarkdown',
        // operations
        'BODY_FORMATS',
        'addIssuesToSprint',
        'assertAccount',
        'assertIssueKey',
        'assertLinkId',
        'browseUrl',
        'buildCommentBody',
        'buildCommentEditBody',
        'buildCreateIssueBody',
        'buildIssueLinkBody',
        'buildPageCommentBody',
        'buildPageCreateBody',
        'buildTransitionBody',
        'buildUpdateIssueBody',
        'changelogJson',
        'compareCreated',
        'currentAccount',
        'deleteComment',
        'deleteIssue',
        'deleteIssueLink',
        'deletePage',
        'describeIssueLink',
        'filterChangelog',
        'issueLinkCreated',
        'normalizeField',
        'numericId',
        'pageExpand',
        'preparePageUpdate',
        'readBackIssue',
        'renderPageBody',
        'resolveTransitionId',
        'sprintChunkSizes',
        'touchesField',
        'updatePage',
        'userList',
        'webUrl',
      ].sort(),
    );
  });
});
