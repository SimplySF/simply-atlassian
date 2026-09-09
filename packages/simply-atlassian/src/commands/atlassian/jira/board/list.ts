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

import { Flags } from '@oclif/core';
import { formatTable } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../../shared/base-command.js';

interface Board {
  readonly id?: number | string;
  readonly name?: string;
  readonly type?: string;
  readonly location?: { readonly projectKey?: string; readonly projectName?: string };
}

export default class JiraBoardList extends JiraCommand<typeof JiraBoardList> {
  public static override readonly summary = 'List Jira agile boards.';
  public static override readonly description =
    'Lists boards visible to the current Jira user. Use --project to restrict boards by project ' +
    'key or id, and --json for the complete paginated response.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --project PROJ --type scrum',
    '<%= config.bin %> <%= command.id %> --limit 10 --json',
  ];

  public static override readonly flags = {
    project: Flags.string({ summary: 'Filter by project key or id.' }),
    type: Flags.string({ summary: 'Filter by board type: scrum or kanban.' }),
    limit: Flags.integer({ summary: 'Maximum number of boards to return.', default: 50, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const result = await this.jira().getBoards({
      projectKeyOrId: this.flags.project,
      type: this.flags.type,
      maxResults: this.flags.limit,
      limit: this.flags.limit,
    });
    const boards = result.values as Board[];

    if (boards.length === 0) {
      this.log('No boards found.');
      return result;
    }

    this.log(
      formatTable(boards, [
        { header: 'ID', value: (board): number | string | undefined => board.id },
        { header: 'NAME', value: (board): string | undefined => board.name },
        { header: 'TYPE', value: (board): string | undefined => board.type },
        {
          header: 'PROJECT',
          value: (board): string | undefined => board.location?.projectKey ?? board.location?.projectName,
        },
      ]),
    );
    this.log(`\nShowing ${boards.length} board(s).`);
    return result;
  }
}
