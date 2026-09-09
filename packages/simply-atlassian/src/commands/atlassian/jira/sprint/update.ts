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
import { formatKeyValue, numericId, prepareSprintUpdate, type Sprint } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';

export default class JiraSprintUpdate extends JiraCommand<typeof JiraSprintUpdate> {
  public static override isWrite = true;

  public static override readonly summary = "Change a sprint's name, dates, goal, or state.";
  public static override readonly description =
    'Jira treats a sprint update as a full replacement and clears anything the request omits, so ' +
    'the sprint is read first and your changes applied on top — passing only --name will not ' +
    'blank the goal. --state closed is how a sprint ends; it is reversible, so it takes no ' +
    '--confirm, and --dry-run shows what would be sent.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 101 --name "Sprint 7 (extended)"',
    '<%= config.bin %> <%= command.id %> 101 --state closed',
    '<%= config.bin %> <%= command.id %> 101 --goal "Ship the CLI" --end 2026-10-01 --dry-run',
  ];

  public static override readonly args = {
    sprint: Args.string({ description: 'Sprint id, numeric.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    name: Flags.string({ summary: 'New sprint name.' }),
    goal: Flags.string({ summary: 'New sprint goal.' }),
    start: Flags.string({ summary: 'Start date, ISO-8601.' }),
    end: Flags.string({ summary: 'End date, ISO-8601.' }),
    state: Flags.string({ summary: 'Sprint state.', options: ['future', 'active', 'closed'] }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();
    const sprintId = numericId('Sprint', this.args.sprint);
    const payload = await prepareSprintUpdate(client, sprintId, {
      name: this.flags.name,
      goal: this.flags.goal,
      start: this.flags.start,
      end: this.flags.end,
      state: this.flags.state,
    });

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would update sprint ${sprintId}:`);
      this.logSafe(JSON.stringify(payload, null, 2));
      return payload;
    }

    const updated = (await client.updateSprint(sprintId, payload)) as Sprint;
    this.log(
      formatKeyValue([
        ['Updated sprint', updated.id ?? sprintId],
        ['Name', updated.name],
        ['State', updated.state],
        ['Goal', updated.goal],
      ]),
    );
    return updated;
  }
}
