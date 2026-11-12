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
  createXrayTest,
  parseBodyInput,
  parseFieldFlags,
  parseStepFlag,
  readXrayRecordFile,
} from '@simplysf/simply-atlassian-core';
import { readTextFile, writeFlags, XrayCommand } from '../../../../../shared/base-command.js';

export default class JiraXrayTestCreate extends XrayCommand<typeof JiraXrayTestCreate> {
  public static override isWrite = true;

  public static override readonly summary = 'Create an Xray test, with its steps or definition.';
  public static override readonly description =
    'Takes a record from "test get --json", flags, or both, with flags winning. The type is inferred from the ' +
    'steps, Gherkin or definition unless --type says. Steps go in the same request as the issue, so a test ' +
    'is created with them or not at all. --verifies links the requirement it tests.\n\n' +
    'Keys of a record this does not write, such as links and preconditions, are named in a note. A step that ' +
    'calls another test is refused. Returns the test read back. Xray credentials have no read-only scope, so ' +
    'SIMPLY_ATLASSIAN_READ_ONLY is the only guard against an unintended write.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --project OM --summary "Reset a password" --step "Open Users||List shown" --verifies OM-40',
    '<%= config.bin %> <%= command.id %> --project OM --summary "Log in" --gherkin-file ./login.feature',
    '<%= config.bin %> <%= command.id %> --project OM --file ./test.json --summary "A copy" --dry-run',
  ];

  public static override readonly flags = {
    ...writeFlags,
    project: Flags.string({ summary: 'Project key the test belongs to.' }),
    verifies: Flags.string({
      summary: 'A requirement this test verifies, which gets a link. Repeatable.',
      multiple: true,
    }),
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
    const result = await createXrayTest(this.xray(), {
      project: this.flags.project,
      verifies: this.flags.verifies,
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
      this.log('Dry run — not sent. Request body:');
      this.log(JSON.stringify(plan.request, null, 2));
      for (const key of plan.verifies) this.log(`Would link to ${key}.`);
    });
  }
}
