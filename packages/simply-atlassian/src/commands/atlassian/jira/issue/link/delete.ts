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

import { Args } from '@oclif/core';
import { assertLinkId, deleteIssueLink } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../../shared/base-command.js';

export default class JiraIssueLinkDelete extends JiraCommand<typeof JiraIssueLinkDelete> {
  public static override isWrite = true;

  public static override readonly summary = 'Delete an issue link.';
  public static override readonly description =
    'Takes the link id, which "issue link list" prints. The link is resolved first, so both the ' +
    'dry run and the result name the relationship being removed rather than only its id — a ' +
    'link id is instance-global and identifies nothing on its own. Unlike issue and comment ' +
    'deletion this does not require --confirm: what it prints is enough to re-create the link ' +
    'in one command, so it is not the irreversible loss of data that --confirm exists to guard.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 10201',
    '<%= config.bin %> <%= command.id %> 10201 --dry-run',
  ];

  public static override readonly args = {
    'link-id': Args.string({ description: 'Link id, as shown by "issue link list".', required: true }),
  };

  public static override readonly flags = { ...writeFlags };

  public async run(): Promise<unknown> {
    // Shape-checked before the connection is resolved, so an issue key passed here by mistake is
    // reported as such rather than as whatever is wrong with the credentials.
    const linkId = assertLinkId(this.args['link-id']);
    const result = await deleteIssueLink(this.jira(), linkId, { dryRun: this.flags['dry-run'] });

    if (this.flags['dry-run']) {
      this.logSafe(`Dry run — not sent. Would delete link ${linkId}: ${result.relationship}.`);
      return result;
    }
    // Named, not just numbered: after this the link is gone from both issues, so this line is
    // the only remaining record of what it was.
    this.logSafe(`Deleted link ${linkId}: ${result.relationship}.`);
    return result;
  }
}
