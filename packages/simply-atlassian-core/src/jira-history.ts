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

import type { JiraChangelogEntry, JiraChangelogResult } from './jira-client.js';

/** The raw entries and completeness metadata `issue history --json` reports. */
export interface ChangelogJson {
  readonly rawEntries: readonly unknown[];
  readonly total: number | undefined;
  readonly complete: boolean;
}

/** Lower-cased and trimmed, with an empty filter meaning no filter. */
export function normalizeField(field: string | undefined): string | undefined {
  const normalized = field?.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

/** Whether an entry changed the (already normalised) field. */
export function touchesField(entry: JiraChangelogEntry, field: string): boolean {
  return entry.items.some((item) => item.field.toLowerCase() === field);
}

/**
 * Jira normally returns history oldest first; sorting makes the contract explicit even when an
 * instance or proxy returns entries in another order.
 */
export function compareCreated(left: JiraChangelogEntry, right: JiraChangelogEntry): number {
  return (left.created ?? '').localeCompare(right.created ?? '');
}

/**
 * Narrows a changelog to the entries that touched one field, keeping the normalised and raw
 * views aligned by index so a caller can render either.
 */
export function filterChangelog(result: JiraChangelogResult, field: string | undefined): JiraChangelogResult {
  const wanted = normalizeField(field);
  if (wanted === undefined) return result;
  const keep = result.entries.map((entry) => touchesField(entry, wanted));
  return {
    ...result,
    entries: result.entries.filter((_entry, index) => keep[index]),
    rawEntries: result.rawEntries.filter((_entry, index) => keep[index]),
  };
}

/** The machine-readable view: raw entries plus whether Jira could retrieve them all. */
export function changelogJson(result: JiraChangelogResult): ChangelogJson {
  return { rawEntries: result.rawEntries, total: result.total, complete: result.complete };
}
