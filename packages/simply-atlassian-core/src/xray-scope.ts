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
import { ConfigError, HttpError } from './errors.js';
import type { JiraSearchResult } from './jira-client.js';
import { jqlString, XRAY_PAGE_SIZE, type XrayBackend, type XrayQuery, type XraySearchOptions } from './xray-backend.js';
import type { XrayInstance } from './xray-fields.js';
import { findFolder, normaliseFolders } from './xray-folders.js';

/** Exactly one of project, plan or set; `path` narrows a project scope to a repository folder. */
export interface XrayScope {
  readonly project?: string;
  readonly plan?: string;
  readonly set?: string;
  readonly path?: string;
  readonly recursive?: boolean;
}

/** Optional narrowing, ANDed onto the scope. */
export interface XrayFilters {
  readonly jql?: string;
  readonly search?: string;
  readonly linkedTo?: readonly string[];
}

type ResolvedScope =
  | { readonly kind: 'project'; readonly project: string }
  | { readonly kind: 'plan'; readonly key: string }
  | { readonly kind: 'set'; readonly key: string }
  | { readonly kind: 'path'; readonly project: string; readonly path: string; readonly recursive: boolean };

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The JQL function behind each indirect scope, which an older Xray may not provide. */
const SCOPE_FUNCTIONS = { plan: 'testPlanTests', set: 'testSetTests', path: 'testRepositoryFolderTests' } as const;

/** Checks the scope flags make exactly one scope, and that every key is shaped like one. */
export function resolveScope(scope: XrayScope): ResolvedScope {
  const chosen = (['project', 'plan', 'set'] as const).filter((name) => scope[name] !== undefined);
  if (scope.path !== undefined && scope.project === undefined) {
    throw new ConfigError('--path names a folder inside a project; pass --project with it.');
  }
  if (chosen.length !== 1) {
    throw new ConfigError(
      chosen.length === 0
        ? 'Pass one scope: --project, --plan, --set, or --project with --path.'
        : `Pass only one scope; got ${chosen.map((name) => `--${name}`).join(' and ')}.`,
    );
  }
  if (scope.recursive === true && scope.path === undefined) {
    throw new ConfigError('--recursive applies to --path; pass a folder with it.');
  }
  if (scope.plan !== undefined) return { kind: 'plan', key: assertKey(scope.plan, '--plan') };
  if (scope.set !== undefined) return { kind: 'set', key: assertKey(scope.set, '--set') };
  const project = assertProjectKey(scope.project ?? '');
  if (scope.path === undefined) return { kind: 'project', project };
  return { kind: 'path', project, path: folderArgument(scope.path), recursive: scope.recursive === true };
}

/** `/` is the repository root, which the JQL function spells `""`; other paths pass as given. */
export function folderArgument(folder: string): string {
  const trimmed = folder.trim();
  return /^\/+$/.test(trimmed) ? '' : trimmed;
}

export function assertProjectKey(value: string): string {
  if (!PROJECT_KEY.test(value)) throw new ConfigError(`"${value}" is not a project key. Pass a key such as PROJ.`);
  return value;
}

/** The JQL a scope selects, before any filter. */
export function scopeJql(scope: ResolvedScope, instance: XrayInstance): string {
  switch (scope.kind) {
    case 'project':
      return `project = ${jqlString(scope.project)} AND issuetype = ${jqlString(instance.requireIssueType('test'))}`;
    case 'plan':
      return `issue in ${SCOPE_FUNCTIONS.plan}(${jqlString(scope.key)})`;
    case 'set':
      return `issue in ${SCOPE_FUNCTIONS.set}(${jqlString(scope.key)})`;
    case 'path':
      instance.requireField('repositoryPath');
      return (
        `issue in ${SCOPE_FUNCTIONS.path}(${jqlString(scope.project)}, ${jqlString(scope.path)}, ` +
        `${jqlString(String(scope.recursive))})`
      );
  }
}

/**
 * Joins a scope clause and the filters into one query. The caller's `--jql` is parenthesised so an
 * `OR` inside it cannot widen the scope, and a trailing `ORDER BY` in it is moved to the end, where
 * JQL requires it. Without one, results are ordered by key so a paged export is stable.
 */
export function combineJql(scopeClause: string, filters: XrayFilters): string {
  const parts = [scopeClause];
  let order = 'key ASC';

  const userJql = filters.jql?.trim();
  if (userJql !== undefined && userJql !== '') {
    const match = /(?:^|\s)order\s+by\s+([\s\S]+)$/i.exec(userJql);
    const condition = match === null ? userJql : userJql.slice(0, match.index).trim();
    if (match?.[1] !== undefined) order = match[1].trim();
    if (condition !== '') parts.push(`(${condition})`);
  }

  const search = filters.search?.trim();
  if (search !== undefined && search !== '') {
    parts.push(`(summary ~ ${jqlString(search)} OR description ~ ${jqlString(search)})`);
  }

  const linked = (filters.linkedTo ?? []).map((key) => assertKey(key, '--linked-to'));
  if (linked.length > 0) {
    parts.push(`(${linked.map((key) => `issue in linkedIssues(${jqlString(key)})`).join(' OR ')})`);
  }

  return `${parts.join(' AND ')} ORDER BY ${order}`;
}

/**
 * Searches the tests a scope and filters select. JQL first; if the installed Xray lacks the scope's
 * JQL function, the scope's keys come from Xray's REST API instead and are searched in chunks of
 * `key in (…)`, so the filters still apply on the server. Both routes give the same result.
 */
export async function searchScopedTests(
  backend: XrayBackend,
  scope: XrayScope,
  filters: XrayFilters,
  fields: (instance: XrayInstance) => string[],
  options: XraySearchOptions,
): Promise<JiraSearchResult> {
  const resolved = resolveScope(scope);
  // Checked up front, so a bad --linked-to fails before any request rather than inside a retry.
  for (const key of filters.linkedTo ?? []) assertKey(key, '--linked-to');
  const build = (instance: XrayInstance): XrayQuery => ({
    jql: combineJql(scopeJql(resolved, instance), filters),
    fields: fields(instance),
  });

  try {
    return await backend.search(build, options);
  } catch (error) {
    if (resolved.kind === 'project' || !isMissingFunction(error, SCOPE_FUNCTIONS[resolved.kind])) throw error;
  }

  const keys = await scopeKeysByRest(backend, resolved);
  return searchKeyChunks(backend, keys, filters, fields, options);
}

async function scopeKeysByRest(
  backend: XrayBackend,
  scope: Exclude<ResolvedScope, { kind: 'project' }>,
): Promise<string[]> {
  if (scope.kind === 'plan') return backend.containerTestKeys('testplan', scope.key);
  if (scope.kind === 'set') return backend.containerTestKeys('testset', scope.key);
  const tree = normaliseFolders(await backend.repositoryFolders(scope.project));
  const folder = findFolder(tree, scope.path);
  if (folder?.id === undefined) {
    throw new ConfigError(
      `No folder "${scope.path}" in the ${scope.project} test repository. "jira xray path list" shows them.`,
    );
  }
  return backend.folderTestKeys(scope.project, folder.id, scope.recursive);
}

async function searchKeyChunks(
  backend: XrayBackend,
  keys: readonly string[],
  filters: XrayFilters,
  fields: (instance: XrayInstance) => string[],
  options: XraySearchOptions,
): Promise<JiraSearchResult> {
  const issues: unknown[] = [];
  let pages = 0;
  let total = 0;
  /* eslint-disable no-await-in-loop -- chunks are sequential, so the limit can stop the next one. */
  for (let index = 0; index < keys.length; index += XRAY_PAGE_SIZE) {
    // Chunks remain, so there may be more matches: conservatively incomplete.
    if (issues.length >= options.limit) return { issues, pages, complete: false };
    const chunk = keys.slice(index, index + XRAY_PAGE_SIZE);
    const clause = `key in (${chunk.map((key) => jqlString(key)).join(', ')})`;
    const fetchedBefore = issues.length;
    const result = await backend.search(
      (instance) => ({ jql: combineJql(clause, filters), fields: fields(instance), validateQuery: false }),
      {
        limit: options.limit - issues.length,
        onPage: (page, progress) => options.onPage?.(page, { fetched: fetchedBefore + progress.fetched }),
      },
    );
    issues.push(...result.issues);
    pages += result.pages;
    total += result.total ?? result.issues.length;
    if (!result.complete) return { issues, pages, complete: false };
  }
  /* eslint-enable no-await-in-loop */
  return { issues, total, pages, complete: true };
}

/** Jira's answer when a JQL function is not installed names the function in a 400. */
function isMissingFunction(error: unknown, name: string): boolean {
  if (!(error instanceof HttpError) || error.status !== 400) return false;
  const text = `${error.message} ${JSON.stringify(error.body) ?? ''}`.toLowerCase();
  return text.includes(name.toLowerCase()) && text.includes('function');
}

function assertKey(value: string, flag: string): string {
  if (!isIssueKey(value)) throw new ConfigError(`${flag} takes an issue key such as PROJ-12; got "${value}".`);
  return value;
}
