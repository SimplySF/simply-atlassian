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
import { ConfluenceCommand } from '../../../../../shared/base-command.js';
import { formatTable } from '../../../../../shared/output.js';
import { pageIdForInstance } from '../../../../../shared/atlassian-url.js';
import { storageToMarkdown } from '../../../../../shared/storage-markdown.js';

interface Comment {
  readonly id?: string;
  readonly title?: string;
  readonly body?: { readonly storage?: { readonly value?: string } };
  readonly version?: {
    readonly number?: number;
    readonly when?: string;
    readonly by?: { readonly displayName?: string };
  };
  readonly history?: {
    readonly createdDate?: string;
    readonly createdBy?: { readonly displayName?: string };
  };
}

interface CommentsResponse {
  readonly results?: Comment[];
  readonly size?: number;
}

/**
 * Flattens a comment's storage body to one line of readable text.
 *
 * Reuses the storage→Markdown renderer rather than stripping tags, so a comment whose body is a
 * list or a code block reads as something rather than as its own punctuation. `cell()` collapses
 * the whitespace, so the multi-line Markdown is fine to hand over as-is.
 */
function preview(comment: Comment): string | undefined {
  const storage = comment.body?.storage?.value;
  if (storage === undefined || storage === '') return undefined;
  return storageToMarkdown(storage);
}

export default class ConfluencePageCommentList extends ConfluenceCommand<typeof ConfluencePageCommentList> {
  public static override readonly summary = "List a Confluence page's comments.";
  public static override readonly description =
    'One line per comment. Bodies are stored as XHTML, so the preview column is flattened text; ' +
    'use --json for the unmodified payload. The ID column is what any later reply or removal ' +
    'needs and is not otherwise discoverable.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> 123456 --limit 5 --json',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    limit: Flags.integer({ summary: 'Maximum number of comments to return.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);
    const response = (await this.confluence().getComments(pageId, {
      limit: this.flags.limit,
    })) as CommentsResponse;

    const comments = response.results ?? [];
    if (comments.length === 0) {
      this.logSafe(`No comments on page ${pageId}.`);
      return response;
    }

    this.log(
      formatTable(comments, [
        { header: 'ID', value: (c): string | undefined => c.id },
        {
          header: 'AUTHOR',
          // A comment's author is in `history.createdBy`; `version.by` is whoever last edited it.
          value: (c): string | undefined => c.history?.createdBy?.displayName ?? c.version?.by?.displayName,
        },
        {
          header: 'CREATED',
          value: (c): string | undefined => (c.history?.createdDate ?? c.version?.when)?.slice(0, 10),
        },
        { header: 'COMMENT', value: (c): string | undefined => preview(c) },
      ]),
    );

    // Typed as a number but arriving from the instance, so it is checked rather than trusted:
    // a string here would be interpolated straight into stdout, escaping the sanitising every
    // other field on this path gets. The client guards the same field one file away.
    const total = typeof response.size === 'number' ? response.size : undefined;
    const scope = total === undefined || total === comments.length ? '' : ` of ${total}`;
    this.logSafe(`\nShowing ${comments.length}${scope} comment(s).`);
    return response;
  }
}
