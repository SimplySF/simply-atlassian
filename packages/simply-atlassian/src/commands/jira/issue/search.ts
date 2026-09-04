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

import { Flags } from '@oclif/core';
import { JiraCommand, parseList } from '../../../shared/base-command.js';
import { formatTable } from '../../../shared/output.js';

interface SearchedIssue {
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly status?: { readonly name?: string };
    readonly assignee?: { readonly displayName?: string };
  };
}

const DEFAULT_LIMIT = 50;

export default class JiraIssueSearch extends JiraCommand<typeof JiraIssueSearch> {
  public static override readonly summary = 'Search issues with JQL.';
  public static override readonly description =
    'Runs a JQL query and follows result pages until the limit is reached or the instance has ' +
    'no more matches. Use --json for the complete, unmodified API payload of every issue.\n\n' +
    'Jira Cloud rejects an unbounded query, so include a restriction such as a project, an ' +
    'assignee, or a date range — "order by updated desc" alone returns an error there, while ' +
    '"updated >= -7d order by updated desc" works on both deployments.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --jql "project = PROJ AND statusCategory != Done"',
    '<%= config.bin %> <%= command.id %> --jql "assignee = currentUser()" --limit 10',
    '<%= config.bin %> <%= command.id %> --jql "updated >= -7d order by updated desc" --limit 5 --json',
  ];

  public static override readonly flags = {
    jql: Flags.string({
      summary: 'JQL query to run.',
      required: true,
    }),
    limit: Flags.integer({
      summary: 'Maximum number of issues to return across all pages.',
      default: DEFAULT_LIMIT,
      min: 1,
    }),
    fields: Flags.string({
      summary: 'Comma-separated field names to request instead of the instance default.',
    }),
  };

  public async run(): Promise<unknown> {
    const result = await this.jira().searchAllIssues(
      {
        jql: this.flags.jql,
        fields: parseList(this.flags.fields),
      },
      this.flags.limit,
    );

    const issues = result.issues as SearchedIssue[];
    if (issues.length === 0) {
      this.log('No issues matched.');
      return result;
    }

    this.log(
      formatTable(issues, [
        { header: 'KEY', value: (issue): string | undefined => issue.key },
        { header: 'STATUS', value: (issue): string | undefined => issue.fields?.status?.name },
        { header: 'ASSIGNEE', value: (issue): string | undefined => issue.fields?.assignee?.displayName },
        { header: 'SUMMARY', value: (issue): string | undefined => issue.fields?.summary },
      ]),
    );

    // Say plainly whether anything was left behind, so a truncated list is never mistaken
    // for the whole answer — by a person or by an agent.
    const scope = result.total === undefined ? '' : ` of ${result.total}`;
    const note = result.complete ? '' : ` (limit ${this.flags.limit} reached; more available)`;
    this.log(`\nShowing ${issues.length}${scope} issue(s)${note}.`);

    return result;
  }
}
