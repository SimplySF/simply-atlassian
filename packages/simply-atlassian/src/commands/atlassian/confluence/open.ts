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
import { pageIdFromInput, pageUrl } from '../../../shared/atlassian-url.js';
import { ConfluenceCommand } from '../../../shared/base-command.js';
import { openInBrowser } from '../../../shared/open-in-browser.js';

export default class ConfluenceOpen extends ConfluenceCommand<typeof ConfluenceOpen> {
  public static override readonly summary = 'Open a Confluence page in the browser.';
  public static override readonly description =
    'Builds the browser URL for a page id or page URL and opens it in the default browser. ' +
    'Use --print (or --url) to print the URL without launching a browser.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title --print',
    '<%= config.bin %> <%= command.id %> 123456 --json',
  ];

  public static override readonly args = {
    page: Args.string({
      description: 'Page id, or a page URL to read the id from.',
      required: true,
    }),
  };

  public static override readonly flags = {
    print: Flags.boolean({
      aliases: ['url'],
      summary: 'Print the URL without opening a browser.',
      default: false,
    }),
  };

  public run(): Promise<{ url: string }> {
    const config = this.confluenceConfig();
    const url = pageUrl(config.url, pageIdFromInput(this.args.page));

    if (!this.jsonEnabled()) {
      openInBrowser(url, { print: this.flags.print, log: (value) => this.log(value) });
    }

    return Promise.resolve({ url });
  }
}
