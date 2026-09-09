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

import type { Column } from './output.js';

export interface JiraIssueRow {
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly status?: { readonly name?: string };
    readonly assignee?: { readonly displayName?: string };
  };
}

export const jiraIssueColumns: ReadonlyArray<Column<JiraIssueRow>> = [
  { header: 'KEY', value: (issue): string | undefined => issue.key },
  { header: 'STATUS', value: (issue): string | undefined => issue.fields?.status?.name },
  { header: 'ASSIGNEE', value: (issue): string | undefined => issue.fields?.assignee?.displayName },
  { header: 'SUMMARY', value: (issue): string | undefined => issue.fields?.summary },
];
