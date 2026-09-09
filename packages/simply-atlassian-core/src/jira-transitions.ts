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
import type { JiraClient } from './jira-client.js';
import { mergeFields } from './json-input.js';
import { stripControlOneLine } from './text.js';

/** A transition as the instance reports it. */
export interface Transition {
  readonly id?: string;
  readonly name?: string;
  readonly to?: { readonly name?: string };
}

export interface TransitionsResponse {
  readonly transitions?: Transition[];
}

export interface TransitionInput {
  /** Comment to add as part of the transition. */
  readonly comment?: string;
  /** A raw request body; `fields` and `update` in it are kept, `transition` is set here. */
  readonly body?: Record<string, unknown>;
}

/** How many transitions an error lists before summarising the rest. */
const MAX_LISTED = 20;

/**
 * Turns a transition id or name into an id, matching a name case-insensitively against what
 * the workflow currently offers and saying what is available when it cannot. A digits-only
 * argument is taken as an id unless `byName` says otherwise, which is what makes a workflow
 * step literally named "41" reachable.
 */
export async function resolveTransitionId(
  client: JiraClient,
  issue: string,
  transition: string,
  options: { readonly byName?: boolean } = {},
): Promise<string> {
  const looksLikeId = options.byName !== true && /^\d+$/.test(transition);
  return looksLikeId ? transition : resolveByName(client, issue, transition);
}

/** Matches a name against what the workflow currently offers, and says so when it cannot. */
async function resolveByName(client: JiraClient, issue: string, name: string): Promise<string> {
  const response = (await client.getTransitions(issue)) as TransitionsResponse;
  const available = response.transitions ?? [];
  const wanted = name.trim().toLowerCase();
  const matches = available.filter((t) => t.name?.trim().toLowerCase() === wanted);

  // Workflow and status names are instance-supplied, so each is kept to one line: this string
  // is interpolated into an error whose own newlines survive, and a name carrying one would
  // forge a stderr line indistinguishable from the CLI's error object. Capped for the same
  // reason the candidate lists elsewhere are: an instance with many transitions should not
  // dump all of them into a caller's context.
  const shown = available.slice(0, MAX_LISTED);
  const listing =
    shown
      .map((t) => {
        const label = stripControlOneLine(t.name ?? '?');
        const id = stripControlOneLine(t.id ?? '?');
        const to = t.to?.name === undefined ? '' : ` -> ${stripControlOneLine(t.to.name)}`;
        return `${label} (id ${id}${to})`;
      })
      .join(', ') + (available.length > shown.length ? `, and ${available.length - shown.length} more` : '');

  // Turning the most common failure into a self-correcting one matters most for an agent,
  // which can retry with a name from this list rather than guessing again.
  if (matches.length === 0) {
    throw new ConfigError(
      `No transition named "${name}" is available for ${issue}.` +
        (listing === '' ? ' The issue has no available transitions.' : ` Available: ${listing}.`),
    );
  }
  if (matches.length === 1) {
    const matched = matches[0]?.id;
    // Matched unambiguously but the instance gave no id, which is not the caller's problem
    // to disambiguate — say what actually happened.
    if (matched === undefined) {
      throw new ConfigError(
        `The instance reported no id for transition "${name}" on ${issue}, so it cannot be applied.`,
      );
    }
    return matched;
  }
  throw new ConfigError(
    `"${name}" matches more than one transition for ${issue}. Pass an id instead. Available: ${listing}.`,
  );
}

/**
 * Assembles the transition request. A comment is pushed into any existing `update` block rather
 * than replacing it, so a caller can combine a comment with other operations supplied in the
 * raw body.
 */
export function buildTransitionBody(client: JiraClient, id: string, input: TransitionInput): Record<string, unknown> {
  const body = mergeFields(input.body, {});
  // `fields` is only meaningful here if the caller supplied some; an empty object confuses Jira.
  if (Object.keys(body.fields as Record<string, unknown>).length === 0) delete body.fields;
  body.transition = { id };

  if (input.comment !== undefined) {
    const existing = body.update;
    const update: Record<string, unknown> =
      typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    const comments = Array.isArray(update.comment) ? [...(update.comment as unknown[])] : [];
    comments.push({ add: { body: client.descriptionValue(input.comment) } });
    update.comment = comments;
    body.update = update;
  }
  return body;
}
