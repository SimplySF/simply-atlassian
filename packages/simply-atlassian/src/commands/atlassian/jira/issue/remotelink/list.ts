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
import { describeRemoteLink, formatTable, type RemoteLink } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../../../shared/base-command.js';

export default class JiraIssueRemotelinkList extends JiraCommand<typeof JiraIssueRemotelinkList> {
  public static override readonly summary = "List an issue's links to things outside Jira.";
  public static override readonly description =
    'Remote links point at anything with a URL — most usefully the Confluence page an issue came ' +
    'from. Distinct from "issue link", which only joins two Jira issues. The ID column is what ' +
    '"remotelink delete" needs.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public async run(): Promise<unknown> {
    const links = (await this.jira().getRemoteLinks(this.args.issue)) as RemoteLink[];
    if (!Array.isArray(links) || links.length === 0) {
      this.logSafe(`No remote links on ${this.args.issue}.`);
      return links ?? [];
    }

    const rows = links.map((link) => describeRemoteLink(link));
    this.log(
      formatTable(rows, [
        { header: 'ID', value: (r): string | undefined => r.id },
        { header: 'RELATIONSHIP', value: (r): string => r.relationship },
        { header: 'TITLE', value: (r): string | undefined => r.title },
        { header: 'URL', value: (r): string | undefined => r.url },
      ]),
    );
    this.logSafe(`\n${links.length} remote link(s).`);
    return links;
  }
}
