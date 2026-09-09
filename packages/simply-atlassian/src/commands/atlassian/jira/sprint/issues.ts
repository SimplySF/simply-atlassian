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
import { JiraCommand, parseList } from '../../../../shared/base-command.js';
import { jiraIssueColumns, type JiraIssueRow } from '../../../../shared/issue-table.js';
import { formatTable } from '../../../../shared/output.js';
import { numericId } from './list.js';

export default class JiraSprintIssues extends JiraCommand<typeof JiraSprintIssues> {
  public static override readonly summary = 'List issues in a sprint.';
  public static override readonly description =
    'Lists issues for a numeric sprint id using the same compact issue columns as issue search. ' +
    'Use --json for the complete paginated response.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 101',
    '<%= config.bin %> <%= command.id %> 101 --fields summary,status,assignee --json',
  ];

  public static override readonly args = {
    sprint: Args.string({ description: 'Numeric sprint id.', required: true }),
  };

  public static override readonly flags = {
    fields: Flags.string({ summary: 'Comma-separated field names to request.' }),
    limit: Flags.integer({ summary: 'Maximum number of issues to return.', default: 50, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const sprint = numericId('Sprint', this.args.sprint);
    const result = await this.jira().getSprintIssues(sprint, {
      fields: parseList(this.flags.fields),
      maxResults: this.flags.limit,
      limit: this.flags.limit,
    });
    const issues = result.values as JiraIssueRow[];

    if (issues.length === 0) {
      this.log(`No issues in sprint ${sprint}.`);
      return result;
    }

    this.log(formatTable(issues, jiraIssueColumns));
    this.log(`\nShowing ${issues.length} issue(s).`);
    return result;
  }
}
