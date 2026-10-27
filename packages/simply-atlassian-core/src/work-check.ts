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

import { HttpError } from './errors.js';
import type { WorkFieldSpec } from './work-config.js';
import type { WorkContext } from './work-item.js';

export interface WorkConfigCheck {
  readonly config: string;
  /** False when any error was found. */
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface CreateField {
  readonly fieldId?: string;
  readonly key?: string;
  readonly name?: string;
  readonly required?: boolean;
  readonly allowedValues?: ReadonlyArray<{ readonly value?: string; readonly name?: string }>;
}

/**
 * Checks a project config against the live instance: that the project, issue type and every
 * field key exist where the config says, that fixed and allowed choices are real options, and
 * that the Confluence space and parent page exist.
 *
 * The validator in `work-config.ts` can only say a config is well-formed. This is what says it
 * will work — run once when a project adopts it, and in CI so a renamed component or a field
 * removed from a screen fails a build rather than an agent's save.
 */
export async function checkWorkConfig(ctx: WorkContext): Promise<WorkConfigCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { project, issueType, fields } = ctx.config.jira;

  if (!(await exists(() => ctx.jira.getProject(project)))) {
    errors.push(`jira.project: project ${project} does not exist, or this account cannot see it`);
    return result(ctx, errors, warnings);
  }

  const types = listOf(
    (await ctx.jira.getCreateIssueTypes(project)) as Record<string, unknown>,
    'issueTypes',
  ) as Array<{
    id?: string;
    name?: string;
  }>;
  const type = types.find((candidate) => candidate.name?.toLowerCase() === issueType.toLowerCase());
  if (type?.id === undefined) {
    const creatable = types.map((candidate) => candidate.name ?? '?').join(', ');
    errors.push(`jira.issueType: ${project} cannot create "${issueType}" issues (it can create: ${creatable})`);
    return result(ctx, errors, warnings);
  }

  const screen = listOf(
    (await ctx.jira.getCreateFields(project, type.id)) as Record<string, unknown>,
    'fields',
  ) as CreateField[];
  const onScreen = new Map(screen.map((field) => [field.fieldId ?? field.key ?? '', field]));
  const components = fields.some((field) => field.type === 'components')
    ? names((await ctx.jira.getProjectComponents(project)) as unknown[])
    : [];
  const versions = fields.some((field) => field.type === 'versions')
    ? names((await ctx.jira.getProjectVersions(project)) as unknown[])
    : [];

  for (const [index, spec] of fields.entries()) {
    checkField(spec, `jira.fields[${index}]`, onScreen.get(spec.key), { components, versions }, errors, warnings);
  }
  for (const field of screen) {
    const id = field.fieldId ?? field.key ?? '';
    const ignored = ['project', 'issuetype', 'reporter'].includes(id);
    if (field.required === true && !ignored && !fields.some((spec) => spec.key === id)) {
      errors.push(
        `jira.fields: "${field.name ?? id}" (${id}) is required to create a ${issueType} but is not configured`,
      );
    }
  }

  await checkConfluence(ctx, errors);
  return result(ctx, errors, warnings);
}

function checkField(
  spec: WorkFieldSpec,
  at: string,
  field: CreateField | undefined,
  project: { readonly components: readonly string[]; readonly versions: readonly string[] },
  errors: string[],
  warnings: string[],
): void {
  if (spec.type === 'raw') warnings.push(`${at}: "${spec.name}" is raw, so its value is sent unchecked`);
  if (field === undefined) {
    // Fields such as an Epic Link can be edit-only; a create would fail, an update would not.
    errors.push(`${at}: ${spec.key} ("${spec.name}") is not on the create screen for this issue type`);
    return;
  }

  let options: readonly string[] | undefined;
  if (spec.type === 'components') options = project.components;
  else if (spec.type === 'versions') options = project.versions;
  else if (spec.type === 'option' || spec.type === 'options') {
    options = (field.allowedValues ?? []).map((value) => value.value ?? value.name ?? '').filter((name) => name !== '');
  }
  if (options === undefined) return;

  const configured: unknown[] = [spec.value, spec.default, spec.allowed].flatMap((value): unknown[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? (value as unknown[]) : [value];
  });
  for (const choice of configured) {
    if (typeof choice === 'string' && !options.includes(choice)) {
      errors.push(`${at}: "${choice}" is not one of ${spec.name}'s options (${options.join(', ') || 'none'})`);
    }
  }
}

async function checkConfluence(ctx: WorkContext, errors: string[]): Promise<void> {
  const confluence = ctx.config.confluence;
  if (confluence === undefined) return;
  const { client } = ctx.confluence();
  if (!(await exists(() => client.getSpace(confluence.space)))) {
    errors.push(`confluence.space: space ${confluence.space} does not exist, or this account cannot see it`);
  }
  if (
    confluence.parent !== undefined &&
    !(await exists(() => client.getPage(confluence.parent ?? '', { expand: [] })))
  ) {
    errors.push(`confluence.parent: page ${confluence.parent} does not exist, or this account cannot see it`);
  }
}

/** A 404 means "no"; anything else (auth, network) is a real failure and propagates. */
async function exists(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

/** The paged create-metadata lists are named per deployment; Server/DC uses `values`. */
function listOf(response: Record<string, unknown>, cloudName: string): unknown[] {
  const list: unknown = response[cloudName] ?? response.values;
  return Array.isArray(list) ? (list as unknown[]) : [];
}

function names(items: unknown[]): string[] {
  return (Array.isArray(items) ? items : [])
    .map((item) => (item as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
}

function result(ctx: WorkContext, errors: string[], warnings: string[]): WorkConfigCheck {
  return { config: ctx.config.source, ok: errors.length === 0, errors, warnings };
}
