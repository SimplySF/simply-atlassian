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

import { Flags } from '@oclif/core';
import { buildSprintCreateBody, formatKeyValue, numericId, type Sprint } from '@simplysf/simply-atlassian-core';
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';

export default class JiraSprintCreate extends JiraCommand<typeof JiraSprintCreate> {
  public static override isWrite = true;

  public static override readonly summary = 'Create a sprint on a board.';
  public static override readonly description =
    'The board is given by numeric id; agile commands do not resolve names, because a board name ' +
    'is neither unique nor stable — run "board list" first. Dates are ISO-8601.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --board 42 --name "Sprint 7"',
    '<%= config.bin %> <%= command.id %> --board 42 --name "Sprint 7" --start 2026-09-15 --end 2026-09-29',
  ];

  public static override readonly flags = {
    ...writeFlags,
    board: Flags.string({ summary: 'Board id the sprint belongs to.', required: true }),
    name: Flags.string({ summary: 'Sprint name.', required: true }),
    goal: Flags.string({ summary: 'Sprint goal.' }),
    start: Flags.string({ summary: 'Start date, ISO-8601.' }),
    end: Flags.string({ summary: 'End date, ISO-8601.' }),
  };

  public async run(): Promise<unknown> {
    const boardId = numericId('Board', this.flags.board);
    const payload = buildSprintCreateBody(boardId, {
      name: this.flags.name,
      goal: this.flags.goal,
      start: this.flags.start,
      end: this.flags.end,
    });

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      this.logSafe(JSON.stringify(payload, null, 2));
      return payload;
    }

    const created = (await this.jira().createSprint(payload)) as Sprint;
    this.log(
      formatKeyValue([
        ['Created sprint', created.id],
        ['Name', created.name],
        ['State', created.state],
        ['Board', created.originBoardId ?? boardId],
      ]),
    );
    return created;
  }
}
