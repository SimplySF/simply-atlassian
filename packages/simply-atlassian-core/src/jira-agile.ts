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

import { ConfigError } from './errors.js';
import { type JiraClient, MAX_ISSUES_PER_SPRINT_MOVE } from './jira-client.js';

/** What `sprint add` reports: the payload it would send, and after sending, how it was sent. */
export type SprintAddResult =
  | { readonly sprint: string; readonly issues: readonly string[] }
  | {
      readonly sprint: string;
      readonly issues: readonly string[];
      readonly chunks: number;
      readonly issueCount: number;
    };

/**
 * Board and sprint ids are numeric, and names are deliberately not resolved: a board name is
 * neither unique nor stable, so "use `board list` first" is the honest answer.
 */
export function numericId(label: string, value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${label} id must be numeric; Jira agile commands do not resolve names yet: ${value}`);
  }
  return value;
}

/** How many issues each request carries when `count` issues are moved, for reporting progress. */
export function sprintChunkSizes(count: number): number[] {
  const sizes: number[] = [];
  for (let sent = 0; sent < count; sent += MAX_ISSUES_PER_SPRINT_MOVE) {
    sizes.push(Math.min(MAX_ISSUES_PER_SPRINT_MOVE, count - sent));
  }
  return sizes;
}

/**
 * Moves issues into a sprint. Jira accepts at most 50 keys per request, so larger lists are sent
 * in chunks by the client; adding to a sprint is reversible and needs no confirmation.
 */
export async function addIssuesToSprint(
  client: JiraClient,
  sprintId: string,
  issues: readonly string[],
  options: { readonly dryRun?: boolean } = {},
): Promise<SprintAddResult> {
  const sprint = numericId('Sprint', sprintId);
  if (options.dryRun === true) return { sprint, issues };
  const result = await client.moveIssuesToSprint(sprint, issues);
  return { sprint, issues, ...result };
}
