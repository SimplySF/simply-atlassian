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

import { Flags } from '@oclif/core';
import {
  displayValue,
  formatTable,
  type XrayContainerListResult,
  type XrayContainerRow,
} from '@simplysf/simply-atlassian-core';
import { xrayFieldsFlag } from './base-command.js';

/** `plan list` and `set list` take the same flags; declared once so they cannot drift. */
export const xrayContainerFlags = {
  project: Flags.string({ summary: 'Project key.', required: true }),
  jql: Flags.string({ summary: 'Extra JQL ANDed onto the project, in parentheses so it cannot widen it.' }),
  search: Flags.string({ summary: 'Keyword in the summary or description.' }),
  ...xrayFieldsFlag,
  limit: Flags.integer({ summary: 'Maximum number to return.', default: 25, min: 1 }),
};

/** The table both commands print, and the footer that says whether the list is complete. */
export function containerLines(result: XrayContainerListResult, noun: string, limit: number): string[] {
  const { rows, extraFields, search } = result;
  if (rows.length === 0) return [`No ${noun}s matched.`];
  const table = formatTable(rows, [
    { header: 'KEY', value: (row: XrayContainerRow): string | null => row.key },
    { header: 'STATUS', value: (row: XrayContainerRow): string | null => row.status },
    { header: 'TESTS', value: (row: XrayContainerRow): number | null => row.testCount },
    ...extraFields.map((extra) => ({
      header: extra.name.toUpperCase(),
      value: (row: XrayContainerRow): string => displayValue(row.fields[extra.name]),
    })),
    { header: 'SUMMARY', value: (row: XrayContainerRow): string | null => row.summary },
  ]);
  const scope = search.total === undefined ? '' : ` of ${search.total}`;
  const note = search.complete ? '' : ` (limit ${limit} reached; more available)`;
  return [table, `\nShowing ${rows.length}${scope} ${noun}(s)${note}.`];
}
