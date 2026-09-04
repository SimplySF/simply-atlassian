/*
 * Copyright (c) 2026, Clay Chipps.
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
import { confirmFlag, JiraCommand, writeFlags } from '../../../../shared/base-command.js';
import { ConfigError } from '../../../../core/errors.js';

export default class JiraIssueDelete extends JiraCommand<typeof JiraIssueDelete> {
  public static override isWrite = true;

  public static override readonly summary = 'Delete a Jira issue.';
  public static override readonly description =
    'Irreversible, so --confirm is required. There is no short form for it on purpose. Use ' +
    '--dry-run to see what would be deleted without deleting it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 --confirm',
    '<%= config.bin %> <%= command.id %> PROJ-123 --confirm --delete-subtasks',
    '<%= config.bin %> <%= command.id %> PROJ-123 --dry-run',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    ...confirmFlag,
    'delete-subtasks': Flags.boolean({
      summary: "Also delete the issue's subtasks.",
      description: 'Without this, Jira refuses to delete an issue that has subtasks.',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { issue } = this.args;

    // `--confirm=false` makes oclif consume "false" as this argument while setting the flag
    // true, so a shape check is what stops a confused invocation from sending a DELETE for a
    // nonsense key. It also catches an ordinary typo before anything is destroyed.
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issue)) {
      throw new ConfigError(`"${issue}" is not an issue key. Pass a key such as PROJ-123.`);
    }

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would delete ${issue}${this.flags['delete-subtasks'] ? ' and its subtasks' : ''}.`);
      return { issue, deleteSubtasks: this.flags['delete-subtasks'], dryRun: true };
    }

    // Named in the message so a caller that meant a different issue notices before retrying.
    if (!this.flags.confirm) {
      throw new ConfigError(`Deleting ${issue} cannot be undone. Pass --confirm to proceed.`);
    }

    await this.jira().deleteIssue(issue, { deleteSubtasks: this.flags['delete-subtasks'] });
    this.log(`Deleted ${issue}.`);
    return { issue, deleted: true };
  }
}
