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
import { getWorkItem, type WorkItemView } from '@simplysf/simply-atlassian-core';
import { WorkCommand } from '../../../../shared/base-command.js';

export default class JiraWorkGet extends WorkCommand<typeof JiraWorkGet> {
  public static override readonly summary = 'Read a work item: a Jira issue and its linked Confluence page.';
  public static override readonly description =
    "A work item is shaped by the project's config (.simply/atlassian.json): which fields the issue " +
    'has and what belongs in each, and what its page holds. Pass the issue key, or --page for the ' +
    'page — the other half is found through the link between them — or neither, to see the empty ' +
    'shape for a new idea. The revisions printed are what "work save" needs as basedOn, so every ' +
    'save builds on a read.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> PAY-412',
    '<%= config.bin %> <%= command.id %> --page 987654 --json',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key of the work item, for example PAY-412.' }),
  };

  public static override readonly flags = {
    page: Flags.string({ summary: 'Page id or URL of the work item, instead of the issue key.' }),
  };

  public async run(): Promise<WorkItemView> {
    const item = await getWorkItem(this.workContext(), { issue: this.args.issue, page: this.flags.page });
    this.logSafe(renderItem(item));
    return item;
  }
}

/** The pair as text: each field under its name, then the page. JSON carries everything else. */
export function renderItem(item: WorkItemView): string {
  const lines: string[] = [];
  const issue = item.issue;
  lines.push(
    issue.key === undefined
      ? 'New work item (nothing saved yet). Fields:'
      : `${issue.key} [${issue.status ?? 'unknown status'}] ${issue.url ?? ''}\nrevision: ${issue.revision ?? ''}`,
  );
  for (const field of issue.fields) {
    const flags = [field.required === true ? 'required' : '', field.always === true ? 'fixed' : '']
      .filter((flag) => flag !== '')
      .join(', ');
    lines.push('', `## ${field.name}${flags === '' ? '' : ` (${flags})`}`);
    if (field.description !== undefined) lines.push(`> ${field.description}`);
    lines.push(formatValue(field.value, field.display));
    if (field.lossy !== undefined) lines.push(`(holds ${field.lossy.join(', ')}, which Markdown cannot carry)`);
  }
  if (item.page !== undefined) {
    lines.push('', '---', '');
    if (item.page.id === undefined) {
      lines.push(`No page. ${item.page.when ?? ''}`.trim());
    } else {
      lines.push(
        `Page ${item.page.id}: ${item.page.title ?? ''} ${item.page.url ?? ''}`,
        `revision: ${item.page.revision ?? ''}`,
      );
      if (item.page.lossy !== undefined)
        lines.push(`(holds ${item.page.lossy.join(', ')}, which Markdown cannot carry)`);
      lines.push('', item.page.markdown ?? '');
    }
  }
  if (item.missingRequired.length > 0) lines.push('', `Missing: ${item.missingRequired.join('; ')}`);
  return lines.join('\n');
}

function formatValue(value: unknown, display: string | undefined): string {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return '(empty)';
  if (typeof value === 'string') return display === undefined ? value : `${value} (${display})`;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return JSON.stringify(value);
}
