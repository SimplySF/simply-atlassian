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
import { deleteIssue } from '@simplysf/simply-atlassian-core';
import { confirmFlag, JiraCommand, writeFlags } from '../../../../shared/base-command.js';

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
    // The key's shape is checked, the dry run answered, and consent examined — in that order —
    // inside the shared operation, so `--confirm=false` (which oclif turns into a true flag plus
    // a bogus argument) is refused the same way here and in the MCP server.
    const result = await deleteIssue(this.jira(), {
      issue: this.args.issue,
      deleteSubtasks: this.flags['delete-subtasks'],
      confirm: this.flags.confirm,
      dryRun: this.flags['dry-run'],
    });

    if ('dryRun' in result) {
      this.log(`Dry run — not sent. Would delete ${result.issue}${result.deleteSubtasks ? ' and its subtasks' : ''}.`);
      return result;
    }
    this.log(`Deleted ${result.issue}.`);
    return result;
  }
}
