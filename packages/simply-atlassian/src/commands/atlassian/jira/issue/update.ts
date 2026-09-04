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
import { JiraCommand, writeFlags } from '../../../../shared/base-command.js';
import { mergeFields, parseBodyInput } from '../../../../shared/json-input.js';
import { formatKeyValue } from '../../../../shared/output.js';
import { ConfigError } from '../../../../core/errors.js';

interface Issue {
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly status?: { readonly name?: string };
    readonly assignee?: { readonly displayName?: string };
    readonly priority?: { readonly name?: string };
    readonly labels?: string[];
    readonly updated?: string;
  };
}

export default class JiraIssueUpdate extends JiraCommand<typeof JiraIssueUpdate> {
  public static override isWrite = true;

  public static override readonly summary = 'Update fields on a Jira issue.';
  public static override readonly description =
    'Common fields have flags; --body or --body-file supplies raw fields JSON for anything ' +
    'else, including custom fields. Jira answers an update with an empty 204, so the issue is ' +
    're-read afterwards and printed — silence is a poor confirmation that anything changed. ' +
    'Pass --no-verify to skip that second request.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123 --summary "Clearer title"',
    '<%= config.bin %> <%= command.id %> PROJ-123 --label triage --label urgent',
    '<%= config.bin %> <%= command.id %> PROJ-123 --body-file ./fields.json --dry-run',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    ...writeFlags,
    summary: Flags.string({ summary: 'New summary.' }),
    description: Flags.string({ summary: 'New description as plain text.' }),
    assignee: Flags.string({ summary: 'New assignee: account id on Cloud, username on Server/DC.' }),
    priority: Flags.string({ summary: 'New priority name.' }),
    label: Flags.string({ summary: 'Label to set. Repeatable, and replaces the existing labels.', multiple: true }),
    body: Flags.string({ summary: 'Raw JSON request body.', exclusive: ['body-file'] }),
    'body-file': Flags.string({ summary: 'Path to a file holding the raw JSON request body.' }),
    verify: Flags.boolean({
      summary: 'Re-read the issue after updating and print it.',
      default: true,
      allowNo: true,
    }),
  };

  public async run(): Promise<unknown> {
    const client = this.jira();
    const { issue } = this.args;

    const fields: Record<string, unknown> = {};
    if (this.flags.summary !== undefined) fields.summary = this.flags.summary;
    if (this.flags.description !== undefined) fields.description = client.descriptionValue(this.flags.description);
    if (this.flags.assignee !== undefined) {
      fields.assignee =
        this.jiraConfig().deployment === 'cloud' ? { id: this.flags.assignee } : { name: this.flags.assignee };
    }
    if (this.flags.priority !== undefined) fields.priority = { name: this.flags.priority };
    if (this.flags.label !== undefined) fields.labels = this.flags.label;

    const body = mergeFields(parseBodyInput(this.flags.body, this.flags['body-file']), fields);
    if (Object.keys(body.fields as Record<string, unknown>).length === 0) {
      throw new ConfigError(`Nothing to update on ${issue}. Pass a field flag, or a body.`);
    }

    if (this.flags['dry-run']) {
      this.log('Dry run — not sent. Request body:');
      this.log(JSON.stringify(body, null, 2));
      return body;
    }

    await client.updateIssue(issue, body);

    if (!this.flags.verify) {
      this.log(`Updated ${issue}.`);
      return { issue, updated: true };
    }

    // The write already succeeded. If reading it back fails — a token that can write but not
    // browse, an issue that moved projects mid-call — saying so beats reporting a failure the
    // caller would then retry.
    let updated: Issue;
    try {
      updated = (await client.getIssue(issue)) as Issue;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown reason';
      // The reason quotes a server response body, so it goes out sanitised.
      this.logSafe(`Updated ${issue}. Could not re-read it to verify: ${reason}`);
      return { issue, updated: true, verified: false };
    }

    const f = updated.fields ?? {};
    this.log(`Updated ${issue}.`);
    this.log(
      formatKeyValue([
        ['Summary', f.summary],
        ['Status', f.status?.name],
        ['Assignee', f.assignee?.displayName],
        ['Priority', f.priority?.name],
        ['Labels', f.labels?.length === 0 ? undefined : f.labels?.join(', ')],
        ['Updated', f.updated],
      ]),
    );
    return updated;
  }
}
