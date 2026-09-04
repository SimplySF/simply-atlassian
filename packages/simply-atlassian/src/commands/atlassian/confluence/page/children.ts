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
import { pageIdFromInput } from '../../../../shared/atlassian-url.js';
import { ConfluenceCommand } from '../../../../shared/base-command.js';
import { formatTable } from '../../../../shared/output.js';

interface ChildPage {
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
  readonly version?: { readonly when?: string };
}

interface ChildrenResponse {
  readonly results?: ChildPage[];
  readonly size?: number;
}

export default class ConfluencePageChildren extends ConfluenceCommand<typeof ConfluencePageChildren> {
  public static override readonly summary = 'List the direct child pages of a Confluence page.';
  public static override readonly description =
    'Lists pages one level below the given page. Use --json for the complete, unmodified API ' + 'payload.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title',
    '<%= config.bin %> <%= command.id %> 123456 --limit 50 --json',
  ];

  public static override readonly args = {
    page: Args.string({
      description: 'Page id, or a page URL to read the id from.',
      required: true,
    }),
  };

  public static override readonly flags = {
    limit: Flags.integer({
      summary: 'Maximum number of children to return.',
      default: 25,
      min: 1,
    }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdFromInput(this.args.page);
    const response = (await this.confluence().getPageChildren(pageId, {
      limit: this.flags.limit,
    })) as ChildrenResponse;

    const children = response.results ?? [];
    if (children.length === 0) {
      this.log('No child pages.');
      return response;
    }

    this.log(
      formatTable(children, [
        { header: 'ID', value: (child): string | undefined => child.id },
        { header: 'STATUS', value: (child): string | undefined => child.status },
        { header: 'UPDATED', value: (child): string | undefined => child.version?.when?.slice(0, 10) },
        { header: 'TITLE', value: (child): string | undefined => child.title },
      ]),
    );
    this.log(`\nShowing ${children.length} child page(s).`);

    return response;
  }
}
