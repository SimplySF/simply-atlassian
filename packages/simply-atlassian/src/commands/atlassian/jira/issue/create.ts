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
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';
import { mergeFields, parseBodyInput } from '../../../../shared/json-input.js';
import { formatKeyValue } from '../../../../shared/output.js';
import { ConfigError } from '../../../../core/errors.js';

interface CreatedIssue {
  readonly key?: string;
  readonly id?: string;
  readonly self?: string;
}

export default class JiraIssueCreate extends JiraCommand<typeof JiraIssueCreate> {
  public static override isWrite = true;

  public static override readonly summary = 'Create a Jira issue.';
  public static override readonly description =
    'Common fields have flags; --body or --body-file supplies raw fields JSON for anything ' +
    'else, including custom fields. Typed flags are merged over the body, so a template file ' +
    'can provide the shape and a flag can override one value. Use --dry-run to see exactly ' +
    'what would be sent without sending it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --project PROJ --type Task --summary "Fix the thing"',
    '<%= config.bin %> <%= command.id %> --project PROJ --type Bug --summary "Crash" --label urgent --label triage',
    '<%= config.bin %> <%= command.id %> --body-file ./issue.json --dry-run',
  ];

  public static override readonly flags = {
    ...writeFlags,
    project: Flags.string({ summary: 'Project key the issue belongs to.' }),
    type: Flags.string({ summary: 'Issue type name, for example Task or Bug.' }),
    summary: Flags.string({ summary: 'Issue summary.' }),
    description: Flags.string({ summary: 'Issue description as plain text.' }),
    assignee: Flags.string({ summary: 'Assignee: account id on Cloud, username on Server/DC.' }),
    priority: Flags.string({ summary: 'Priority name.' }),
    label: Flags.string({ summary: 'Label to apply. Repeatable.', multiple: true }),
    body: Flags.string({ summary: 'Raw JSON request body.', exclusive: ['body-file'] }),
    'body-file': Flags.string({ summary: 'Path to a file holding the raw JSON request body.' }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();

    const fields: Record<string, unknown> = {};
    if (this.flags.project !== undefined) fields.project = { key: this.flags.project };
    if (this.flags.type !== undefined) fields.issuetype = { name: this.flags.type };
    if (this.flags.summary !== undefined) fields.summary = this.flags.summary;
    if (this.flags.description !== undefined) fields.description = client.descriptionValue(this.flags.description);
    if (this.flags.assignee !== undefined)
      fields.assignee = assigneeValue(this.flags.assignee, this.jiraConfig().deployment);
    if (this.flags.priority !== undefined) fields.priority = { name: this.flags.priority };
    if (this.flags.label !== undefined) fields.labels = this.flags.label;

    const body = mergeFields(parseBodyInput(this.flags.body, this.flags['body-file']), fields);
    const requested = body.fields as Record<string, unknown>;
    if (Object.keys(requested).length === 0) {
      throw new ConfigError('Nothing to create. Pass at least --project, --type and --summary, or a body.');
    }

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      this.log(JSON.stringify(body, null, 2));
      return body;
    }

    const created = (await client.createIssue(body)) as CreatedIssue;
    this.log(
      formatKeyValue([
        ['Created', created.key],
        ['ID', created.id],
        ['URL', browseUrl(created)],
      ]),
    );
    return created;
  }
}

/** Cloud identifies an account by id; Server/DC by name. */
function assigneeValue(value: string, deployment: string): Record<string, string> {
  return deployment === 'cloud' ? { id: value } : { name: value };
}

/** The API returns its own self link; the browse URL is what a person can actually open. */
function browseUrl(issue: CreatedIssue): string | undefined {
  if (issue.self === undefined || issue.key === undefined) return undefined;
  try {
    return `${new URL(issue.self).origin}/browse/${issue.key}`;
  } catch {
    return undefined;
  }
}
