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

const API_BASE = '/rest/api';
const DEFAULT_LIMIT = 25;

/** Everything a caller needs after following pages: the results plus why paging stopped. */
export interface ConfluencePage<T = unknown> {
  readonly results: T[];
  /** The instance's reported match count, when it reports one. */
  readonly size?: number;
  readonly pages: number;
  /** False when the caller's limit cut the results short. */
  readonly complete: boolean;
}

interface PagedResponse {
  readonly results?: unknown[];
  readonly size?: number;
  readonly limit?: number;
  readonly start?: number;
  readonly totalSize?: number;
  readonly _links?: { readonly next?: string };
}

/**
 * Confluence REST client. Unlike Jira, both deployments serve the same `/rest/api` surface — the
 * Cloud/Server difference is absorbed earlier, when the base URL is canonicalized to `/wiki`.
 */
export class ConfluenceClient {
  private readonly transport: HttpTransport;

  public constructor(config: AtlassianConfig) {
    this.transport = new HttpTransport({
      baseUrl: config.url,
      headers: buildAuthHeaders(config),
    });
  }

  /**
   * Fetches one page. An empty `expand` list is honoured rather than replaced by the default,
   * so a caller that only wants metadata can avoid paying for the body.
   */
  public getPage(pageId: string, options: { expand?: string[] } = {}): Promise<unknown> {
    const expand = options.expand ?? ['body.storage', 'version', 'space'];
    return this.request(`/content/${encodeURIComponent(pageId)}`, {
      method: 'GET',
      query: { expand: expand.length === 0 ? undefined : expand.join(',') },
    });
  }

  public searchPages(cql: string, options: { limit?: number; start?: number } = {}): Promise<unknown> {
    return this.request('/content/search', {
      method: 'GET',
      query: { cql, limit: options.limit ?? DEFAULT_LIMIT, start: options.start },
    });
  }

  public getPageChildren(
    pageId: string,
    options: { limit?: number; start?: number; expand?: string[] } = {},
  ): Promise<unknown> {
    // Children come back bare unless expansions are asked for, so the last-modified column
    // would otherwise render as blanks the caller never asked to be blank.
    const expand = (options.expand ?? ['version']).join(',');
    return this.request(`/content/${encodeURIComponent(pageId)}/child/page`, {
      method: 'GET',
      query: {
        limit: options.limit ?? DEFAULT_LIMIT,
        start: options.start,
        expand: expand === '' ? undefined : expand,
      },
    });
  }

  /**
   * Follows result pages until `limit` items are collected or the instance stops offering a
   * next link. Callers get a flat list and never touch `start`/`limit` themselves — the same
   * contract as the Jira client's search, so both products page the same way.
   */
  public async searchAllPages(
    cql: string,
    limit: number,
    options: { expand?: string[] } = {},
  ): Promise<ConfluencePage> {
    // Search returns bare content unless expansions are requested; without these the space
    // and last-modified columns would render as blanks the caller never asked to be blank.
    const expand = (options.expand ?? ['space', 'version']).join(',');
    const collected: unknown[] = [];
    let start = 0;
    let size: number | undefined;
    let pages = 0;

    /* Paging is sequential by definition: each request needs the previous page's offset. */
    /* eslint-disable no-await-in-loop */
    while (collected.length < limit) {
      const remaining = limit - collected.length;
      const response = await this.request<PagedResponse>('/content/search', {
        method: 'GET',
        query: { cql, limit: Math.min(DEFAULT_LIMIT, remaining), start, expand: expand === '' ? undefined : expand },
      });
      pages += 1;
      const results = response.results ?? [];
      collected.push(...results);
      // Typed as a number, but it arrives from the instance: a non-number would otherwise be
      // interpolated straight into stdout, escaping the sanitising every other field gets.
      size = typeof response.totalSize === 'number' ? response.totalSize : size;

      // No next link, or a page that returned nothing, means there is nothing left to follow.
      // An instance that echoes an offset other than the one requested is not paging the way
      // this loop assumes, so stop rather than append the same rows again.
      const echoedStart = response.start;
      const paging = echoedStart === undefined || echoedStart === start;
      /* eslint-disable-next-line no-underscore-dangle -- Atlassian's field name */
      const hasNext = response._links?.next !== undefined;
      if (!hasNext || results.length === 0 || !paging) {
        return { results: collected.slice(0, limit), size, pages, complete: true };
      }
      start += results.length;
    }
    /* eslint-enable no-await-in-loop */

    // Stopped because the limit was reached, not because the instance ran out.
    return { results: collected.slice(0, limit), size, pages, complete: false };
  }

  private request<T>(path: string, call: Omit<JsonCall, 'path'>): Promise<T> {
    return this.transport.json<T>({ ...call, path: `${API_BASE}${path}` });
  }
}
