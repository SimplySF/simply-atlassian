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
import { JiraCommand } from '../../../../shared/base-command.js';
import { formatKeyValue } from '../../../../shared/output.js';
import type { JiraChangelogEntry, JiraChangelogItem } from '../../../../core/jira-client.js';

const DEFAULT_LIMIT = 50;

export default class JiraIssueHistory extends JiraCommand<typeof JiraIssueHistory> {
  public static override readonly summary = 'Show an issue field-change history.';
  public static override readonly description =
    'Lists who changed which fields, when, and the previous and new values. History is grouped ' +
    'by changelog entry and rendered oldest first. Use --json for raw changelog entries and completeness metadata.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --field status',
    '<%= config.bin %> <%= command.id %> PROJ-123 --limit 10 --json',
  ];

  public static override readonly args = {
    issue: Args.string({
      description: 'Issue key, for example PROJ-123.',
      required: true,
    }),
  };

  public static override readonly flags = {
    limit: Flags.integer({
      summary: 'Maximum number of history entries to fetch.',
      default: DEFAULT_LIMIT,
      min: 1,
    }),
    field: Flags.string({
      summary: 'Only show entries that changed this field, case-insensitively.',
    }),
  };

  public async run(): Promise<unknown> {
    const result = await this.jira().getAllChangelog(this.args.issue, this.flags.limit);
    const field = normalizeField(this.flags.field);
    const entries = field === undefined ? result.entries : result.entries.filter((entry) => touchesField(entry, field));
    const visible = { ...result, entries };

    if (this.jsonEnabled()) {
      const rawEntries = field === undefined
        ? result.rawEntries
        : result.rawEntries.filter((_entry, index) => touchesField(result.entries[index], field));
      return { rawEntries, total: result.total, complete: result.complete };
    }

    if (!result.complete) {
      this.log('Warning: history is incomplete; Jira could not retrieve all changelog entries.');
    }

    if (entries.length === 0) {
      this.log(field === undefined ? 'No history entries found.' : `No history entries changed ${field}.`);
      return visible;
    }

    // Jira normally returns history oldest first; sorting makes the human contract explicit even
    // when an instance or proxy returns entries in another order.
    for (const entry of [...entries].sort(compareCreated)) {
      this.logSafe(`${displayValue(entry.created)} · ${displayValue(entry.author)}`);
      for (const item of entry.items) this.logSafe(formatChange(item));
    }

    return visible;
  }
}

function normalizeField(field: string | undefined): string | undefined {
  const normalized = field?.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

function touchesField(entry: JiraChangelogEntry, field: string): boolean {
  return entry.items.some((item) => item.field.toLowerCase() === field);
}

function compareCreated(left: JiraChangelogEntry, right: JiraChangelogEntry): number {
  return (left.created ?? '').localeCompare(right.created ?? '');
}

function formatChange(item: JiraChangelogItem): string {
  const change = `${displayValue(item.fromString ?? item.from)} → ${displayValue(item.toString ?? item.to)}`;
  return formatKeyValue([[item.field, change]]).replace(/^/, '  ');
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  const serialized = JSON.stringify(value);
  return serialized ?? '—';
}
