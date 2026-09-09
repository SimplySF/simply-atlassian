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
import {
  BODY_FORMATS,
  type BodyFormat,
  type ConfluencePageSummary,
  formatKeyValue,
  pageExpand,
  pageIdFromInput,
  renderPageBody,
  stripControl,
  webUrl,
} from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand, parseList } from '../../../../shared/base-command.js';

interface Page extends ConfluencePageSummary {
  readonly space?: { readonly key?: string; readonly name?: string };
  readonly version?: {
    readonly number?: number;
    readonly when?: string;
    readonly by?: { readonly displayName?: string };
  };
}

export default class ConfluencePageGet extends ConfluenceCommand<typeof ConfluencePageGet> {
  public static override readonly summary = 'Show a single Confluence page.';
  public static override readonly description =
    'Prints page metadata followed by its body. The body is converted to Markdown by default; ' +
    '--body-format storage prints the stored XHTML verbatim, and none omits it entirely (and ' +
    'does not request it, which matters when listing pages whose content will not be read). ' +
    'Use --json for the complete, unmodified API payload.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title',
    '<%= config.bin %> <%= command.id %> 123456 --body-format none',
    '<%= config.bin %> <%= command.id %> 123456 --json',
  ];

  public static override readonly args = {
    page: Args.string({
      description: 'Page id, or a page URL to read the id from.',
      required: true,
    }),
  };

  public static override readonly flags = {
    'body-format': Flags.string({
      summary: 'How to render the page body.',
      options: [...BODY_FORMATS],
      default: 'markdown',
    }),
    expand: Flags.string({
      summary: 'Comma-separated Confluence expansions, replacing the default set.',
    }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdFromInput(this.args.page);
    const format = this.flags['body-format'] as BodyFormat;
    const expand = pageExpand(format, parseList(this.flags.expand));

    const page = (await this.confluence().getPage(pageId, { expand })) as Page;

    this.log(
      formatKeyValue([
        ['ID', page.id],
        ['Title', page.title],
        ['Space', page.space?.name ?? page.space?.key],
        ['Type', page.type],
        ['Status', page.status],
        ['Version', page.version?.number],
        ['Updated', page.version?.when],
        ['Updated by', page.version?.by?.displayName],
        ['URL', webUrl(page)],
      ]),
    );

    const rendered = renderPageBody(page.body?.storage?.value, format);
    if (rendered !== undefined) this.log(`\n---\n\n${stripControl(rendered)}`);

    return page;
  }
}
