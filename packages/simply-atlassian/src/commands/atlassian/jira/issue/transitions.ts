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
import { JiraCommand } from '../../../../shared/base-command.js';
import { formatTable } from '../../../../shared/output.js';

interface Transition {
  readonly id?: string;
  readonly name?: string;
  readonly to?: { readonly name?: string };
}

interface TransitionsResponse {
  readonly transitions?: Transition[];
}

export default class JiraIssueTransitions extends JiraCommand<typeof JiraIssueTransitions> {
  public static override readonly summary = 'List the transitions available for an issue.';
  public static override readonly description =
    'Shows which transitions the issue can currently take, which is what makes ' +
    '"issue transition" usable: the available set depends on the workflow and the current status.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public async run(): Promise<unknown> {
    const response = (await this.jira().getTransitions(this.args.issue)) as TransitionsResponse;
    const transitions = response.transitions ?? [];

    if (transitions.length === 0) {
      this.log(`No transitions available for ${this.args.issue}.`);
      return response;
    }

    this.log(
      formatTable(transitions, [
        { header: 'ID', value: (t): string | undefined => t.id },
        { header: 'NAME', value: (t): string | undefined => t.name },
        { header: 'MOVES TO', value: (t): string | undefined => t.to?.name },
      ]),
    );
    return response;
  }
}
