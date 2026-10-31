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
import { addXrayStep } from '@simplysf/simply-atlassian-core';
import { printStepDryRun, writeFlags, XrayCommand } from '../../../../../../shared/base-command.js';

export default class JiraXrayTestStepAdd extends XrayCommand<typeof JiraXrayTestStepAdd> {
  public static override isWrite = true;

  public static override readonly summary = 'Add a step to the end of a manual Xray test.';
  public static override readonly description =
    "A new step always goes last: Xray's API documents no way to place one elsewhere. Returns the test " +
    'read back, showing the new step and its id. Use --dry-run to see what would be sent without sending it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> OM-12 --action "Open Users" --result "The list is shown"',
    '<%= config.bin %> <%= command.id %> OM-12 --action "Pick a user" --data bob --dry-run',
  ];

  public static override readonly args = {
    test: Args.string({ description: 'Test issue key, for example OM-12.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    action: Flags.string({ summary: 'What the tester does.', required: true }),
    data: Flags.string({ summary: 'The data the step uses.' }),
    result: Flags.string({ summary: 'The expected result.' }),
  };

  public async run(): Promise<unknown> {
    const result = await addXrayStep(this.xray(), {
      test: this.args.test,
      action: this.flags.action,
      data: this.flags.data,
      result: this.flags.result,
      dryRun: this.flags['dry-run'],
    });
    return this.reportXrayWrite(result, (plan) => printStepDryRun((message) => this.log(message), plan));
  }
}
