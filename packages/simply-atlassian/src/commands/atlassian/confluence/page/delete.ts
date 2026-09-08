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
import { ConfluenceCommand, confirmFlag, writeFlags } from '../../../../shared/base-command.js';
import { ConfigError } from '../../../../core/errors.js';
import { pageIdFromInput } from '../../../../shared/atlassian-url.js';
import { stripControlOneLine } from '../../../../core/text.js';

interface Page {
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
}

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
    const pageId = pageIdFromInput(this.args.page);
    const purge = this.flags.purge;

    // Read first so both the confirmation and the result can name the page. A page id identifies
    // nothing to a person, and after a purge this line is the only remaining record of what went.
    const page = (await client.getPage(pageId, { expand: [] })) as Page;
    const title = stripControlOneLine(page.title ?? '(untitled)');
    const alreadyTrashed = page.status === 'trashed';

    if (purge && this.flags.confirm !== true) {
      throw new ConfigError(
        `Refusing to permanently destroy page ${pageId} ("${title}") without --confirm. ` +
          'Omit --purge to move it to the trash instead, which is reversible.',
      );
    }

    if (this.flags['dry-run']) {
      const effect = purge ? 'permanently destroy' : 'move to the trash';
      this.logSafe(`Dry run — not sent. Would ${effect} page ${pageId} ("${title}").`);
      return { pageId, title, purge, deleted: false };
    }

    if (purge) {
      // Confluence only purges content that is already trashed, so an untrashed page needs both
      // steps. Doing them together is the point: "--purge" is one intent, and leaving a caller
      // half-done would let them believe a page was destroyed when it is sitting in the trash.
      if (!alreadyTrashed) await client.deleteContent(pageId);
      await client.deleteContent(pageId, { purge: true });
      this.logSafe(`Permanently deleted page ${pageId} ("${title}").`);
      return { pageId, title, purge: true, deleted: true };
    }

    if (alreadyTrashed) {
      this.logSafe(`Page ${pageId} ("${title}") is already in the trash. Use --purge --confirm to destroy it.`);
      return { pageId, title, purge: false, deleted: false };
    }

    await client.deleteContent(pageId);
    this.logSafe(`Moved page ${pageId} ("${title}") to the trash. It can be restored from there.`);
    return { pageId, title, purge: false, deleted: true };
  }
}
