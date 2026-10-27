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

import { ConfigError } from './errors.js';
import type { JiraClient } from './jira-client.js';
import { appendMentions, resolveMentions } from './mentions.js';

export interface CommentInput {
  /** Plain text; converted to the shape the deployment expects (ADF on Cloud). */
  readonly text?: string;
  /** Markdown, converted to ADF on Cloud and wiki markup on Server/DC. Exclusive with `text`. */
  readonly markdown?: string;
  /** Account ids, or names or emails to resolve, to @-mention. */
  readonly mentions?: readonly string[];
  /** A raw request body, for anything the text cannot express such as visibility restrictions. */
  readonly body?: Record<string, unknown>;
}

export interface DeleteCommentInput {
  readonly issue: string;
  readonly comment: string;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
}

export type DeleteCommentResult =
  | { readonly issue: string; readonly comment: string; readonly dryRun: true }
  | { readonly issue: string; readonly comment: string; readonly deleted: true };

/** The comment text in the deployment's shape, from plain text or Markdown but never both. */
function commentText(client: JiraClient, input: CommentInput): unknown {
  if (input.text !== undefined && input.markdown !== undefined) {
    throw new ConfigError('Pass the comment as plain text or as Markdown, not both.');
  }
  if (input.markdown !== undefined) return client.richTextValue(input.markdown);
  return input.text === undefined ? undefined : client.descriptionValue(input.text);
}

/** Assembles a new comment: text, then mentions appended to it, over any raw body. */
export async function buildCommentBody(
  client: JiraClient,
  issue: string,
  input: CommentInput,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = { ...input.body };
  const text = commentText(client, input);
  if (text !== undefined) body.body = text;
  if (input.mentions !== undefined) {
    body = appendMentions(client, body, await resolveMentions(client, input.mentions));
  }
  if (body.body === undefined) {
    throw new ConfigError(`Nothing to comment on ${issue}. Pass --text or --markdown, or a body containing one.`);
  }
  return body;
}

/**
 * Assembles a replacement comment. An edit replaces the body, so mentions alone would post a
 * bare mention over whatever the comment said. Refusing is the only safe reading: nobody asks
 * to edit a comment down to nothing but a name.
 */
export async function buildCommentEditBody(
  client: JiraClient,
  comment: string,
  input: CommentInput,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = { ...input.body };
  const text = commentText(client, input);
  if (text !== undefined) body.body = text;
  if (body.body === undefined) {
    throw new ConfigError(
      input.mentions === undefined
        ? `Nothing to change on comment ${comment}. Pass --text, or a body.`
        : 'An edit replaces the comment, so --mention alone would erase its text. Pass --text as well.',
    );
  }
  if (input.mentions !== undefined) {
    body = appendMentions(client, body, await resolveMentions(client, input.mentions));
  }
  return body;
}

/** Deletes a comment: a dry run answers before consent is examined, and the request needs it. */
export async function deleteComment(client: JiraClient, input: DeleteCommentInput): Promise<DeleteCommentResult> {
  const { issue, comment } = input;
  if (input.dryRun === true) return { issue, comment, dryRun: true };

  // Both ids are named, so a caller that meant a different comment notices before retrying.
  if (input.confirm !== true) {
    throw new ConfigError(`Deleting comment ${comment} on ${issue} cannot be undone. Pass --confirm to proceed.`);
  }

  await client.deleteComment(issue, comment);
  return { issue, comment, deleted: true };
}
