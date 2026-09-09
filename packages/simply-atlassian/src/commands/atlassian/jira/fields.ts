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

import { Flags } from '@oclif/core';
import { fieldType, formatTable, listFields, type JiraField } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../shared/base-command.js';

export default class JiraFields extends JiraCommand<typeof JiraFields> {
  public static override readonly summary = 'List Jira fields, including custom field ids.';
  public static override readonly description =
    'This is what makes --body usable on issue create and update. A custom field is addressed by ' +
    'an id like customfield_10016, which differs between instances and cannot be guessed — so ' +
    'without this command the escape hatch for untyped fields is unusable by anyone who has not ' +
    'read it off an admin screen. --search matches the name or the id, so it answers both "what ' +
    'is Story Points called" and "what is customfield_10016".';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --custom',
    '<%= config.bin %> <%= command.id %> --search "story points"',
    '<%= config.bin %> <%= command.id %> --search customfield_10016 --json',
  ];

  public static override readonly flags = {
    custom: Flags.boolean({ summary: 'Only custom fields.', default: false }),
    search: Flags.string({ summary: 'Match against the field name or id, case-insensitively.' }),
    limit: Flags.integer({ summary: 'Maximum number of fields to show.', default: 50, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const fields = await listFields(this.jira(), {
      custom: this.flags.custom ? true : undefined,
      search: this.flags.search,
    });

    if (fields.length === 0) {
      const qualifier = this.flags.search === undefined ? '' : ` matching "${this.flags.search}"`;
      this.logSafe(`No ${this.flags.custom ? 'custom ' : ''}fields${qualifier}.`);
      return fields;
    }

    const shown = fields.slice(0, this.flags.limit);
    this.log(
      formatTable(shown, [
        { header: 'ID', value: (f: JiraField): string | undefined => f.id },
        { header: 'NAME', value: (f: JiraField): string | undefined => f.name },
        { header: 'CUSTOM', value: (f: JiraField): string => (f.custom === true ? 'yes' : 'no') },
        { header: 'TYPE', value: (f: JiraField): string | undefined => fieldType(f) },
      ]),
    );

    const scope = shown.length === fields.length ? '' : ` of ${fields.length}`;
    this.logSafe(`\nShowing ${shown.length}${scope} field(s).`);
    return fields;
  }
}
