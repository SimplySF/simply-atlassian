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
import { buildRemoteLinkBody, formatKeyValue } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../../shared/base-command.js';

export default class JiraIssueRemotelinkCreate extends JiraCommand<typeof JiraIssueRemotelinkCreate> {
  public static override isWrite = true;

  public static override readonly summary = 'Link an issue to something outside Jira.';
  public static override readonly description =
    'Most usefully, the Confluence page an issue came from. Writing a hyperlink into the page ' +
    'body only links one way and Jira cannot see it; this is the direction that makes the ' +
    'relationship visible from the issue. Get a page URL with "confluence open <page> --print". ' +
    'Re-running with the same URL updates the existing link rather than adding a duplicate.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 --url https://wiki.example.com/pages/456 --title "Requirements"',
    '<%= config.bin %> <%= command.id %> PROJ-123 --url https://x.test/doc --relationship "documented by"',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    url: Flags.string({ summary: 'Absolute http or https URL to link to.', required: true }),
    title: Flags.string({ summary: 'Link text. Defaults to the URL.' }),
    summary: Flags.string({ summary: 'A line of description shown under the link.' }),
    relationship: Flags.string({
      summary: 'How the issue relates to the target, e.g. "documented by".',
      description: 'Jira renders this as the heading the link is grouped under on the issue.',
    }),
  };

  public async run(): Promise<unknown> {
    const body = buildRemoteLinkBody({
      url: this.flags.url,
      title: this.flags.title,
      summary: this.flags.summary,
      relationship: this.flags.relationship,
    });

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would link ${this.args.issue} to:`);
      this.logSafe(JSON.stringify(body, null, 2));
      return body;
    }

    const created = (await this.jira().createRemoteLink(this.args.issue, body)) as { id?: number | string };
    this.log(
      formatKeyValue([
        ['Linked', this.args.issue],
        ['To', this.flags.title ?? this.flags.url],
        ['URL', this.flags.url],
        ['Link ID', created.id],
      ]),
    );
    return created;
  }
}
