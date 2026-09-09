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
import {
  type ConfluencePageSummary,
  formatKeyValue,
  pageIdForInstance,
  preparePageUpdate,
  updatePage,
  webUrl,
} from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand, writeFlags } from '../../../../shared/base-command.js';

export default class ConfluencePageUpdate extends ConfluenceCommand<typeof ConfluencePageUpdate> {
  public static override isWrite = true;

  public static override readonly summary = "Replace a Confluence page's body or title.";
  public static override readonly description =
    'The version number is handled for you: the page is read, its version incremented, and the ' +
    'result sent. There is no --version flag, because Confluence refuses a stale version with a ' +
    'conflict rather than overwriting — so if someone edits the page while this runs, the ' +
    'command fails and says so instead of discarding their work. Re-run it to pick up their ' +
    'change. This REPLACES the body; it does not append to it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456 --text "Updated status."',
    '<%= config.bin %> <%= command.id %> 123456 --body-file ./page.xml',
    '<%= config.bin %> <%= command.id %> 123456 --title "Renamed" --dry-run',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    title: Flags.string({ summary: "New title. Defaults to the page's current title." }),
    text: Flags.string({ summary: 'Body as plain text; becomes paragraphs, markup escaped.' }),
    body: Flags.string({ summary: 'Body as raw storage-format XHTML.' }),
    'body-file': Flags.string({ summary: 'Path to a file holding storage-format XHTML.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.confluence();
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);

    const plan = await preparePageUpdate(client, pageId, {
      title: this.flags.title,
      text: this.flags.text,
      body: this.flags.body,
      'body-file': this.flags['body-file'],
    });

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would update page ${pageId} from version ${plan.version} to ${plan.version + 1}:`);
      this.logSafe(JSON.stringify(plan.payload, null, 2));
      return plan.payload;
    }

    const updated = (await updatePage(client, plan)) as ConfluencePageSummary;
    this.log(
      formatKeyValue([
        ['Updated', pageId],
        ['Title', updated.title],
        ['Version', updated.version?.number],
        ['URL', webUrl(updated)],
      ]),
    );
    return updated;
  }
}
