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

import { Args, Flags } from '@oclif/core';
import {
  displayValue,
  formatKeyValue,
  formatTable,
  getXrayTest,
  stepRows,
  stripControl,
  type XrayActionStep,
  type XrayLinkRecord,
  type XrayTestRecord,
} from '@simplysf/simply-atlassian-core';
import { stderrLine, XrayCommand, xrayFieldsFlag } from '../../../../../shared/base-command.js';

export default class JiraXrayTestGet extends XrayCommand<typeof JiraXrayTestGet> {
  public static override readonly summary = 'Show one Xray test: steps, definition, links, plans, sets, and path.';
  public static override readonly description =
    "Assembles a test from its Jira issue and Xray's fields: the type, the steps (or the Cucumber or " +
    'generic definition), preconditions, every issue link — which is how the requirement or bug it ' +
    'verifies shows up — the plans and sets that contain it, and its repository folder.\n\n' +
    'Step data this version does not interpret, such as a call to another test, is kept under the ' +
    'step\'s "extra" in the record, named in the step table, and noted on stderr.\n\n' +
    '--json returns the export record (the same shape "test export" writes), not a raw payload, because ' +
    'a test assembled from several sources has none. --raw returns the underlying Jira issue.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> OM-12',
    '<%= config.bin %> <%= command.id %> OM-12 --fields components,labels --json',
    '<%= config.bin %> <%= command.id %> OM-12 --raw',
  ];

  public static override readonly args = {
    test: Args.string({ description: 'Test issue key, for example OM-12.', required: true }),
  };

  public static override readonly flags = {
    ...xrayFieldsFlag,
    raw: Flags.boolean({ summary: 'Print the underlying Jira issue as JSON instead.', default: false }),
  };

  public async run(): Promise<unknown> {
    const result = await getXrayTest(this.xray(), this.args.test, { fields: this.xrayFields() });

    if (this.flags.raw) {
      this.logSafe(JSON.stringify(result.issue, null, 2));
      return result.issue;
    }
    if (this.jsonEnabled()) return result.record;

    this.render(result.record);
    for (const note of result.notes) stderrLine(note);
    return result.record;
  }

  private render(record: XrayTestRecord): void {
    this.log(
      formatKeyValue([
        ['Key', record.key],
        ['Summary', record.summary],
        ['Type', record.type],
        ['Status', record.status],
        ['Path', record.path],
        ['Plans', record.plans.length === 0 ? undefined : record.plans.join(', ')],
        ['Sets', record.sets.length === 0 ? undefined : record.sets.join(', ')],
      ]),
    );

    const steps = stepRows(record.steps);
    if (steps.length > 0) {
      const withAttachments = steps.some((step) => step.attachments.length > 0);
      this.log('\nSteps:');
      this.log(
        formatTable(steps, [
          { header: '#', value: (step: XrayActionStep): string => step.index },
          { header: 'ACTION', value: (step: XrayActionStep): string => step.action },
          { header: 'DATA', value: (step: XrayActionStep): string => step.data },
          { header: 'EXPECTED RESULT', value: (step: XrayActionStep): string => step.result },
          ...(withAttachments
            ? [{ header: 'ATTACHMENTS', value: (step: XrayActionStep): string => step.attachments.join(', ') }]
            : []),
        ]),
      );
    }

    // Multi-line by design, so newlines survive, but control sequences must not.
    if (record.definition !== null) this.log(`\nDefinition:\n${stripControl(record.definition)}`);

    if (record.preconditions.length > 0) {
      this.log('\nPreconditions:');
      this.log(
        formatTable(record.preconditions, [
          { header: 'KEY', value: (pre): string => pre.key },
          { header: 'SUMMARY', value: (pre): string | null => pre.summary },
        ]),
      );
    }

    if (record.links.length > 0) {
      this.log('\nLinks:');
      this.log(
        formatTable(record.links, [
          { header: 'RELATIONSHIP', value: (link: XrayLinkRecord): string => link.relationship },
          { header: 'ISSUE', value: (link: XrayLinkRecord): string | null => link.key },
          { header: 'TYPE', value: (link: XrayLinkRecord): string | null => link.issueType },
          { header: 'STATUS', value: (link: XrayLinkRecord): string | null => link.status },
          { header: 'SUMMARY', value: (link: XrayLinkRecord): string | null => link.summary },
        ]),
      );
    }

    const extras = Object.entries(record.fields);
    if (extras.length > 0) {
      this.log('\nFields:');
      this.log(formatKeyValue(extras.map(([name, value]) => [name, displayValue(value)])));
    }
  }
}
