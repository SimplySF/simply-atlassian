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
  formatTable,
  xrayFieldRows,
  xrayIssueTypeRows,
  type XrayFieldRow,
  type XrayInstanceRecord,
  type XrayIssueTypeRow,
} from '@simplysf/simply-atlassian-core';
import { XrayCommand } from '../../../../shared/base-command.js';

export default class JiraXrayFields extends XrayCommand<typeof JiraXrayFields> {
  public static override readonly summary = "Show which Jira fields hold Xray's data on this instance.";
  public static override readonly description =
    "Xray's field ids are assigned when the app is installed, so they differ between instances. The first " +
    'Xray command against an instance discovers them — by schema type, never by display name — along ' +
    'with the Xray issue types, and saves the result as an instance record that later commands read ' +
    'instead of asking again. This command shows that record: the role each field plays, its id, name ' +
    'and schema type, the Xray fields no role claims, and where the record lives.\n\n' +
    'If two fields claim one role (an app reinstall can leave orphans), commands that need it refuse to ' +
    'guess; pin the right id under "overrides" in the record, which survives --refresh.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --refresh',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public static override readonly flags = {
    refresh: Flags.boolean({ summary: 'Rediscover and rewrite the instance record first.', default: false }),
  };

  public async run(): Promise<XrayInstanceRecord> {
    const instance = await this.xray().instance({ refresh: this.flags.refresh });
    const { record } = instance;

    this.log(
      formatTable(xrayFieldRows(instance), [
        { header: 'ROLE', value: (row: XrayFieldRow): string => row.role ?? '(unmapped)' },
        { header: 'FIELD ID', value: (row: XrayFieldRow): string | null => row.id },
        { header: 'NAME', value: (row: XrayFieldRow): string | null => row.name },
        { header: 'SCHEMA TYPE', value: (row: XrayFieldRow): string | null => row.schemaType },
        { header: 'NOTE', value: (row: XrayFieldRow): string | null => row.note },
      ]),
    );
    this.log('');
    this.log(
      formatTable(xrayIssueTypeRows(instance), [
        { header: 'ISSUE TYPE ROLE', value: (row: XrayIssueTypeRow): string => row.role },
        { header: 'NAME', value: (row: XrayIssueTypeRow): string | null => row.name },
        { header: 'NOTE', value: (row: XrayIssueTypeRow): string | null => row.note },
      ]),
    );
    this.logSafe(`\nXray version: ${record.xrayVersion ?? 'unknown'} · discovered ${record.discoveredAt}`);
    this.logSafe(`Instance record: ${instance.path}`);
    return record;
  }
}
