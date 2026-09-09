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
import { formatKeyValue, pageIdForInstance } from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand, writeFlags } from '../../../../../shared/base-command.js';

export default class ConfluencePageLabelAdd extends ConfluenceCommand<typeof ConfluencePageLabelAdd> {
  public static override isWrite = true;

  public static override readonly summary = 'Add labels to a page.';
  public static override readonly description =
    'Labels are additive and idempotent: adding one the page already has is not an error, and ' +
    'this reports what the page carries afterwards rather than implying everything was new. No ' +
    '--confirm, because adding a label loses nothing.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456 --label runbook',
    '<%= config.bin %> <%= command.id %> 123456 --label runbook --label on-call',
    '<%= config.bin %> <%= command.id %> 123456 --label draft --dry-run',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    label: Flags.string({ summary: 'Label to add. Repeatable.', multiple: true, required: true }),
    prefix: Flags.string({
      summary: 'Label namespace.',
      description: 'Confluence namespaces labels; global is what the UI applies and what you almost always want.',
      default: 'global',
    }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);
    // Posted as one request rather than one per label: the endpoint takes an array, and a partial
    // failure across several requests would leave the page in a state nobody asked for.
    const payload = this.flags.label.map((name) => ({ prefix: this.flags.prefix, name }));

    if (this.flags['dry-run']) {
      this.log(`Dry run — not sent. Would add ${payload.length} label(s) to page ${pageId}:`);
      this.logSafe(JSON.stringify(payload, null, 2));
      return payload;
    }

    const result = (await this.confluence().addLabels(pageId, payload)) as { results?: Array<{ name?: string }> };
    const now = (result.results ?? []).map((l) => l.name).filter((n): n is string => n !== undefined);
    this.log(
      formatKeyValue([
        ['Page', pageId],
        ['Added', this.flags.label.join(', ')],
        ['Labels now', now.length === 0 ? undefined : now.join(', ')],
      ]),
    );
    return result;
  }
}
