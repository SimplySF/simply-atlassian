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

import { Args } from '@oclif/core';
import { describeAttachment, formatBytes, formatTable, type JiraAttachment } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../../../shared/base-command.js';

export default class JiraIssueAttachmentList extends JiraCommand<typeof JiraIssueAttachmentList> {
  public static override readonly summary = "List an issue's attachments.";
  public static override readonly description =
    'Shows each file attached to the issue, in upload order. The ID column is what "attachment ' +
    'download --id" takes. --json returns the instance\'s own attachment objects, which include the ' +
    'exact byte count.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public async run(): Promise<unknown[]> {
    const raw = await this.jira().getAttachments(this.args.issue);
    if (raw.length === 0) {
      this.logSafe(`No attachments on ${this.args.issue}.`);
      return raw;
    }

    const rows = raw.map((attachment) => describeAttachment(attachment));
    this.log(
      formatTable(rows, [
        { header: 'ID', value: (r: JiraAttachment): string => r.id },
        { header: 'FILENAME', value: (r: JiraAttachment): string => r.filename },
        { header: 'SIZE', value: (r: JiraAttachment): string | undefined => formatBytes(r.size) },
        { header: 'TYPE', value: (r: JiraAttachment): string | undefined => r.mimeType },
        { header: 'AUTHOR', value: (r: JiraAttachment): string | undefined => r.author },
        { header: 'CREATED', value: (r: JiraAttachment): string | undefined => r.created?.slice(0, 10) },
      ]),
    );
    this.logSafe(`\n${raw.length} attachment(s).`);
    return raw;
  }
}
