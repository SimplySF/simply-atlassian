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
import { formatTable } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../../shared/base-command.js';

interface Version {
  readonly id?: string;
  readonly name?: string;
  readonly released?: boolean;
  readonly archived?: boolean;
  readonly releaseDate?: string;
}

export default class JiraProjectVersions extends JiraCommand<typeof JiraProjectVersions> {
  public static override readonly summary = "List a project's versions.";
  public static override readonly description =
    'Versions are how Jira models releases. The ID column is what sets fixVersions through ' +
    '--body on issue create or update.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ',
    '<%= config.bin %> <%= command.id %> PROJ --json',
  ];

  public static override readonly args = {
    project: Args.string({ description: 'Project key, for example PROJ.', required: true }),
  };

  public static override readonly flags = {
    limit: Flags.integer({ summary: 'Maximum number of versions to show.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const versions = (await this.jira().getProjectVersions(this.args.project)) as Version[];
    if (!Array.isArray(versions) || versions.length === 0) {
      this.logSafe(`No versions on project ${this.args.project}.`);
      return versions ?? [];
    }

    const shown = versions.slice(0, this.flags.limit);
    this.log(
      formatTable(shown, [
        { header: 'ID', value: (v: Version): string | undefined => v.id },
        { header: 'NAME', value: (v: Version): string | undefined => v.name },
        { header: 'RELEASED', value: (v: Version): string => (v.released === true ? 'yes' : 'no') },
        { header: 'ARCHIVED', value: (v: Version): string => (v.archived === true ? 'yes' : 'no') },
        { header: 'RELEASE DATE', value: (v: Version): string | undefined => v.releaseDate },
      ]),
    );

    const scope = shown.length === versions.length ? '' : ` of ${versions.length}`;
    this.logSafe(`\nShowing ${shown.length}${scope} version(s).`);
    return versions;
  }
}
