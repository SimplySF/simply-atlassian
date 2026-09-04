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
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';
import { mergeFields, parseBodyInput } from '../../../../shared/json-input.js';
import { ConfigError } from '../../../../core/errors.js';

interface Transition {
  readonly id?: string;
  readonly name?: string;
  readonly to?: { readonly name?: string };
}

interface TransitionsResponse {
  readonly transitions?: Transition[];
}

export default class JiraIssueTransition extends JiraCommand<typeof JiraIssueTransition> {
  public static override isWrite = true;

  public static override readonly summary = 'Move a Jira issue through a workflow transition.';
  public static override readonly description =
    'The transition may be given as an id or as a name, matched case-insensitively against ' +
    'the transitions currently available for the issue — a name is what a person or an agent ' +
    'actually knows. An unmatched name lists what is available. Use "issue transitions" to see ' +
    'the set, or --dry-run to check without sending.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 Done',
    '<%= config.bin %> <%= command.id %> PROJ-123 "In Progress"',
    '<%= config.bin %> <%= command.id %> PROJ-123 31',
    '<%= config.bin %> <%= command.id %> PROJ-123 Done --comment "shipped"',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
    transition: Args.string({ description: 'Transition id, or its name.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    comment: Flags.string({ summary: 'Comment to add as part of the transition.' }),
    'by-name': Flags.boolean({
      summary: 'Treat the transition argument as a name even if it is all digits.',
      description:
        'A digits-only argument is otherwise taken as an id, which makes a workflow step literally named "41" unreachable.',
      default: false,
    }),
    body: Flags.string({ summary: 'Raw JSON request body.', exclusive: ['body-file'] }),
    'body-file': Flags.string({ summary: 'Path to a file holding the raw JSON request body.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();
    const { issue, transition } = this.args;

    const looksLikeId = !this.flags['by-name'] && /^\d+$/.test(transition);
    const id = looksLikeId ? transition : await this.resolveByName(issue, transition);

    const body = mergeFields(parseBodyInput(this.flags.body, this.flags['body-file']), {});
    // `fields` is only meaningful here if the caller supplied some; an empty object confuses Jira.
    if (Object.keys(body.fields as Record<string, unknown>).length === 0) delete body.fields;
    body.transition = { id };
    if (this.flags.comment !== undefined) {
      // Pushed into any existing update block rather than replacing it: a caller can combine
      // --comment with other operations supplied through --body.
      const existing = body.update;
      const update: Record<string, unknown> =
        typeof existing === 'object' && existing !== null && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {};
      const comments = Array.isArray(update.comment) ? [...(update.comment as unknown[])] : [];
      comments.push({ add: { body: client.descriptionValue(this.flags.comment) } });
      update.comment = comments;
      body.update = update;
    }

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      this.log(JSON.stringify(body, null, 2));
      return body;
    }

    await client.transitionIssue(issue, body);
    // The id can come from the instance's own transition list, so it goes out sanitised.
    this.logSafe(`Transitioned ${issue} using transition ${id}.`);
    return { issue, transition: id, transitioned: true };
  }

  /** Matches a name against what the workflow currently offers, and says so when it cannot. */
  private async resolveByName(issue: string, name: string): Promise<string> {
    const response = (await this.jira().getTransitions(issue)) as TransitionsResponse;
    const available = response.transitions ?? [];
    const wanted = name.trim().toLowerCase();
    const matches = available.filter((t) => t.name?.trim().toLowerCase() === wanted);

    const listing = available
      .map((t) => `${t.name ?? '?'} (id ${t.id ?? '?'}${t.to?.name === undefined ? '' : ` -> ${t.to.name}`})`)
      .join(', ');
    // Turning the most common failure into a self-correcting one matters most for an agent,
    // which can retry with a name from this list rather than guessing again.
    if (matches.length === 0) {
      throw new ConfigError(
        `No transition named "${name}" is available for ${issue}.` +
          (listing === '' ? ' The issue has no available transitions.' : ` Available: ${listing}.`),
      );
    }
    if (matches.length === 1) {
      const matched = matches[0]?.id;
      // Matched unambiguously but the instance gave no id, which is not the caller's problem
      // to disambiguate — say what actually happened.
      if (matched === undefined) {
        throw new ConfigError(
          `The instance reported no id for transition "${name}" on ${issue}, so it cannot be applied.`,
        );
      }
      return matched;
    }
    throw new ConfigError(
      `"${name}" matches more than one transition for ${issue}. Pass an id instead. Available: ${listing}.`,
    );
  }
}
