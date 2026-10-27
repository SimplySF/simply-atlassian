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

import { checkWorkConfig, CliError, type WorkConfigCheck } from '@simplysf/simply-atlassian-core';
import { WorkCommand } from '../../../../shared/base-command.js';

export default class JiraWorkConfigCheck extends WorkCommand<typeof JiraWorkConfigCheck> {
  public static override readonly summary = "Check the project's work item config against the instance.";
  public static override readonly description =
    'Confirms that the project, issue type and every configured field exist where the config says, that ' +
    'fixed and allowed values are real options, and that the Confluence space and parent page exist. ' +
    'Exits 1 when anything is wrong, so it can run in CI and catch a renamed component or a field taken ' +
    'off a screen before an agent tries to save.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --config ./.simply/atlassian.json --json',
  ];

  public async run(): Promise<WorkConfigCheck> {
    const check = await checkWorkConfig(this.workContext());
    for (const error of check.errors) this.logSafe(`error: ${error}`);
    for (const warning of check.warnings) this.logSafe(`warning: ${warning}`);
    if (check.ok) {
      this.logSafe(`${check.config} matches the instance.`);
      return check;
    }
    // Under --json the result is the useful output, so it is printed before failing.
    if (this.jsonEnabled()) this.logJson(check);
    throw new CliError(`${check.config} has ${check.errors.length} problem(s).`);
  }
}
