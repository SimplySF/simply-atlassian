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
import { ConfigError } from '../../../../core/errors.js';
import { JiraCommand } from '../../../../shared/base-command.js';
import { formatTable } from '../../../../shared/output.js';

interface Sprint {
  readonly id?: number | string;
  readonly name?: string;
  readonly state?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export default class JiraSprintList extends JiraCommand<typeof JiraSprintList> {
  public static override readonly summary = "List a board's sprints.";
  public static override readonly description =
    'Lists sprints for a numeric agile board id. Board names are intentionally not resolved; ' +
    'use "jira board list" first when you do not have the id.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 42',
    '<%= config.bin %> <%= command.id %> 42 --state closed --limit 10',
  ];

  public static override readonly args = {
    board: Args.string({ description: 'Numeric agile board id.', required: true }),
  };

  public static override readonly flags = {
    state: Flags.string({ summary: 'Sprint states as CSV: active, future, closed.', default: 'active,future' }),
    limit: Flags.integer({ summary: 'Maximum number of sprints to return.', default: 50, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const board = numericId('Board', this.args.board);
    const result = await this.jira().getSprints(board, {
      state: this.flags.state,
      maxResults: this.flags.limit,
      limit: this.flags.limit,
    });
    const sprints = result.values as Sprint[];

    if (sprints.length === 0) {
      this.log(`No sprints found for board ${board}.`);
      return result;
    }

    this.log(
      formatTable(sprints, [
        { header: 'ID', value: (sprint): number | string | undefined => sprint.id },
        { header: 'NAME', value: (sprint): string | undefined => sprint.name },
        { header: 'STATE', value: (sprint): string | undefined => sprint.state },
        { header: 'START', value: (sprint): string | undefined => sprint.startDate },
        { header: 'END', value: (sprint): string | undefined => sprint.endDate },
      ]),
    );
    this.log(`\nShowing ${sprints.length} sprint(s).`);
    return result;
  }
}

export function numericId(label: string, value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${label} id must be numeric; Jira agile commands do not resolve names yet: ${value}`);
  }
  return value;
}
