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
import { ConfigError } from '../../../../../core/errors.js';
import { JiraCommand, writeFlags } from '../../../../../shared/base-command.js';
import { parseBodyInput } from '../../../../../shared/json-input.js';
import { appendMentions, resolveMentions } from '../../../../../shared/mentions.js';
import { formatKeyValue } from '../../../../../shared/output.js';

interface Comment {
  readonly id?: string;
  readonly updated?: string;
  readonly author?: { readonly displayName?: string };
}

export default class JiraIssueCommentEdit extends JiraCommand<typeof JiraIssueCommentEdit> {
  public static override isWrite = true;

  public static override readonly summary = 'Change an existing comment.';
  public static override readonly description =
    'Replaces the comment body — it does not append to it, since an edit that silently added ' +
    "text would be a surprising way to lose a comment's meaning. Comment ids come from " +
    '"issue comment list"; they are not visible in the Jira UI.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 10001 --text "Corrected: staging, not production"',
    '<%= config.bin %> <%= command.id %> PROJ-123 10001 --text "please review" --mention ada@example.com',
    '<%= config.bin %> <%= command.id %> PROJ-123 10001 --text "x" --dry-run',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
    comment: Args.string({ description: 'Comment id, from "issue comment list".', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    text: Flags.string({ summary: 'Replacement comment text.' }),
    mention: Flags.string({
      summary: 'Account id, or a name or email to resolve. Repeatable.',
      description: 'A term matching more than one user is an error listing the candidates, rather than a guess.',
      multiple: true,
    }),
    body: Flags.string({ summary: 'Raw JSON request body.', exclusive: ['body-file'] }),
    'body-file': Flags.string({ summary: 'Path to a file holding the raw JSON request body.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();
    const { issue, comment } = this.args;

    let body = parseBodyInput(this.flags.body, this.flags['body-file']) ?? {};
    if (this.flags.text !== undefined) body.body = client.descriptionValue(this.flags.text);

    // An edit replaces the body, so mentions alone would post a bare mention over whatever the
    // comment said. Refusing is the only safe reading: nobody asks to edit a comment down to
    // nothing but a name.
    if (body.body === undefined) {
      throw new ConfigError(
        this.flags.mention === undefined
          ? `Nothing to change on comment ${comment}. Pass --text, or a body.`
          : 'An edit replaces the comment, so --mention alone would erase its text. Pass --text as well.',
      );
    }

    if (this.flags.mention !== undefined) {
      body = appendMentions(client, body, await resolveMentions(client, this.flags.mention));
    }

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      // Sanitised, not merely stringified: a mention carries a display name the account's owner
      // chose, and JSON.stringify escapes C0 controls but leaves C1, bidi, and zero-width
      // characters intact — so a preview could show a reviewer something other than what is sent.
      this.logSafe(JSON.stringify(body, null, 2));
      return body;
    }

    const updated = (await client.updateComment(issue, comment, body)) as Comment;
    this.logSafe(`Updated comment ${comment} on ${issue}.`);
    this.log(
      formatKeyValue([
        ['Author', updated.author?.displayName],
        ['Updated', updated.updated],
      ]),
    );
    return updated;
  }
}
