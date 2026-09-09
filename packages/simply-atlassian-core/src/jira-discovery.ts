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

import type { JiraClient } from './jira-client.js';

/** A field as the instance reports it. */
export interface JiraField {
  readonly id?: string;
  readonly name?: string;
  readonly custom?: boolean;
  readonly schema?: { readonly type?: string; readonly custom?: string };
}

export interface FieldFilter {
  /** Only custom fields — the ones a caller cannot guess and actually needs this command for. */
  readonly custom?: boolean;
  /** Case-insensitive substring match against the field's name or its id. */
  readonly search?: string;
}

/**
 * Lists fields, filtered.
 *
 * This exists because `issue create --body` is the escape hatch for anything without a typed flag,
 * and it is unusable without knowing that "Story Points" is `customfield_10016` on this instance
 * and something else on the next one. A person can read that off an admin screen; the caller this
 * tool is built for cannot.
 *
 * The id is matched as well as the name, so a caller who has seen `customfield_10016` in a payload
 * can find out what it is — which is the other half of the same problem.
 */
export async function listFields(client: JiraClient, filter: FieldFilter = {}): Promise<JiraField[]> {
  const response = (await client.getFields()) as JiraField[] | { values?: JiraField[] };
  const all = Array.isArray(response) ? response : (response.values ?? []);

  const wanted = filter.search?.trim().toLowerCase();
  return all.filter((field) => {
    if (filter.custom === true && field.custom !== true) return false;
    if (wanted === undefined || wanted === '') return true;
    return (field.name ?? '').toLowerCase().includes(wanted) || (field.id ?? '').toLowerCase().includes(wanted);
  });
}

/** The schema type a field holds, which is what tells a caller the shape `--body` needs. */
export function fieldType(field: JiraField): string | undefined {
  return field.schema?.type;
}
