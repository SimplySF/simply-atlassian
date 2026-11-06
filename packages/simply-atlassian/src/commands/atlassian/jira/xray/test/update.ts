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
  parseBodyInput,
  parseFieldFlags,
  parseStepFlag,
  readXrayRecordFile,
  updateXrayTest,
} from '@simplysf/simply-atlassian-core';
import {
  confirmFlag,
  printStepDryRun,
  readTextFile,
  writeFlags,
  XrayCommand,
} from '../../../../../shared/base-command.js';

export default class JiraXrayTestUpdate extends XrayCommand<typeof JiraXrayTestUpdate> {
  public static override isWrite = true;

  public static override readonly summary = 'Apply a record or flags to an Xray test, replacing its steps if given.';
  public static override readonly description =
    'Only what differs is sent, so an unchanged "test get --json" record writes nothing. Steps given in a record ' +
    "or with --step replace the test's list: matched by id when the input has ids, by position when it has " +
    'none. A step missing from the input is deleted, which needs --confirm.\n\n' +
    "Xray's API documents no way to reorder steps or to add one at a position, so a reordered list is refused; " +
    'new steps go after the existing ones. Custom step columns and attachments are left as they are. ' +
    'Use --dry-run to see the plan.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> OM-12 --file ./test.json --dry-run',
    '<%= config.bin %> <%= command.id %> OM-12 --file ./test.json --confirm',
    '<%= config.bin %> <%= command.id %> OM-12 --summary "Reset a locked password"',
  ];

  public static override readonly args = {
    test: Args.string({ description: 'Test issue key, for example OM-12.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    ...confirmFlag,
    file: Flags.string({
      summary: 'Path to one test record, as "test get --json" prints it, or one line of "test export --format jsonl".',
    }),
    summary: Flags.string({ summary: 'The summary.' }),
    type: Flags.string({ summary: 'manual, cucumber, generic, or another type the field allows.' }),
    step: Flags.string({
      summary: "A step, as 'action|data|result'. Repeatable; a literal pipe is written \\|.",
      multiple: true,
    }),
    gherkin: Flags.string({ summary: 'The Cucumber scenario.', exclusive: ['gherkin-file'] }),
    'gherkin-file': Flags.string({ summary: 'Path to a file holding the Cucumber scenario.' }),
    definition: Flags.string({ summary: 'The generic test definition.' }),
    field: Flags.string({
      summary: 'Another field, as role=value. Repeatable.',
      description: 'A role or field name, as --fields takes on "test get"; no customfield_ id is needed.',
      multiple: true,
    }),
    body: Flags.string({ summary: 'Raw JSON request body, merged underneath.', exclusive: ['body-file'] }),
    'body-file': Flags.string({ summary: 'Path to a file holding the raw JSON request body.' }),
  };

  public async run(): Promise<unknown> {
    const result = await updateXrayTest(this.xray(), {
      test: this.args.test,
      confirm: this.flags.confirm,
      record: this.flags.file === undefined ? undefined : readXrayRecordFile(this.flags.file),
      summary: this.flags.summary,
      type: this.flags.type,
      steps: this.flags.step?.map((step) => parseStepFlag(step)),
      gherkin: this.flags['gherkin-file'] === undefined ? this.flags.gherkin : readTextFile(this.flags['gherkin-file']),
      definition: this.flags.definition,
      fields: parseFieldFlags(this.flags.field),
      body: parseBodyInput(this.flags.body, this.flags['body-file']),
      dryRun: this.flags['dry-run'],
    });
    return this.reportXrayWrite(result, (plan) => {
      if (plan.request !== null) {
        this.log('Dry run — not sent. Issue update:');
        this.log(JSON.stringify(plan.request, null, 2));
      }
      printStepDryRun((message) => this.log(message), plan);
    });
  }
}
