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
import { buildTransitionBody, parseBodyInput, resolveTransitionId } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';

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

    const id = await resolveTransitionId(client, issue, transition, { byName: this.flags['by-name'] });
    const body = buildTransitionBody(client, id, {
      body: parseBodyInput(this.flags.body, this.flags['body-file']),
      comment: this.flags.comment,
    });

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
}
