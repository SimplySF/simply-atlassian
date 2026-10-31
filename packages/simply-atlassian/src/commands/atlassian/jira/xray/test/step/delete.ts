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

import { Args } from '@oclif/core';
import { deleteXrayStep } from '@simplysf/simply-atlassian-core';
import { confirmFlag, printStepDryRun, writeFlags, XrayCommand } from '../../../../../../shared/base-command.js';

export default class JiraXrayTestStepDelete extends XrayCommand<typeof JiraXrayTestStepDelete> {
  public static override isWrite = true;

  public static override readonly summary = 'Delete one step of an Xray test.';
  public static override readonly description =
    'Irreversible, and it takes the step\'s attachments with it, so --confirm is required. "jira xray test ' +
    'get" shows step ids. Use --dry-run to see what would be deleted without deleting it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> OM-12 311 --confirm',
    '<%= config.bin %> <%= command.id %> OM-12 311 --dry-run',
  ];

  public static override readonly args = {
    test: Args.string({ description: 'Test issue key, for example OM-12.', required: true }),
    step: Args.string({ description: 'Step id, as "jira xray test get" shows it.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    ...confirmFlag,
  };

  public async run(): Promise<unknown> {
    const result = await deleteXrayStep(this.xray(), {
      test: this.args.test,
      step: this.args.step,
      confirm: this.flags.confirm,
      dryRun: this.flags['dry-run'],
    });
    return this.reportXrayWrite(result, (plan) => printStepDryRun((message) => this.log(message), plan));
  }
}
