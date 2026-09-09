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

import { Args } from '@oclif/core';
import { addIssuesToSprint, sprintChunkSizes } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';

export default class JiraSprintAdd extends JiraCommand<typeof JiraSprintAdd> {
  public static override isWrite = true;

  public static override readonly summary = 'Add existing issues to a sprint.';
  public static override readonly description =
    'Moves one or more existing issues into a numeric sprint. Jira accepts at most 50 issue keys ' +
    'per request, so larger lists are sent in chunks. Use --dry-run to inspect the payload without ' +
    'sending it; adding to a sprint is reversible and does not require --confirm.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 101 PROJ-1 PROJ-2',
    '<%= config.bin %> <%= command.id %> 101 PROJ-1 --dry-run',
  ];

  public static override readonly args = {
    sprint: Args.string({ description: 'Numeric sprint id.', required: true }),
    issue: Args.string({
      description: 'Issue key to move; repeat for multiple issues.',
      required: true,
      multiple: true,
    }),
  };

  public static override readonly flags = { ...writeFlags };

  public async run(): Promise<unknown> {
    const issues = this.args.issue;
    const result = await addIssuesToSprint(this.jira(), this.args.sprint, issues, { dryRun: this.flags['dry-run'] });

    if (!('chunks' in result)) {
      this.log(`Dry run — not sent. Target sprint: ${result.sprint}`);
      this.log(JSON.stringify({ issues }, null, 2));
      return result;
    }

    sprintChunkSizes(issues.length).forEach((size, index) => {
      this.log(`Added ${size} issue(s) to sprint ${result.sprint} (chunk ${index + 1}/${result.chunks}).`);
    });
    return result;
  }
}
