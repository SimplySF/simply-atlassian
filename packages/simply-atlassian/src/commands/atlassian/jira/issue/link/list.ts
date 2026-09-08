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
import { JiraCommand } from '../../../../../shared/base-command.js';
import { describeLinkFromIssue, type IssueLink } from '../../../../../shared/issue-links.js';
import { formatTable } from '../../../../../shared/output.js';

interface IssueWithLinks {
  readonly fields?: { readonly issuelinks?: IssueLink[] };
}

export default class JiraIssueLinkList extends JiraCommand<typeof JiraIssueLinkList> {
  public static override readonly summary = "List an issue's links.";
  public static override readonly description =
    'Each relationship is phrased from the perspective of the issue asked about, so "blocks" ' +
    'means this issue blocks the one named. The ID column is what "issue link delete" needs ' +
    'and is not otherwise discoverable.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    // Jira returns every link in one unpaginated field, and anyone with "Link issues" on a
    // project can attach thousands to an issue. Capping the render keeps a hostile or merely
    // busy issue from flooding the caller — --json still carries the whole payload.
    limit: Flags.integer({ summary: 'Maximum number of links to show.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const issue = (await this.jira().getIssue(this.args.issue, { fields: ['issuelinks'] })) as IssueWithLinks;
    const links = issue.fields?.issuelinks ?? [];

    if (links.length === 0) {
      this.logSafe(`No links on ${this.args.issue}.`);
      return issue;
    }

    const shown = links.slice(0, this.flags.limit);
    const rows = shown.map((link) => {
      const { phrase, other } = describeLinkFromIssue(link);
      return { id: link.id, phrase, other };
    });

    this.log(
      formatTable(rows, [
        { header: 'ID', value: (r): string | undefined => r.id },
        { header: 'RELATIONSHIP', value: (r): string | undefined => r.phrase },
        { header: 'ISSUE', value: (r): string | undefined => r.other?.key },
        { header: 'STATUS', value: (r): string | undefined => r.other?.fields?.status?.name },
        { header: 'SUMMARY', value: (r): string | undefined => r.other?.fields?.summary },
      ]),
    );
    const scope = shown.length === links.length ? '' : ` of ${links.length}`;
    this.log(`\nShowing ${shown.length}${scope} link(s).`);
    return issue;
  }
}
