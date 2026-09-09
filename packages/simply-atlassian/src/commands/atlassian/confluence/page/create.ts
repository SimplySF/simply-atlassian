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
import { formatKeyValue, pageIdForInstance, resolveStorageBody } from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand, writeFlags } from '../../../../shared/base-command.js';

interface CreatedPage {
  readonly id?: string;
  readonly title?: string;
  readonly version?: { readonly number?: number };
  readonly _links?: { readonly base?: string; readonly webui?: string };
}

/** Confluence returns the browser URL split across two fields. */
function webUrl(page: CreatedPage): string | undefined {
  /* eslint-disable-next-line no-underscore-dangle -- Atlassian's field name */
  const links = page._links;
  if (links?.base === undefined || links.webui === undefined) return undefined;
  return `${links.base}${links.webui}`;
}

export default class ConfluencePageCreate extends ConfluenceCommand<typeof ConfluencePageCreate> {
  public static override isWrite = true;

  public static override readonly summary = 'Create a Confluence page.';
  public static override readonly description =
    'The body is Confluence storage format — XHTML plus Atlassian macro tags — supplied with ' +
    '--body or --body-file. Markdown input is not supported yet; --text is the shortcut for ' +
    'plain prose, which becomes paragraphs with its markup characters escaped. Use --parent to ' +
    'place the page under another rather than at the space root, and --dry-run to see the exact ' +
    'request without sending it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --space DOCS --title "Release notes" --text "Shipped today."',
    '<%= config.bin %> <%= command.id %> --space DOCS --title "Design" --body-file ./page.xml --parent 123456',
    '<%= config.bin %> <%= command.id %> --space DOCS --title "Draft" --text "wip" --dry-run',
  ];

  public static override readonly flags = {
    ...writeFlags,
    space: Flags.string({ summary: 'Space key the page belongs to.', required: true }),
    title: Flags.string({ summary: 'Page title.', required: true }),
    parent: Flags.string({
      summary: 'Parent page id or URL, making this a child of it.',
      description: 'Without this the page lands at the space root. A page URL is accepted as well as a bare id.',
    }),
    text: Flags.string({ summary: 'Body as plain text; becomes paragraphs, markup escaped.' }),
    body: Flags.string({ summary: 'Body as raw storage-format XHTML.' }),
    'body-file': Flags.string({ summary: 'Path to a file holding storage-format XHTML.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.confluence();
    const body = resolveStorageBody(this.flags);

    const payload: Record<string, unknown> = {
      type: 'page',
      title: this.flags.title,
      space: { key: this.flags.space },
      // A page with no body is legitimate — a placeholder someone fills in later — so an absent
      // body is an empty one rather than an error.
      body: body ?? { storage: { value: '', representation: 'storage' } },
    };
    if (this.flags.parent !== undefined) {
      payload.ancestors = [{ id: pageIdForInstance(this.flags.parent, this.confluenceConfig().url) }];
    }

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      this.logSafe(JSON.stringify(payload, null, 2));
      return payload;
    }

    const created = (await client.createContent(payload)) as CreatedPage;
    this.log(
      formatKeyValue([
        ['Created', created.id],
        ['Title', created.title],
        ['Version', created.version?.number],
        ['URL', webUrl(created)],
      ]),
    );
    return created;
  }
}
