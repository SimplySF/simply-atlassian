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
import { formatTable } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../shared/base-command.js';

interface Project {
  readonly id?: string;
  readonly key?: string;
  readonly name?: string;
  readonly projectTypeKey?: string;
  readonly lead?: { readonly displayName?: string };
}

interface ProjectsResponse {
  readonly values?: Project[];
  readonly total?: number;
}

export default class JiraProjects extends JiraCommand<typeof JiraProjects> {
  public static override readonly summary = 'List Jira projects.';
  public static override readonly description =
    'The KEY column is the point: it is what every other command takes and what a caller most ' +
    'often does not have. Cloud paginates this endpoint and Server/DC returns the whole list; ' +
    'both are handled.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --limit 100 --json',
  ];

  public static override readonly flags = {
    limit: Flags.integer({ summary: 'Maximum number of projects to show.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const response = (await this.jira().getProjects({ maxResults: this.flags.limit })) as Project[] | ProjectsResponse;

    // Cloud answers `{ values }`; Server/DC answers a bare array.
    const projects = Array.isArray(response) ? response : (response.values ?? []);
    if (projects.length === 0) {
      this.log('No projects are visible to this account.');
      return response;
    }

    const shown = projects.slice(0, this.flags.limit);
    this.log(
      formatTable(shown, [
        { header: 'KEY', value: (p: Project): string | undefined => p.key },
        { header: 'NAME', value: (p: Project): string | undefined => p.name },
        { header: 'TYPE', value: (p: Project): string | undefined => p.projectTypeKey },
        { header: 'LEAD', value: (p: Project): string | undefined => p.lead?.displayName },
      ]),
    );

    const total = Array.isArray(response) ? projects.length : response.total;
    const scope = typeof total !== 'number' || total === shown.length ? '' : ` of ${total}`;
    this.logSafe(`\nShowing ${shown.length}${scope} project(s).`);
    return response;
  }
}
