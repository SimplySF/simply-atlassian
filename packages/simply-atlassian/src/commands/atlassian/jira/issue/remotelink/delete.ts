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
import { ConfigError } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../../shared/base-command.js';

export default class JiraIssueRemotelinkDelete extends JiraCommand<typeof JiraIssueRemotelinkDelete> {
  public static override isWrite = true;

  public static override readonly summary = 'Remove a remote link from an issue.';
  public static override readonly description =
    'Takes the link id, which "remotelink list" prints. No --confirm: the link holds no content ' +
    'and is re-creatable in one command from the URL, so it is not the irreversible loss that ' +
    'flag guards.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 10001',
    '<%= config.bin %> <%= command.id %> PROJ-123 10001 --dry-run',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
    'link-id': Args.string({ description: 'Remote link id, as shown by "remotelink list".', required: true }),
  };

  public static override readonly flags = { ...writeFlags };

  public async run(): Promise<unknown> {
    const linkId = this.args['link-id'];
    // Numeric, like every Jira id. Checking the shape turns an issue key passed here by mistake
    // into a usage error rather than a 404 reading as "already gone".
    if (!/^\d+$/.test(linkId)) {
      throw new ConfigError(`"${linkId}" is not a remote link id. Ids are numeric and shown by "remotelink list".`);
    }

    if (this.flags['dry-run']) {
      this.logSafe(`Dry run — not sent. Would remove remote link ${linkId} from ${this.args.issue}.`);
      return { issue: this.args.issue, linkId, deleted: false };
    }

    await this.jira().deleteRemoteLink(this.args.issue, linkId);
    this.logSafe(`Removed remote link ${linkId} from ${this.args.issue}.`);
    return { issue: this.args.issue, linkId, deleted: true };
  }
}
