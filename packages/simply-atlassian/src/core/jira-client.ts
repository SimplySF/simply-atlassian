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

import { buildAuthHeaders } from './auth.js';
import type { AtlassianConfig } from './config.js';
import { HttpTransport, type JsonCall } from './http.js';

export interface JiraSearchOptions {
  readonly jql: string;
  readonly maxResults?: number;
  readonly fields?: string[];
  readonly expand?: string;
  /** Server/Data Center paging cursor. */
  readonly startAt?: number;
  /** Cloud paging cursor. */
  readonly nextPageToken?: string;
}

/** Everything a caller needs after following pages: the issues plus why paging stopped. */
export interface JiraSearchResult {
  readonly issues: unknown[];
  /** The instance's reported match count, when it reports one. */
  readonly total?: number;
  readonly pages: number;
  /** False when the caller's limit cut the results short. */
  readonly complete: boolean;
}

/** Deployment-independent view of one page of search results. */
export interface JiraSearchPage {
  readonly issues: unknown[];
  readonly isLast: boolean;
  readonly nextPageToken?: string;
  readonly nextStartAt?: number;
  readonly total?: number;
}

interface CloudSearchResponse {
  readonly issues?: unknown[];
  readonly nextPageToken?: string;
  readonly isLast?: boolean;
}

interface ServerSearchResponse {
  readonly issues?: unknown[];
  readonly total?: number;
  /** The instance's effective page size, which may be smaller than what was asked for. */
  readonly maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 50;
const AGILE_BASE = '/rest/agile/1.0';

/**
 * Jira REST client. Owns the one thing callers should never have to think about: Cloud speaks
 * `/rest/api/3` and pages with an opaque `nextPageToken`, while Server/Data Center speaks
 * `/rest/api/2` and pages with numeric `startAt` offsets.
 */
export class JiraClient {
  private readonly deployment: AtlassianConfig['deployment'];
  private readonly transport: HttpTransport;
  private readonly apiBase: string;

  public constructor(config: AtlassianConfig) {
    this.deployment = config.deployment;
    this.transport = new HttpTransport({
      baseUrl: config.url,
      headers: buildAuthHeaders(config),
    });
    this.apiBase = config.deployment === 'cloud' ? '/rest/api/3' : '/rest/api/2';
  }

  /** Cheapest authenticated call there is — useful for verifying credentials. */
  public getCurrentUser(): Promise<unknown> {
    return this.request('/myself', { method: 'GET' });
  }

  public getIssue(issueKey: string, options: { fields?: string[]; expand?: string } = {}): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}`, {
      method: 'GET',
      query: { fields: joinFields(options.fields), expand: options.expand },
    });
  }

  public async searchIssues(options: JiraSearchOptions): Promise<JiraSearchPage> {
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

    if (this.deployment === 'cloud') {
      const response = await this.request<CloudSearchResponse>('/search/jql', {
        method: 'POST',
        body: {
          jql: options.jql,
          maxResults,
          fields: options.fields ?? ['*navigable'],
          expand: options.expand,
          nextPageToken: options.nextPageToken,
        },
      });
      const issues = response.issues ?? [];
      return {
        issues,
        // Cloud sends `isLast`, but older instances omit it; absence of a cursor means the same thing.
        isLast: response.isLast ?? !response.nextPageToken,
        nextPageToken: response.nextPageToken,
      };
    }

    const startAt = options.startAt ?? 0;
    const response = await this.request<ServerSearchResponse>('/search', {
      method: 'GET',
      query: {
        jql: options.jql,
        startAt,
        maxResults,
        fields: joinFields(options.fields),
        expand: options.expand,
      },
    });
    const issues = response.issues ?? [];
    const nextStartAt = startAt + issues.length;
    // Without a `total`, a short page is the only end-of-results signal — but "short" must be
    // judged against the instance's effective cap (response.maxResults), not what we asked for:
    // Server/DC instances cap page sizes, and a capped-but-full page is not the last one.
    const pageCap = response.maxResults ?? maxResults;
    return {
      issues,
      isLast: response.total === undefined ? issues.length < pageCap : nextStartAt >= response.total,
      nextStartAt,
      total: response.total,
    };
  }

  /**
   * Follows pages until `limit` issues are collected or the instance says there are no more.
   * Callers get a flat list and never touch a cursor — the Cloud/Server paging difference stays
   * inside the client, which is the whole point of it living here.
   */
  public async searchAllIssues(options: JiraSearchOptions, limit: number): Promise<JiraSearchResult> {
    const collected: unknown[] = [];
    let cursor: Pick<JiraSearchOptions, 'startAt' | 'nextPageToken'> = {};
    let total: number | undefined;
    let pages = 0;

    /* Paging is sequential by definition: each request needs the previous page's cursor. */
    /* eslint-disable no-await-in-loop */
    while (collected.length < limit) {
      const page = await this.searchIssues({
        ...options,
        ...cursor,
        // Never ask for more than the caller wants, so a limit of 5 is one small request.
        maxResults: Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, limit - collected.length),
      });
      pages += 1;
      collected.push(...page.issues);
      total = typeof page.total === 'number' ? page.total : total;

      // A page with no cursor cannot be followed. Some instances (and proxies) answer
      // `isLast: false` while omitting the token, and repeating the identical request would
      // return the same issues forever, so the absence of a cursor ends paging too.
      const nextCursor = { startAt: page.nextStartAt, nextPageToken: page.nextPageToken };
      const canAdvance =
        nextCursor.nextPageToken !== undefined ||
        (nextCursor.startAt !== undefined && nextCursor.startAt > (cursor.startAt ?? 0));
      const exhausted = page.isLast || page.issues.length === 0 || !canAdvance;
      if (exhausted) return { issues: collected.slice(0, limit), total, pages, complete: true };
      cursor = nextCursor;
    }
    /* eslint-enable no-await-in-loop */

    // Stopped because the limit was reached, not because the instance ran out.
    return { issues: collected.slice(0, limit), total, pages, complete: false };
  }

  /** Agile endpoints share a base across both deployments, so they use it instead of `apiBase`. */
  public getBoards(options: { startAt?: number; maxResults?: number } = {}): Promise<unknown> {
    return this.request(
      '/board',
      { method: 'GET', query: { startAt: options.startAt, maxResults: options.maxResults } },
      AGILE_BASE,
    );
  }

  private request<T>(path: string, call: Omit<JsonCall, 'path'>, base = this.apiBase): Promise<T> {
    return this.transport.json<T>({ ...call, path: `${base}${path}` });
  }
}

/** An empty list must mean "default fields", so it is dropped rather than sent as `fields=`. */
function joinFields(fields: string[] | undefined): string | undefined {
  return fields !== undefined && fields.length > 0 ? fields.join(',') : undefined;
}
