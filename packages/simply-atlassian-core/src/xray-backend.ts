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

import type { AtlassianConfig } from './config.js';
import { ConfigError, HttpError } from './errors.js';
import { JiraClient, type JiraSearchResult } from './jira-client.js';
import {
  discoverXray,
  loadXrayRecord,
  resolveFieldNames,
  saveXrayRecord,
  XrayInstance,
  xrayRecordPath,
  type ResolvedField,
} from './xray-fields.js';

const RAVEN_BASE = '/rest/raven/1.0';
/** Tests per search page, and keys per `key in (…)` chunk. */
export const XRAY_PAGE_SIZE = 100;

/** A query built from the current record, so a retry after rediscovery can rebuild it. */
export interface XrayQuery {
  readonly jql: string;
  readonly fields: string[];
  /** False for `key in (…)` searches, so a key the caller cannot see is skipped rather than fatal. */
  readonly validateQuery?: boolean;
}

export interface XraySearchProgress {
  readonly fetched: number;
  readonly total?: number;
}

export interface XraySearchOptions {
  readonly limit: number;
  /** Called with each page as it arrives, so an export can stream instead of buffering. */
  readonly onPage?: (issues: unknown[], progress: XraySearchProgress) => Promise<void> | void;
}

/** A node of the test repository's folder tree, as Xray reports it. */
export interface RawXrayFolder {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly testRepositoryPath?: unknown;
  readonly testsCount?: unknown;
  readonly testCount?: unknown;
  readonly folders?: unknown;
}

/**
 * Everything the Xray operations need from an Xray deployment. Written as an interface with one
 * implementation because Xray Cloud is a different service — GraphQL, its own host and tokens —
 * and the place a second implementation would be chosen is {@link createXrayBackend}.
 */
export interface XrayBackend {
  /** The instance record, discovered and saved on first use; `refresh` rediscovers. */
  instance(options?: { readonly refresh?: boolean }): Promise<XrayInstance>;
  /** Follows search pages, rediscovering once if a recorded field or type has gone stale. */
  search(build: (instance: XrayInstance) => XrayQuery, options: XraySearchOptions): Promise<JiraSearchResult>;
  /** Fetches issues by key in chunks; keys the caller cannot see are simply absent. */
  issuesByKeys(keys: readonly string[], fields: readonly string[]): Promise<Map<string, unknown>>;
  /** One issue by key, as Jira returns it. */
  issue(key: string, fields: readonly string[]): Promise<unknown>;
  /** Resolves `--fields` values against the record (and, only if needed, the field list). */
  resolveFields(instance: XrayInstance, names: readonly string[]): Promise<ResolvedField[]>;
  /** The test keys in a plan or set, through Xray's REST API rather than JQL. */
  containerTestKeys(kind: 'testplan' | 'testset', key: string): Promise<string[]>;
  /** The test repository's folder tree for a project. */
  repositoryFolders(project: string): Promise<unknown>;
  /** The test keys in one repository folder, through Xray's REST API rather than JQL. */
  folderTestKeys(project: string, folderId: string, recursive: boolean): Promise<string[]>;
}

export interface XrayBackendOptions {
  /** Directory the instance record is read from and written to. Core never picks one itself. */
  readonly cacheDir: string;
  /** Receives one-line warnings (an unwritable cache directory) for the caller to surface. */
  readonly onWarning?: (message: string) => void;
}

/**
 * Picks the backend for an instance. Only Server/Data Center exists, so a Cloud URL is refused
 * here — before any request — rather than left to produce a confusing 404 from a `/rest/raven`
 * path that Cloud does not serve.
 */
export function createXrayBackend(config: AtlassianConfig, options: XrayBackendOptions): XrayBackend {
  if (config.deployment === 'cloud') {
    throw new ConfigError(
      'Xray commands support Jira Server/Data Center only; Xray Cloud is a separate API that is not supported yet.',
    );
  }
  return new XrayServerBackend(new JiraClient(config), config.url, options);
}

/** Xray Server/Data Center: a plugin on the Jira host, reached through Jira search and `/rest/raven/1.0`. */
export class XrayServerBackend implements XrayBackend {
  private readonly client: JiraClient;
  private readonly jiraUrl: string;
  private readonly options: XrayBackendOptions;
  private current?: XrayInstance;
  /** Rediscovery-on-failure happens at most once per backend, so a real error still surfaces. */
  private rediscovered = false;

  public constructor(client: JiraClient, jiraUrl: string, options: XrayBackendOptions) {
    this.client = client;
    this.jiraUrl = jiraUrl;
    this.options = options;
  }

  public async instance(options: { readonly refresh?: boolean } = {}): Promise<XrayInstance> {
    if (options.refresh !== true && this.current !== undefined) return this.current;
    const file = xrayRecordPath(this.options.cacheDir, this.jiraUrl);
    const saved = loadXrayRecord(file);
    if (options.refresh !== true && saved?.jiraUrl === this.jiraUrl) {
      this.current = new XrayInstance(saved, file);
      return this.current;
    }

    const record = await discoverXray(this.client, this.jiraUrl, saved);
    const failure = saveXrayRecord(file, record);
    if (failure !== undefined) {
      this.options.onWarning?.(
        `Could not save the Xray instance record to ${file} (${failure}); using it for this run only.`,
      );
    }
    this.current = new XrayInstance(record, file);
    return this.current;
  }

  public async search(
    build: (instance: XrayInstance) => XrayQuery,
    options: XraySearchOptions,
  ): Promise<JiraSearchResult> {
    const instance = await this.instance();
    let emitted = false;
    const onPage = async (issues: unknown[], progress: XraySearchProgress): Promise<void> => {
      emitted = true;
      await options.onPage?.(issues, progress);
    };
    try {
      return await this.followPages(build(instance), { ...options, onPage });
    } catch (error) {
      // Only before anything was streamed: retrying after a page went out would repeat it.
      if (emitted || this.rediscovered || !isStaleRecordError(error, instance)) throw error;
      this.rediscovered = true;
      const fresh = await this.instance({ refresh: true });
      return this.followPages(build(fresh), { ...options, onPage });
    }
  }

  public async issuesByKeys(keys: readonly string[], fields: readonly string[]): Promise<Map<string, unknown>> {
    const found = new Map<string, unknown>();
    const unique = [...new Set(keys)];
    /* eslint-disable no-await-in-loop -- chunks are sequential so a large export does not flood the instance. */
    for (let index = 0; index < unique.length; index += XRAY_PAGE_SIZE) {
      const chunk = unique.slice(index, index + XRAY_PAGE_SIZE);
      const result = await this.search(
        () => ({ jql: `key in (${chunk.map(quoteKey).join(', ')})`, fields: [...fields], validateQuery: false }),
        { limit: chunk.length },
      );
      for (const issue of result.issues) {
        const key = (issue as { key?: unknown }).key;
        if (typeof key === 'string') found.set(key, issue);
      }
    }
    /* eslint-enable no-await-in-loop */
    return found;
  }

  public issue(key: string, fields: readonly string[]): Promise<unknown> {
    return this.client.getIssue(key, { fields: [...fields] });
  }

  public resolveFields(instance: XrayInstance, names: readonly string[]): Promise<ResolvedField[]> {
    return resolveFieldNames(instance, this.client, names);
  }

  public async containerTestKeys(kind: 'testplan' | 'testset', key: string): Promise<string[]> {
    return pagedKeys((page) =>
      this.client.getFromRoot<unknown>(`${RAVEN_BASE}/api/${kind}/${encodeURIComponent(key)}/test`, {
        page,
        limit: XRAY_PAGE_SIZE,
      }),
    );
  }

  public repositoryFolders(project: string): Promise<unknown> {
    return this.client.getFromRoot(`${RAVEN_BASE}/api/testrepository/${encodeURIComponent(project)}/folders`);
  }

  public async folderTestKeys(project: string, folderId: string, recursive: boolean): Promise<string[]> {
    const base = `${RAVEN_BASE}/api/testrepository/${encodeURIComponent(project)}/folders/${encodeURIComponent(folderId)}/tests`;
    return pagedKeys((page) =>
      this.client.getFromRoot<unknown>(base, { allDescendants: recursive, page, limit: XRAY_PAGE_SIZE }),
    );
  }

  private async followPages(query: XrayQuery, options: XraySearchOptions): Promise<JiraSearchResult> {
    const issues: unknown[] = [];
    let startAt = 0;
    let total: number | undefined;
    let pages = 0;

    /* eslint-disable no-await-in-loop -- paging is sequential: each page supplies the next offset. */
    while (issues.length < options.limit) {
      const page = await this.client.searchIssues({
        jql: query.jql,
        fields: query.fields,
        startAt,
        maxResults: Math.min(XRAY_PAGE_SIZE, options.limit - issues.length),
        validateQuery: query.validateQuery,
      });
      pages += 1;
      issues.push(...page.issues);
      total = page.total ?? total;
      await options.onPage?.(page.issues, { fetched: issues.length, total });

      const next = page.nextStartAt;
      if (page.isLast || page.issues.length === 0 || next === undefined || next <= startAt) {
        return { issues, total, pages, complete: true };
      }
      startAt = next;
    }
    /* eslint-enable no-await-in-loop */
    return { issues, total, pages, complete: false };
  }
}

/** Follows Xray's 1-based `page`/`limit` paging until a short page, collecting test keys. */
async function pagedKeys(fetchPage: (page: number) => Promise<unknown>): Promise<string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  /* eslint-disable no-await-in-loop -- each page is requested only once the previous one was short or full. */
  for (let page = 1; ; page += 1) {
    const batch = keysFromResponse(await fetchPage(page));
    const fresh = batch.filter((key) => !seen.has(key));
    for (const key of fresh) {
      seen.add(key);
      keys.push(key);
    }
    // An instance that ignores paging returns the same list again; no new keys ends it too.
    if (batch.length < XRAY_PAGE_SIZE || fresh.length === 0) return keys;
  }
  /* eslint-enable no-await-in-loop */
}

/** JQL string literal: backslashes and quotes escaped, line breaks flattened. */
export function jqlString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll(/[\r\n\t]+/g, ' ')}"`;
}

function quoteKey(key: string): string {
  return jqlString(key);
}

/**
 * Whether a failed search is the record's fault: Jira rejected the query and named a field id or
 * issue type the record put there. That is what a reinstall or upgrade looks like from outside.
 */
function isStaleRecordError(error: unknown, instance: XrayInstance): boolean {
  if (!(error instanceof HttpError) || error.status !== 400) return false;
  const text = `${error.message} ${JSON.stringify(error.body) ?? ''}`.toLowerCase();
  const { fieldIds, issueTypeNames } = instance.recordedNames();
  if (fieldIds.some((id) => text.includes(id.toLowerCase()))) return true;
  return text.includes('issuetype') && issueTypeNames.some((name) => text.includes(`'${name.toLowerCase()}'`));
}

/** Xray answers with an array of `{ key }`, `{ tests: [...] }`, or bare keys depending on version. */
function keysFromResponse(response: unknown): string[] {
  const list = Array.isArray(response) ? response : (response as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry: unknown) => (typeof entry === 'string' ? entry : (entry as { key?: unknown } | null)?.key))
    .filter((key): key is string => typeof key === 'string');
}
