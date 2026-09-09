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
import { deletePage, pageIdForInstance } from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand, confirmFlag, writeFlags } from '../../../../shared/base-command.js';

export default class ConfluencePageDelete extends ConfluenceCommand<typeof ConfluencePageDelete> {
  public static override isWrite = true;

  public static override readonly summary = 'Move a Confluence page to the trash, or destroy it.';
  public static override readonly description =
    'By default this trashes the page, which is reversible — it can be restored from the space ' +
    'trash — so no --confirm is required. --purge destroys it permanently and does require ' +
    '--confirm, because nothing brings it back. A page that is already trashed is purged ' +
    'directly; one that is not is trashed and then purged, so --purge always means "gone".';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> 123456 --purge --confirm',
    '<%= config.bin %> <%= command.id %> 123456 --purge --dry-run',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    ...confirmFlag,
    purge: Flags.boolean({
      summary: 'Destroy the page permanently instead of trashing it. Requires --confirm.',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const client = this.confluence();
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);
    const purge = this.flags.purge;

    // The page is read first so every line below can name it; a page id identifies nothing to
    // a person, and after a purge that line is the only remaining record of what went.
    const result = await deletePage(client, pageId, {
      purge,
      confirm: this.flags.confirm,
      dryRun: this.flags['dry-run'],
    });
    const { title } = result;

    if (this.flags['dry-run']) {
      const effect = purge ? 'permanently destroy' : 'move to the trash';
      this.logSafe(`Dry run — not sent. Would ${effect} page ${pageId} (${title}).`);
      return result;
    }
    if (purge) {
      this.logSafe(`Permanently deleted page ${pageId} (${title}).`);
      return result;
    }
    if (!result.deleted) {
      this.logSafe(`Page ${pageId} (${title}) is already in the trash. Use --purge --confirm to destroy it.`);
      return result;
    }
    this.logSafe(`Moved page ${pageId} (${title}) to the trash. It can be restored from there.`);
    return result;
  }
}
