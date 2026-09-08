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
import { JiraCommand, writeFlags } from '../../../../../shared/base-command.js';
import { resolveLinkDirection, type LinkTypesResponse } from '../../../../../shared/issue-links.js';
import { stripControlOneLine } from '../../../../../core/text.js';

export default class JiraIssueLinkCreate extends JiraCommand<typeof JiraIssueLinkCreate> {
  public static override isWrite = true;

  public static override readonly summary = 'Link two Jira issues.';
  public static override readonly description =
    'The relationship is given the way it would be said out loud: "A blocks B". Either ' +
    'direction of a type works — "A blocks B" and "B is blocked by A" state the same fact and ' +
    'produce the same link — so the phrasing can follow whatever the source text used. The ' +
    'type may also be given by name, which is read as its outward phrase. An unmatched type ' +
    'lists what the instance offers. Use "issue link types" to see them, or --dry-run to check ' +
    'without sending.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-1 blocks PROJ-2',
    '<%= config.bin %> <%= command.id %> PROJ-2 "is blocked by" PROJ-1',
    '<%= config.bin %> <%= command.id %> PROJ-1 relates PROJ-3 --comment "same root cause"',
  ];

  public static override readonly args = {
    from: Args.string({ description: 'Issue the relationship is stated from, for example PROJ-1.', required: true }),
    type: Args.string({ description: 'Relationship phrase or type name, for example "blocks".', required: true }),
    to: Args.string({ description: 'Issue the relationship points at, for example PROJ-2.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    comment: Flags.string({ summary: 'Comment to add to the link.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();
    const { from, type, to } = this.args;

    const response = (await client.getLinkTypes()) as LinkTypesResponse;
    const resolved = resolveLinkDirection(response.issueLinkTypes ?? [], from, type, to);

    const body: Record<string, unknown> = {
      // Sent by id when the instance gave one. A name is a mutable string the server re-resolves,
      // so posting it reopens the question the phrase match just answered: a rename between the
      // lookup and the post, or two types sharing a name, would land a different relationship
      // than the one matched.
      type: resolved.type.id === undefined ? { name: resolved.type.name } : { id: resolved.type.id },
      inwardIssue: { key: resolved.inwardIssue },
      outwardIssue: { key: resolved.outwardIssue },
    };
    if (this.flags.comment !== undefined) body.comment = { body: client.descriptionValue(this.flags.comment) };

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      // Sanitised, not merely serialised: the body carries --comment text, which a caller may
      // have copied from a Jira comment, and JSON.stringify escapes C0 while leaving C1, bidi
      // and zero-width characters intact.
      this.logSafe(JSON.stringify(body, null, 2));
      return body;
    }

    await client.createIssueLink(body);
    // Echoed as the caller said it, not as the payload is shaped: inward/outward is exactly the
    // framing this command exists to hide, and repeating it back would invite doubt about
    // whether the right thing was sent.
    // The phrase is the instance's own canonical wording, so it is kept to one line: logSafe
    // keeps newlines, and a forged line on stdout reads as this CLI's own output.
    this.logSafe(`Linked: ${from} ${stripControlOneLine(resolved.phrase)} ${to}.`);
    return { from, to, type: resolved.type.name ?? resolved.type.id, phrase: resolved.phrase, linked: true };
  }
}
