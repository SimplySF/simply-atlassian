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
import { formatTable, pageHistoryJson, pageIdForInstance } from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand } from '../../../../shared/base-command.js';

const DEFAULT_LIMIT = 25;

export default class ConfluencePageHistory extends ConfluenceCommand<typeof ConfluencePageHistory> {
  public static override readonly summary = "Show a Confluence page's version history.";
  public static override readonly description =
    'Lists who edited a page, when, whether the edit was minor, and the version message, newest ' +
    'first. --limit keeps the most recent versions. Use --json for the raw version entries and ' +
    'whether the whole history was read.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title --limit 5',
    '<%= config.bin %> <%= command.id %> 123456 --json',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    limit: Flags.integer({
      summary: 'Maximum number of versions to return, most recent first.',
      default: DEFAULT_LIMIT,
      min: 1,
    }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);
    const history = await this.confluence().getAllPageVersions(pageId, this.flags.limit);
    const json = pageHistoryJson(history);
    if (this.jsonEnabled()) return json;

    const { versions } = history;
    if (versions.length === 0) {
      this.logSafe(`No versions found for page ${pageId}.`);
      return json;
    }

    this.log(
      formatTable(versions, [
        { header: 'VERSION', value: (v): string | undefined => v.number?.toString() },
        { header: 'WHEN', value: (v): string | undefined => v.when?.slice(0, 10) },
        { header: 'AUTHOR', value: (v): string | undefined => v.author },
        { header: 'MINOR', value: (v): string | undefined => (v.minorEdit === true ? 'yes' : undefined) },
        { header: 'MESSAGE', value: (v): string | undefined => v.message },
      ]),
    );

    this.log(
      history.complete
        ? `\nShowing ${versions.length} version(s).`
        : `\nShowing the ${versions.length} most recent version(s); pass --limit for more.`,
    );
    return json;
  }
}
