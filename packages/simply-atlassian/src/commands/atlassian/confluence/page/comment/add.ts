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
import { ConfluenceCommand, writeFlags } from '../../../../../shared/base-command.js';
import { resolveStorageBody } from '../../../../../shared/confluence-body.js';
import { ConfigError } from '../../../../../core/errors.js';
import { formatKeyValue } from '../../../../../shared/output.js';
import { pageIdForInstance } from '../../../../../shared/atlassian-url.js';

interface CreatedComment {
  readonly id?: string;
  readonly type?: string;
}

export default class ConfluencePageCommentAdd extends ConfluenceCommand<typeof ConfluencePageCommentAdd> {
  public static override isWrite = true;

  public static override readonly summary = 'Add a comment to a Confluence page.';
  public static override readonly description =
    'A Confluence comment is content in its own right rather than a field on the page, so it ' +
    'takes the same body flags as a page: --text for plain prose, or --body/--body-file for ' +
    'storage-format XHTML. Markdown is not supported yet.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456 --text "Reviewed, looks right."',
    '<%= config.bin %> <%= command.id %> 123456 --body "<p>See <strong>section 2</strong>.</p>"',
    '<%= config.bin %> <%= command.id %> 123456 --text "wip" --dry-run',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    text: Flags.string({ summary: 'Comment as plain text; becomes paragraphs, markup escaped.' }),
    body: Flags.string({ summary: 'Comment as raw storage-format XHTML.' }),
    'body-file': Flags.string({ summary: 'Path to a file holding storage-format XHTML.' }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);
    const body = resolveStorageBody(this.flags);
    if (body === undefined) {
      throw new ConfigError('Nothing to post. Pass --text, --body, or --body-file.');
    }

    const payload: Record<string, unknown> = {
      type: 'comment',
      // The container is what makes this a comment *on* the page rather than loose content.
      container: { id: pageId, type: 'page' },
      body,
    };

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would comment on page ${pageId}:`);
      this.logSafe(JSON.stringify(payload, null, 2));
      return payload;
    }

    const created = (await this.confluence().createContent(payload)) as CreatedComment;
    this.log(
      formatKeyValue([
        ['Commented on', pageId],
        ['Comment ID', created.id],
      ]),
    );
    return created;
  }
}
