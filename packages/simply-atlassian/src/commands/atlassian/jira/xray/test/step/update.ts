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
import { updateXrayStep } from '@simplysf/simply-atlassian-core';
import { printStepDryRun, writeFlags, XrayCommand } from '../../../../../../shared/base-command.js';

export default class JiraXrayTestStepUpdate extends XrayCommand<typeof JiraXrayTestStepUpdate> {
  public static override isWrite = true;

  public static override readonly summary = "Edit one step's action, data, or expected result.";
  public static override readonly description =
    'Sends only the columns that change. Custom step columns and attachments are left as they are. A step ' +
    'that calls another test is refused. "jira xray test get" shows step ids. Use --dry-run to see what ' +
    'would be sent without sending it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> OM-12 311 --result "The list is shown, sorted by name"',
    '<%= config.bin %> <%= command.id %> OM-12 311 --data "" --dry-run',
  ];

  public static override readonly args = {
    test: Args.string({ description: 'Test issue key, for example OM-12.', required: true }),
    step: Args.string({ description: 'Step id, as "jira xray test get" shows it.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    action: Flags.string({ summary: 'What the tester does.' }),
    data: Flags.string({ summary: 'The data the step uses. Pass an empty value to clear it.' }),
    result: Flags.string({ summary: 'The expected result. Pass an empty value to clear it.' }),
  };

  public async run(): Promise<unknown> {
    const result = await updateXrayStep(this.xray(), {
      test: this.args.test,
      step: this.args.step,
      action: this.flags.action,
      data: this.flags.data,
      result: this.flags.result,
      dryRun: this.flags['dry-run'],
    });
    return this.reportXrayWrite(result, (plan) => printStepDryRun((message) => this.log(message), plan));
  }
}
