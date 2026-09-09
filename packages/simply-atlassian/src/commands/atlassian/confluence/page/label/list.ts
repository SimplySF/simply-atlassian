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
import { formatTable, pageIdForInstance } from '@simplysf/simply-atlassian-core';
import { ConfluenceCommand } from '../../../../../shared/base-command.js';

interface Label {
  readonly id?: string;
  readonly name?: string;
  readonly prefix?: string;
}

interface LabelsResponse {
  readonly results?: Label[];
  readonly size?: number;
}

export default class ConfluencePageLabelList extends ConfluenceCommand<typeof ConfluencePageLabelList> {
  public static override readonly summary = "List a page's labels.";
  public static override readonly description =
    'The PREFIX column is shown because Confluence namespaces labels — global, my, team — and ' +
    'the prefix is part of the identity, so two different labels can share a name.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 123456',
    '<%= config.bin %> <%= command.id %> 123456 --json',
  ];

  public static override readonly args = {
    page: Args.string({ description: 'Page id, or a page URL.', required: true }),
  };

  public static override readonly flags = {
    limit: Flags.integer({ summary: 'Maximum number of labels to show.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const pageId = pageIdForInstance(this.args.page, this.confluenceConfig().url);
    const response = (await this.confluence().getLabels(pageId, { limit: this.flags.limit })) as LabelsResponse;

    const labels = response.results ?? [];
    if (labels.length === 0) {
      this.logSafe(`No labels on page ${pageId}.`);
      return response;
    }

    this.log(
      formatTable(labels, [
        { header: 'NAME', value: (l: Label): string | undefined => l.name },
        { header: 'PREFIX', value: (l: Label): string | undefined => l.prefix },
      ]),
    );
    this.logSafe(`\n${labels.length} label(s).`);
    return response;
  }
}
