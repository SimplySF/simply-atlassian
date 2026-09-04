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
import { ConfigError } from '../../../../../core/errors.js';
import { confirmFlag, JiraCommand, writeFlags } from '../../../../../shared/base-command.js';

export default class JiraIssueCommentDelete extends JiraCommand<typeof JiraIssueCommentDelete> {
  public static override isWrite = true;

  public static override readonly summary = 'Delete a comment.';
  public static override readonly description =
    'A deleted comment cannot be recovered through the API, so --confirm is required — the ' +
    'same rule "issue delete" follows. Comment ids come from "issue comment list".';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 10001 --confirm',
    '<%= config.bin %> <%= command.id %> PROJ-123 10001 --dry-run',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
    comment: Args.string({ description: 'Comment id, from "issue comment list".', required: true }),
  };

  public static override readonly flags = { ...writeFlags, ...confirmFlag };

  public async run(): Promise<unknown> {
    const { issue, comment } = this.args;

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would delete comment ${comment} on ${issue}.`);
      return { issue, comment, dryRun: true };
    }

    // Both ids are named, so a caller that meant a different comment notices before retrying.
    if (!this.flags.confirm) {
      throw new ConfigError(`Deleting comment ${comment} on ${issue} cannot be undone. Pass --confirm to proceed.`);
    }

    await this.jira().deleteComment(issue, comment);
    this.log(`Deleted comment ${comment} on ${issue}.`);
    return { issue, comment, deleted: true };
  }
}
