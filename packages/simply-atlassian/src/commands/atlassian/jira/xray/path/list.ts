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
import { flattenFolders, listXrayFolders, type XrayFolder } from '@simplysf/simply-atlassian-core';
import { XrayCommand } from '../../../../../shared/base-command.js';

export default class JiraXrayPathList extends XrayCommand<typeof JiraXrayPathList> {
  public static override readonly summary = "Show a project's test repository folder tree, with test counts.";
  public static override readonly description =
    'Paths are written the way Xray stores them, with a leading slash (/O&M/Accounts), and are what ' +
    '"test list --project X --path" and "test export --project X --path" take. --path starts the tree at ' +
    'a subfolder, with or without the leading slash; --depth limits how many levels below it are shown. ' +
    '--json returns the nested structure: { name, path, id, testCount, folders }.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --project OM',
    '<%= config.bin %> <%= command.id %> --project OM --path "/O&M" --depth 1',
    '<%= config.bin %> <%= command.id %> --project OM --json',
  ];

  public static override readonly flags = {
    project: Flags.string({ summary: 'Project key.', required: true }),
    path: Flags.string({ summary: 'Start at this folder instead of the repository root.' }),
    depth: Flags.integer({ summary: 'Levels of subfolders to show below the starting folder.', min: 0 }),
  };

  public async run(): Promise<XrayFolder> {
    const tree = await listXrayFolders(this.xray(), {
      project: this.flags.project,
      path: this.flags.path,
      depth: this.flags.depth,
    });

    for (const { folder, depth } of flattenFolders(tree)) {
      const label = depth === 0 ? folder.path : folder.name;
      const count =
        folder.testCount === undefined ? '' : `  (${folder.testCount} test${folder.testCount === 1 ? '' : 's'})`;
      // Indentation is the tree, so this is logged directly rather than through a table, which would
      // collapse the leading spaces.
      this.logSafe(`${'  '.repeat(depth)}${label}${count}`);
    }
    return tree;
  }
}
