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

import { CliError, ConfigError } from './errors.js';
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

/** What a sprint create or update accepts. Dates are ISO-8601, as Jira returns them. */
export interface SprintInput {
  readonly name?: string;
  readonly goal?: string;
  readonly start?: string;
  readonly end?: string;
  readonly state?: string;
}

/** A sprint as the instance reports it. */
export interface Sprint {
  readonly id?: number | string;
  readonly name?: string;
  readonly state?: string;
  readonly goal?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly originBoardId?: number | string;
}

const SPRINT_STATES = new Set(['future', 'active', 'closed']);

/** Jira's own field names, which differ from the flags a person would type. */
function sprintPayload(input: SprintInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name;
  if (input.goal !== undefined) payload.goal = input.goal;
  if (input.start !== undefined) payload.startDate = input.start;
  if (input.end !== undefined) payload.endDate = input.end;
  if (input.state !== undefined) payload.state = input.state;
  return payload;
}

export function buildSprintCreateBody(boardId: string, input: SprintInput): Record<string, unknown> {
  if (input.name === undefined || input.name.trim() === '') {
    throw new ConfigError('A sprint needs a --name.');
  }
  assertState(input.state);
  return { ...sprintPayload(input), originBoardId: Number(boardId) };
}

/**
 * Merges an update onto the sprint's current state.
 *
 * `POST /sprint/{id}` is a full replacement: Jira clears any field the request omits, so sending
 * only `--name` would blank the goal and the dates. The sprint is read first and the caller's
 * changes applied on top — the same fetch-then-write shape as `page update` in 0008, for the same
 * reason, and the read is what makes a partial flag set safe.
 */
export async function prepareSprintUpdate(
  client: JiraClient,
  sprintId: string,
  input: SprintInput,
): Promise<Record<string, unknown>> {
  assertState(input.state);
  if (Object.keys(sprintPayload(input)).length === 0) {
    throw new ConfigError('Nothing to update. Pass --name, --goal, --start, --end, or --state.');
  }

  const current = (await client.getSprint(sprintId)) as Sprint;
  if (current.name === undefined) {
    throw new CliError(`The instance reported no name for sprint ${sprintId}, so it cannot be updated safely.`);
  }

  return {
    name: input.name ?? current.name,
    ...(current.goal === undefined ? {} : { goal: current.goal }),
    ...(current.startDate === undefined ? {} : { startDate: current.startDate }),
    ...(current.endDate === undefined ? {} : { endDate: current.endDate }),
    ...(current.state === undefined ? {} : { state: current.state }),
    ...sprintPayload(input),
  };
}

function assertState(state: string | undefined): void {
  if (state !== undefined && !SPRINT_STATES.has(state)) {
    throw new ConfigError(`Sprint state must be one of ${[...SPRINT_STATES].join(', ')}; got "${state}".`);
  }
}
