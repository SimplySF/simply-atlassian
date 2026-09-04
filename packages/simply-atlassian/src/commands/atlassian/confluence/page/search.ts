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
import { ConfluenceCommand } from '../../../../shared/base-command.js';
import { formatTable } from '../../../../shared/output.js';

interface SearchedPage {
  readonly id?: string;
  readonly title?: string;
  readonly type?: string;
  readonly space?: { readonly key?: string };
  readonly version?: { readonly when?: string };
}

const DEFAULT_LIMIT = 25;

export default class ConfluencePageSearch extends ConfluenceCommand<typeof ConfluencePageSearch> {
  public static override readonly summary = 'Search Confluence content with CQL.';
  public static override readonly description =
    'Runs a CQL query and follows result pages until the limit is reached or the instance has ' +
    'no more matches. Use --json for the complete, unmodified API payload of every result.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --cql "type = page AND space = DOCS"',
    `<%= config.bin %> <%= command.id %> --cql 'text ~ "release notes"' --limit 10`,
    '<%= config.bin %> <%= command.id %> --cql "type = page order by lastmodified desc" --limit 5 --json',
  ];

  public static override readonly flags = {
    cql: Flags.string({
      summary: 'CQL query to run.',
      required: true,
    }),
    limit: Flags.integer({
      summary: 'Maximum number of results to return across all pages.',
      default: DEFAULT_LIMIT,
      min: 1,
    }),
  };

  public async run(): Promise<unknown> {
    const result = await this.confluence().searchAllPages(this.flags.cql, this.flags.limit);
    const pages = result.results as SearchedPage[];

    if (pages.length === 0) {
      this.log('No content matched.');
      return result;
    }

    this.log(
      formatTable(pages, [
        { header: 'ID', value: (page): string | undefined => page.id },
        { header: 'SPACE', value: (page): string | undefined => page.space?.key },
        { header: 'TYPE', value: (page): string | undefined => page.type },
        { header: 'UPDATED', value: (page): string | undefined => page.version?.when?.slice(0, 10) },
        { header: 'TITLE', value: (page): string | undefined => page.title },
      ]),
    );

    // Say plainly whether anything was left behind, so a truncated list is never mistaken
    // for the whole answer — by a person or by an agent.
    const scope = result.size === undefined ? '' : ` of ${result.size}`;
    const note = result.complete ? '' : ` (limit ${this.flags.limit} reached; more available)`;
    this.log(`\nShowing ${pages.length}${scope} result(s)${note}.`);

    return result;
  }
}
