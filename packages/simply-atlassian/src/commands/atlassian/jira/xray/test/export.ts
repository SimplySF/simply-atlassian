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
  exportXrayTests,
  renderXrayMarkdown,
  type XrayExportResult,
  type XraySearchProgress,
  type XrayTestRecord,
} from '@simplysf/simply-atlassian-core';
import {
  stderrLine,
  XrayCommand,
  xrayFieldsFlag,
  xrayFilterFlags,
  xrayScopeFlags,
} from '../../../../../shared/base-command.js';

const FORMATS = ['json', 'jsonl', 'markdown'] as const;

export default class JiraXrayTestExport extends XrayCommand<typeof JiraXrayTestExport> {
  public static override readonly summary = 'Export full test records for a project, plan, set, or folder.';
  public static override readonly description =
    'The bulk form of "test get", with the scopes and filters of "test list". Each test becomes one ' +
    'export record — key, summary, status, type, path, preconditions, steps, definition, links, plans, ' +
    'sets, and any --fields — whose shape is documented as a contract in the Xray guide.\n\n' +
    'Pages of 100 tests are fetched one after another, with progress on stderr; stdout carries only the ' +
    'export. --format jsonl writes one record per line as pages arrive, which suits large exports and ' +
    'pipelines; markdown writes one section per test. Something you cannot see — a precondition, or a ' +
    'link into a project you cannot browse — is skipped and noted on stderr, never fatal, as is step data ' +
    'this version does not interpret, which is kept under the step\'s "extra". Reaching --limit is noted ' +
    'on stderr and still exits 0.\n\n' +
    '--json returns { records, total, complete, notes } instead, so a script can detect truncation. It ' +
    'replaces --format and the progress lines.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --plan OM-7 > plan.json',
    '<%= config.bin %> <%= command.id %> --project OM --path "/O&M/Accounts" --recursive --format jsonl',
    '<%= config.bin %> <%= command.id %> --project OM --linked-to OM-40,OM-41 --fields components,labels',
    '<%= config.bin %> <%= command.id %> --set OM-31 --format markdown > tests.md',
  ];

  public static override readonly flags = {
    ...xrayScopeFlags,
    ...xrayFilterFlags,
    ...xrayFieldsFlag,
    format: Flags.option({
      summary: 'Output format, written to stdout. Ignored with --json.',
      options: FORMATS,
      default: 'json' as const,
    })(),
    limit: Flags.integer({ summary: 'Maximum number of tests to export.', default: 1000, min: 1 }),
  };

  public async run(): Promise<XrayExportResult> {
    const json = this.jsonEnabled();
    const { format, limit } = this.flags;

    // A JSON array needs every record before it prints; jsonl and markdown hold only one page.
    const array: XrayTestRecord[] = [];
    const result = await exportXrayTests(this.xray(), {
      scope: this.xrayScope(),
      filters: this.xrayFilters(),
      fields: this.xrayFields(),
      limit,
      // Under --json core collects the records for the envelope; otherwise they stream from here.
      onRecords: json
        ? undefined
        : (records, progress): void => {
            stderrLine(progressLine(progress));
            if (format === 'json') array.push(...records);
            if (format === 'jsonl') for (const record of records) this.logSafe(JSON.stringify(record));
            if (format === 'markdown') this.writeMarkdown(records);
          },
    });

    if (json) return result;
    if (format === 'json') this.logSafe(JSON.stringify(array, null, 2));
    for (const note of result.notes) stderrLine(note);
    if (!result.complete) {
      stderrLine(`Stopped at --limit ${limit}; more tests match. Raise --limit to export the rest.`);
    }
    return result;
  }

  private writeMarkdown(records: readonly XrayTestRecord[]): void {
    for (const record of records) this.logSafe(renderXrayMarkdown(record));
  }
}

function progressLine(progress: XraySearchProgress): string {
  return progress.total === undefined
    ? `fetched ${progress.fetched}`
    : `fetched ${progress.fetched} of ${progress.total}`;
}
