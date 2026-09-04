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
import { JiraCommand, parseList } from '../../../shared/base-command.js';
import { formatKeyValue, stripControl } from '../../../shared/output.js';

interface IssueFields {
  readonly summary?: string;
  readonly status?: { readonly name?: string };
  readonly issuetype?: { readonly name?: string };
  readonly priority?: { readonly name?: string };
  readonly assignee?: { readonly displayName?: string };
  readonly reporter?: { readonly displayName?: string };
  readonly created?: string;
  readonly updated?: string;
  readonly labels?: string[];
  readonly description?: unknown;
}

interface Issue {
  readonly key?: string;
  readonly fields?: IssueFields;
}

/** ADF nodes whose children are inline runs of one line: their parts join without a break. */
const INLINE_CONTAINERS = new Set(['paragraph', 'heading', 'codeBlock', 'tableCell', 'tableHeader']);

/**
 * Jira Cloud returns descriptions as an Atlassian Document Format tree; Server/DC returns a
 * string. Walking ADF's `content` nodes for their text is enough for a terminal read, and keeps
 * the human view useful on both deployments. `--json` still carries the untouched original.
 *
 * The separator matters: a paragraph's children are inline fragments split by formatting marks,
 * so joining them with a newline would break "Deploy **now** please." across three lines.
 * Inline containers join with nothing; block containers separate with a blank line.
 */
function describeText(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  // Deeply nested trees are pathological rather than useful; stop instead of overflowing.
  if (value === null || typeof value !== 'object' || depth > 24) return undefined;

  const node = value as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (!Array.isArray(node.content)) return undefined;

  const parts = node.content
    .map((child) => describeText(child, depth + 1))
    .filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;

  const separator = typeof node.type === 'string' && INLINE_CONTAINERS.has(node.type) ? '' : '\n\n';
  return parts.join(separator);
}

export default class JiraIssueView extends JiraCommand<typeof JiraIssueView> {
  public static override readonly summary = 'Show a single Jira issue.';
  public static override readonly description =
    'Prints a curated set of fields for one issue. Use --json for the complete, unmodified API ' +
    'payload, and --fields to control which fields the instance returns.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --json',
    '<%= config.bin %> <%= command.id %> PROJ-123 --fields summary,status,assignee',
  ];

  public static override readonly args = {
    issue: Args.string({
      description: 'Issue key, for example PROJ-123.',
      required: true,
    }),
  };

  public static override readonly flags = {
    fields: Flags.string({
      summary: 'Comma-separated field names to request instead of the instance default.',
    }),
    expand: Flags.string({
      summary: 'Comma-separated Jira expand parameters (for example changelog).',
    }),
  };

  public async run(): Promise<unknown> {
    const issue = (await this.jira().getIssue(this.args.issue, {
      fields: parseList(this.flags.fields),
      expand: this.flags.expand,
    })) as Issue;

    const fields = issue.fields ?? {};
    this.log(
      formatKeyValue([
        ['Key', issue.key],
        ['Summary', fields.summary],
        ['Status', fields.status?.name],
        ['Type', fields.issuetype?.name],
        ['Priority', fields.priority?.name],
        ['Assignee', fields.assignee?.displayName],
        ['Reporter', fields.reporter?.displayName],
        ['Labels', fields.labels?.length === 0 ? undefined : fields.labels?.join(', ')],
        ['Created', fields.created],
        ['Updated', fields.updated],
      ]),
    );

    const description = describeText(fields.description);
    // Multi-line by design, so newlines survive, but control sequences must not.
    if (description !== undefined) this.log(`\nDescription:\n${stripControl(description)}`);

    return issue;
  }
}
