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

import { listXrayContainers, type JiraSearchResult } from '@simplysf/simply-atlassian-core';
import { XrayCommand } from '../../../../../shared/base-command.js';
import { containerLines, xrayContainerFlags } from '../../../../../shared/xray-containers.js';

export default class JiraXrayPlanList extends XrayCommand<typeof JiraXrayPlanList> {
  public static override readonly summary = 'List the Test Plans in a project, with how many tests each holds.';
  public static override readonly description =
    'People rarely know a test plan key by heart; this finds it. The KEY column is what "test list --plan" ' +
    'takes. --jql and --search narrow the list as they do for "test list". --json returns the raw search ' +
    'envelope, like "issue search": { issues, total, pages, complete }.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --project OM',
    '<%= config.bin %> <%= command.id %> --project OM --search release',
    '<%= config.bin %> <%= command.id %> --project OM --jql "status != Closed" --json',
  ];

  public static override readonly flags = xrayContainerFlags;

  public async run(): Promise<JiraSearchResult> {
    const result = await listXrayContainers(this.xray(), 'plan', {
      project: this.flags.project,
      jql: this.flags.jql,
      search: this.flags.search,
      fields: this.xrayFields(),
      limit: this.flags.limit,
    });
    for (const line of containerLines(result, 'test plan', this.flags.limit)) this.log(line);
    return result.search;
  }
}
