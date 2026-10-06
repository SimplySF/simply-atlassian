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
  listXrayTests,
  type JiraSearchResult,
  type XrayTestRow,
} from '@simplysf/simply-atlassian-core';
import { XrayCommand, xrayFieldsFlag, xrayFilterFlags, xrayScopeFlags } from '../../../../../shared/base-command.js';

export default class JiraXrayTestList extends XrayCommand<typeof JiraXrayTestList> {
  public static override readonly summary = 'List the tests in a project, plan, set, or repository folder.';
  public static override readonly description =
    'Pass exactly one scope — --project, --plan, --set, or --project with --path — and optionally narrow ' +
    'it with --jql, --search, or --linked-to, which are ANDed together. A plan includes the tests that ' +
    'arrived through a Test Set. Everything is one JQL query, so filtering happens on the server.\n\n' +
    'Use "test export" for full records with steps. --json returns the raw search envelope, like ' +
    '"issue search": { issues, total, pages, complete }.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --project OM',
    '<%= config.bin %> <%= command.id %> --plan OM-7 --search password',
    '<%= config.bin %> <%= command.id %> --project OM --path "/O&M/Accounts" --recursive',
    '<%= config.bin %> <%= command.id %> --project OM --linked-to OM-40,OM-41 --fields components',
  ];

  public static override readonly flags = {
    ...xrayScopeFlags,
    ...xrayFilterFlags,
    ...xrayFieldsFlag,
    limit: Flags.integer({ summary: 'Maximum number of tests to return.', default: 25, min: 1 }),
  };

  public async run(): Promise<JiraSearchResult> {
    const result = await listXrayTests(this.xray(), {
      scope: this.xrayScope(),
      filters: this.xrayFilters(),
      fields: this.xrayFields(),
      limit: this.flags.limit,
    });
    const { search, rows, extraFields } = result;

    if (rows.length === 0) {
      this.log('No tests matched.');
      return search;
    }

    this.log(
      formatTable(rows, [
        { header: 'KEY', value: (row: XrayTestRow): string | null => row.key },
        { header: 'TYPE', value: (row: XrayTestRow): string | null => row.type },
        { header: 'STATUS', value: (row: XrayTestRow): string | null => row.status },
        ...extraFields.map((extra) => ({
          header: extra.name.toUpperCase(),
          value: (row: XrayTestRow): string => displayValue(row.fields[extra.name]),
        })),
        { header: 'SUMMARY', value: (row: XrayTestRow): string | null => row.summary },
      ]),
    );

    // Say plainly whether anything was left behind, so a truncated list is never mistaken for the
    // whole answer — by a person or by an agent.
    const scope = search.total === undefined ? '' : ` of ${search.total}`;
    const note = search.complete ? '' : ` (limit ${this.flags.limit} reached; more available)`;
    this.log(`\nShowing ${rows.length}${scope} test(s)${note}.`);
    return search;
  }
}
