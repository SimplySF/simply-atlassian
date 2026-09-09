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

import { isIssueKey } from './atlassian-url.js';
import type { Deployment } from './config.js';
import { ConfigError } from './errors.js';
import type { JiraClient } from './jira-client.js';
import { mergeFields } from './json-input.js';

/** The typed fields `issue create` and `issue update` both accept. */
export interface IssueFieldInput {
  readonly summary?: string;
  /** Plain text; converted to the shape the deployment expects (ADF on Cloud). */
  readonly description?: string;
  /** Account id on Cloud, username on Server/DC. */
  readonly assignee?: string;
  readonly priority?: string;
  readonly labels?: readonly string[];
  /** A raw request body the typed fields are merged over. */
  readonly body?: Record<string, unknown>;
}

export interface CreateIssueInput extends IssueFieldInput {
  readonly project?: string;
  readonly type?: string;
  /** Parent issue key, making this a subtask of it. */
  readonly parent?: string;
}

export type UpdateIssueInput = IssueFieldInput;

export interface DeleteIssueInput {
  readonly issue: string;
  readonly deleteSubtasks?: boolean;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
}

/** What a delete reports: either what would have happened, or that it did. */
export type DeleteIssueResult =
  | { readonly issue: string; readonly deleteSubtasks: boolean; readonly dryRun: true }
  | { readonly issue: string; readonly deleted: true };

/** The outcome of reading an issue back after a write that Jira answered with an empty 204. */
export type IssueReadBack =
  { readonly ok: true; readonly issue: unknown } | { readonly ok: false; readonly reason: string };

/** Refuses anything that is not shaped like an issue key, naming an example. */
export function assertIssueKey(value: string): string {
  if (!isIssueKey(value)) {
    throw new ConfigError(`"${value}" is not an issue key. Pass a key such as PROJ-123.`);
  }
  return value;
}

/** Cloud identifies an account by id; Server/DC by name. */
function assigneeValue(value: string, deployment: Deployment): Record<string, string> {
  return deployment === 'cloud' ? { id: value } : { name: value };
}

/** The fields both writes share, in the order they are assembled, so a dry run reads the same for each. */
function commonFields(client: JiraClient, input: IssueFieldInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) fields.description = client.descriptionValue(input.description);
  if (input.assignee !== undefined) fields.assignee = assigneeValue(input.assignee, client.deployment);
  if (input.priority !== undefined) fields.priority = { name: input.priority };
  if (input.labels !== undefined) fields.labels = [...input.labels];
  return fields;
}

/**
 * Assembles the request body for a new issue: typed inputs merged over a raw body, the typed
 * ones winning. Refuses an empty request rather than letting Jira explain a 400 in its own words.
 */
export function buildCreateIssueBody(client: JiraClient, input: CreateIssueInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.project !== undefined) fields.project = { key: input.project };
  if (input.type !== undefined) fields.issuetype = { name: input.type };
  if (input.parent !== undefined) fields.parent = { key: input.parent };
  Object.assign(fields, commonFields(client, input));

  const body = mergeFields(input.body, fields);
  if (Object.keys(body.fields as Record<string, unknown>).length === 0) {
    throw new ConfigError('Nothing to create. Pass at least --project, --type and --summary, or a body.');
  }
  return body;
}

/** Assembles the request body for an update; the same merge rule as a create. */
export function buildUpdateIssueBody(
  client: JiraClient,
  issue: string,
  input: UpdateIssueInput,
): Record<string, unknown> {
  const body = mergeFields(input.body, commonFields(client, input));
  if (Object.keys(body.fields as Record<string, unknown>).length === 0) {
    throw new ConfigError(`Nothing to update on ${issue}. Pass a field flag, or a body.`);
  }
  return body;
}

/** The API returns its own self link; the browse URL is what a person can actually open. */
export function browseUrl(issue: { readonly self?: string; readonly key?: string }): string | undefined {
  if (issue.self === undefined || issue.key === undefined) return undefined;
  try {
    return `${new URL(issue.self).origin}/browse/${issue.key}`;
  } catch {
    return undefined;
  }
}

/**
 * Reads an issue back after an update, reporting a failure rather than throwing it.
 *
 * The write already succeeded. If reading it back fails — a token that can write but not
 * browse, an issue that moved projects mid-call — saying so beats reporting a failure the
 * caller would then retry.
 */
export async function readBackIssue(client: JiraClient, issue: string): Promise<IssueReadBack> {
  try {
    return { ok: true, issue: await client.getIssue(issue) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unknown reason' };
  }
}

/**
 * Deletes an issue, in the order that keeps a confused invocation from destroying anything:
 * the key's shape is checked first, a dry run answers before consent is examined, and the
 * request is sent only with explicit confirmation.
 */
export async function deleteIssue(client: JiraClient, input: DeleteIssueInput): Promise<DeleteIssueResult> {
  const issue = assertIssueKey(input.issue);
  const deleteSubtasks = input.deleteSubtasks === true;

  if (input.dryRun === true) return { issue, deleteSubtasks, dryRun: true };

  // Named in the message so a caller that meant a different issue notices before retrying.
  if (input.confirm !== true) {
    throw new ConfigError(`Deleting ${issue} cannot be undone. Pass --confirm to proceed.`);
  }

  await client.deleteIssue(issue, { deleteSubtasks });
  return { issue, deleted: true };
}
