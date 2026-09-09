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
import { ConfluenceCommand, writeFlags } from '../../../../shared/base-command.js';
import { resolveStorageBody } from '../../../../shared/confluence-body.js';
import { CliError, ConfigError, HttpError } from '../../../../core/errors.js';
import { formatKeyValue } from '../../../../shared/output.js';
import { pageIdForInstance } from '../../../../shared/atlassian-url.js';

interface Page {
  readonly id?: string;
  readonly title?: string;
  readonly type?: string;
  readonly version?: { readonly number?: number };
  readonly _links?: { readonly base?: string; readonly webui?: string };
}

function webUrl(page: Page): string | undefined {
  /* eslint-disable-next-line no-underscore-dangle -- Atlassian's field name */
  const links = page._links;
  if (links?.base === undefined || links.webui === undefined) return undefined;
  return `${links.base}${links.webui}`;
}

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
    const body = resolveStorageBody(this.flags);

    if (body === undefined && this.flags.title === undefined) {
      throw new ConfigError('Nothing to update. Pass --title, or a body with --text, --body, or --body-file.');
    }

    // Confluence requires both the next version number and the title on every update, even when
    // the title is unchanged, so the current state has to be read either way.
    const current = (await client.getPage(pageId, { expand: ['version'] })) as Page;
    const version = current.version?.number;
    if (typeof version !== 'number') {
      throw new CliError(`The instance reported no version for page ${pageId}, so it cannot be updated safely.`);
    }

    // 0008 covers pages. The instance decides what an id is, and echoing its answer back would
    // quietly make this a comment editor — which is explicitly deferred to a later doc.
    if (current.type !== undefined && current.type !== 'page') {
      throw new ConfigError(`${pageId} is a ${current.type}, not a page. This command only updates pages.`);
    }

    const payload: Record<string, unknown> = {
      type: 'page',
      title: this.flags.title ?? current.title,
      version: { number: version + 1 },
    };
    if (body !== undefined) payload.body = body;

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would update page ${pageId} from version ${version} to ${version + 1}:`);
      this.logSafe(JSON.stringify(payload, null, 2));
      return payload;
    }

    let updated: Page;
    try {
      updated = (await client.updateContent(pageId, payload)) as Page;
    } catch (error) {
      // 409 is the one failure worth naming: it means the page moved under us, which is a
      // different problem from a bad request and has a different fix — read it again and re-apply.
      // Only a version conflict gets the "someone else edited this" wording, and only because
      // its remedy is to re-run. Confluence answers 409 for other reasons too — a duplicate
      // title, for one — where re-running reproduces the same failure forever, which for an
      // agent is an infinite loop. So the instance's own reason is always carried through.
      if (error instanceof HttpError && error.status === 409 && /version/i.test(error.message)) {
        throw new CliError(
          `Page ${pageId} was changed by someone else while this ran (it is no longer at version ` +
            `${version}). Nothing was written. Re-run to apply your change on top of theirs.`,
        );
      }
      throw error;
    }

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
