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

import {
  displayValue,
  formatKeyValue,
  formatTable,
  stepRows,
  stripControl,
  type XrayActionStep,
  type XrayLinkRecord,
  type XrayTestRecord,
} from '@simplysf/simply-atlassian-core';

/** The terminal view of one test, shared by `test get` and every write that returns the test. */
export function printXrayTest(log: (message: string) => void, record: XrayTestRecord): void {
  log(
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
    log('\nSteps:');
    log(
      formatTable(steps, [
        { header: '#', value: (step: XrayActionStep): string => step.index },
        { header: 'ID', value: (step: XrayActionStep): string | null => step.id },
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
  if (record.definition !== null) log(`\nDefinition:\n${stripControl(record.definition)}`);

  if (record.preconditions.length > 0) {
    log('\nPreconditions:');
    log(
      formatTable(record.preconditions, [
        { header: 'KEY', value: (pre): string => pre.key },
        { header: 'SUMMARY', value: (pre): string | null => pre.summary },
      ]),
    );
  }

  if (record.links.length > 0) {
    log('\nLinks:');
    log(
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
    log('\nFields:');
    log(formatKeyValue(extras.map(([name, value]) => [name, displayValue(value)])));
  }
}
