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
import { formatTable } from '../../../../../shared/output.js';

interface Comment {
  readonly id?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly author?: { readonly displayName?: string };
  readonly body?: unknown;
}

interface CommentsResponse {
  readonly comments?: Comment[];
  readonly total?: number;
}

/**
 * A comment body is a string on Server/DC and an Atlassian Document Format tree on Cloud, so
 * the table shows a flattened one-line preview. `--json` carries the original either way.
 *
 * A mention is the case worth naming: it carries no `text` of its own, only `attrs.text`, so
 * without handling it explicitly a comment reading "please review @Ada" previewed as "please
 * review" — hiding the very thing a reader most wants to know, which is who was notified. A
 * mention-only comment previewed as empty altogether.
 */
function preview(body: unknown, depth = 0): string | undefined {
  if (typeof body === 'string') return body;
  // The tree comes from the instance, so it is bounded rather than trusted to be shallow.
  if (body === null || typeof body !== 'object' || depth > 24) return undefined;

  const node = body as { type?: unknown; text?: unknown; content?: unknown; attrs?: { text?: unknown } };
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'mention') {
    const label = node.attrs?.text;
    return typeof label === 'string' ? label : '@unknown';
  }
  if (!Array.isArray(node.content)) return undefined;

  const parts = node.content
    .map((child) => preview(child, depth + 1))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

export default class JiraIssueCommentList extends JiraCommand<typeof JiraIssueCommentList> {
  public static override readonly summary = "List an issue's comments.";
  public static override readonly description =
    'Shows one line per comment. Bodies are Atlassian Document Format on Cloud, so the ' +
    'preview column is flattened text; use --json for the unmodified payload.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --limit 5 --json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    limit: Flags.integer({ summary: 'Maximum number of comments to return.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const response = (await this.jira().getComments(this.args.issue, {
      maxResults: this.flags.limit,
    })) as CommentsResponse;

    const comments = response.comments ?? [];
    if (comments.length === 0) {
      this.log(`No comments on ${this.args.issue}.`);
      return response;
    }

    this.log(
      formatTable(comments, [
        { header: 'ID', value: (c): string | undefined => c.id },
        { header: 'AUTHOR', value: (c): string | undefined => c.author?.displayName },
        { header: 'CREATED', value: (c): string | undefined => c.created?.slice(0, 10) },
        { header: 'COMMENT', value: (c): string | undefined => preview(c.body) },
      ]),
    );

    const total = response.total;
    const scope = total === undefined || total === comments.length ? '' : ` of ${total}`;
    this.log(`\nShowing ${comments.length}${scope} comment(s).`);
    return response;
  }
}
