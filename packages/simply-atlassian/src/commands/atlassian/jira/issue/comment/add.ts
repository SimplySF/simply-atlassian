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
import { buildCommentBody, formatKeyValue, parseBodyInput } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../../shared/base-command.js';

interface Comment {
  readonly id?: string;
  readonly created?: string;
  readonly author?: { readonly displayName?: string };
}

export default class JiraIssueCommentAdd extends JiraCommand<typeof JiraIssueCommentAdd> {
  public static override isWrite = true;

  public static override readonly summary = 'Add a comment to a Jira issue.';
  public static override readonly description =
    'The comment text is passed as plain text and converted to the shape the deployment ' +
    'expects — Atlassian Document Format on Cloud, a string on Server/DC. Use --body or ' +
    '--body-file for anything the text alone cannot express, such as restricting visibility ' +
    'to a role or group. Use --dry-run to see what would be sent without sending it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 --text "Deployed to staging"',
    '<%= config.bin %> <%= command.id %> PROJ-123 --text "See the runbook" --dry-run',
    '<%= config.bin %> <%= command.id %> PROJ-123 --body-file ./comment.json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    text: Flags.string({ summary: 'Comment text.' }),
    mention: Flags.string({
      summary: 'Account id, or a name or email to resolve. Repeatable.',
      description:
        'An email address is the term most likely to be unique. A term matching more than one ' +
        'user is an error listing the candidates, rather than a guess at who was meant.',
      multiple: true,
    }),
    body: Flags.string({ summary: 'Raw JSON request body.', exclusive: ['body-file'] }),
    'body-file': Flags.string({ summary: 'Path to a file holding the raw JSON request body.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();
    const { issue } = this.args;

    const body = await buildCommentBody(client, issue, {
      body: parseBodyInput(this.flags.body, this.flags['body-file']),
      text: this.flags.text,
      mentions: this.flags.mention,
    });

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      // Sanitised, not merely stringified: a mention carries a display name the account's owner
      // chose, and JSON.stringify escapes C0 controls but leaves C1, bidi, and zero-width
      // characters intact — so a preview could show a reviewer something other than what is sent.
      this.logSafe(JSON.stringify(body, null, 2));
      return body;
    }

    const created = (await client.addComment(issue, body)) as Comment;
    this.logSafe(`Commented on ${issue}.`);
    this.log(
      formatKeyValue([
        ['Comment ID', created.id],
        ['Author', created.author?.displayName],
        ['Created', created.created],
      ]),
    );
    return created;
  }
}
