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

import { buildAuthHeaders } from './auth.js';
import type { AtlassianConfig } from './config.js';
import { AuthError, HttpError } from './errors.js';
import { HttpTransport, type JsonCall } from './http.js';

const API_BASE = '/rest/api';
const DEFAULT_LIMIT = 25;
/** The v2 versions endpoint's documented maximum page size. */
const CLOUD_VERSIONS_PAGE = 250;
/** What the experimental Server/DC endpoint returns by default; asking for more is not documented. */
const SERVER_VERSIONS_PAGE = 200;
/** `user/bulk` returns at most this many users, silently dropping the rest. */
const USER_BULK_MAX = 100;

/** One page version, normalized across Cloud's v2 shape and Server/DC's v1 shape. */
export interface ConfluencePageVersion {
  readonly number?: number;
  readonly when?: string;
  /** Display name where the instance gives one, else the account id or username. */
  readonly author?: string;
  readonly message?: string;
  readonly minorEdit?: boolean;
}

/** A page's versions, newest first, with the raw entries index-aligned to the normalized ones. */
export interface ConfluencePageHistory {
  readonly versions: ConfluencePageVersion[];
  readonly rawEntries: unknown[];
  /** False when `limit` stopped the read before the oldest version. */
  readonly complete: boolean;
}

/** The fields of a version either deployment sends: Cloud `authorId`/`createdAt`, Server/DC `by`/`when`. */
interface RawVersion {
  readonly number?: unknown;
  readonly when?: unknown;
  readonly createdAt?: unknown;
  readonly authorId?: unknown;
  readonly by?: { readonly displayName?: unknown; readonly username?: unknown; readonly accountId?: unknown };
  readonly message?: unknown;
  readonly minorEdit?: unknown;
}

interface VersionsResponse {
  readonly results?: unknown[];
  readonly start?: number;
  readonly _links?: { readonly next?: string };
}

interface UserBulkResponse {
  readonly results?: Array<{ readonly accountId?: unknown; readonly displayName?: unknown }>;
}

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
  public readonly deployment: AtlassianConfig['deployment'];
  private readonly transport: HttpTransport;

  public constructor(config: AtlassianConfig) {
    this.deployment = config.deployment;
    this.transport = new HttpTransport({
      baseUrl: config.url,
      headers: buildAuthHeaders(config),
    });
  }

  /**
   * Fetches one page. An empty `expand` list is honoured rather than replaced by the default,
   * so a caller that only wants metadata can avoid paying for the body.
   */
  /**
   * `status: 'any'` is how a trashed page is read at all: the default filter is
   * `[current, archived]`, so a plain GET of a trashed id answers 404. Callers that need to know
   * whether a page is in the trash — `page delete` does — have to ask for it explicitly.
   */
  public getPage(pageId: string, options: { expand?: string[]; status?: 'any' } = {}): Promise<unknown> {
    const expand = options.expand ?? ['body.storage', 'version', 'space'];
    return this.request(`/content/${encodeURIComponent(pageId)}`, {
      method: 'GET',
      query: {
        expand: expand.length === 0 ? undefined : expand.join(','),
        status: options.status,
      },
    });
  }

  public createContent(body: Record<string, unknown>): Promise<unknown> {
    return this.request('/content', { method: 'POST', body, mutating: true });
  }

  public updateContent(contentId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/content/${encodeURIComponent(contentId)}`, { method: 'PUT', body, mutating: true });
  }

  /**
   * Deletes content, in one of the two senses Confluence gives that verb.
   *
   * A plain delete moves a page to the space trash: it still resolves under `?status=any` with
   * `status: trashed` and can be restored. Passing `status=trashed` purges it, after which the id
   * is gone for good. Same endpoint, same method, very different consequence — which is why the
   * caller states which one it wants rather than the command guessing.
   */
  public async deleteContent(contentId: string, options: { purge?: boolean } = {}): Promise<void> {
    await this.request(`/content/${encodeURIComponent(contentId)}`, {
      method: 'DELETE',
      mutating: true,
      query: { status: options.purge === true ? 'trashed' : undefined },
    });
  }

  /**
   * A comment is content in its own right, not a sub-resource of the page, so it is read from the
   * page's comment children rather than from a `/comment` path under it.
   */
  public getLabels(pageId: string, options: { limit?: number } = {}): Promise<unknown> {
    return this.request(`/content/${encodeURIComponent(pageId)}/label`, {
      method: 'GET',
      query: { limit: options.limit ?? DEFAULT_LIMIT },
    });
  }

  /**
   * Adds labels. The endpoint takes an array rather than an object, which the transport allows
   * because it types a request body as `unknown` — no cast needed.
   *
   * Labels are additive and idempotent: posting one the page already carries is accepted, and the
   * response is the page's full label set rather than only what was new.
   */
  public addLabels(pageId: string, labels: ReadonlyArray<Record<string, unknown>>): Promise<unknown> {
    return this.request(`/content/${encodeURIComponent(pageId)}/label`, {
      method: 'POST',
      body: labels,
      mutating: true,
    });
  }

  public getComments(pageId: string, options: { limit?: number; start?: number } = {}): Promise<unknown> {
    return this.request(`/content/${encodeURIComponent(pageId)}/child/comment`, {
      method: 'GET',
      query: {
        limit: options.limit ?? DEFAULT_LIMIT,
        start: options.start,
        expand: 'body.storage,version,history',
      },
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

  /**
   * A page's versions, newest first, up to `limit`. This is the one read where the deployments
   * share no endpoint — see design 0019 — so the branching stays here rather than in callers.
   */
  public async getAllPageVersions(pageId: string, limit: number): Promise<ConfluencePageHistory> {
    const read =
      this.deployment === 'cloud'
        ? await this.cloudPageVersions(pageId, limit)
        : await this.serverPageVersions(pageId, limit);
    // Sorted whatever order the instance used, keeping raw and normalized entries aligned.
    const order = read.rawEntries
      .map((raw, index) => ({ raw, index, number: versionNumber(raw) }))
      .sort((left, right) => (right.number ?? -1) - (left.number ?? -1))
      .slice(0, limit);
    const rawEntries = order.map((entry) => entry.raw);
    const names = this.deployment === 'cloud' ? await this.displayNames(rawEntries) : new Map<string, string>();
    return {
      versions: rawEntries.map((raw) => normalizeVersion(raw, names)),
      rawEntries,
      complete: read.complete && read.rawEntries.length <= limit,
    };
  }

  /** Cloud: v2 only, since v1 no longer lists versions. The cursor is lifted out of `_links.next`. */
  private async cloudPageVersions(
    pageId: string,
    limit: number,
  ): Promise<{ rawEntries: unknown[]; complete: boolean }> {
    const rawEntries: unknown[] = [];
    let cursor: string | undefined;

    /* Paging is sequential by definition: each request needs the previous page's cursor. */
    /* eslint-disable no-await-in-loop */
    while (rawEntries.length < limit) {
      const response = await this.transport.json<VersionsResponse>({
        method: 'GET',
        path: `/api/v2/pages/${encodeURIComponent(pageId)}/versions`,
        query: { limit: Math.min(CLOUD_VERSIONS_PAGE, limit - rawEntries.length), sort: '-modified-date', cursor },
      });
      const results = response.results ?? [];
      rawEntries.push(...results);
      // Only the cursor is taken from the server's link. Requesting the link itself would let the
      // instance choose where the next request goes.
      /* eslint-disable-next-line no-underscore-dangle -- Atlassian's field name */
      cursor = cursorFrom(response._links?.next);
      if (cursor === undefined || results.length === 0) return { rawEntries, complete: true };
    }
    /* eslint-enable no-await-in-loop */
    return { rawEntries, complete: false };
  }

  /**
   * Server/DC: the experimental list when the instance still has it, else a walk down from the
   * current version through the supported historical read. A 404 from the list is the signal,
   * and is also what an unknown page answers — in which case the walk's first read reports it.
   */
  private async serverPageVersions(
    pageId: string,
    limit: number,
  ): Promise<{ rawEntries: unknown[]; complete: boolean }> {
    try {
      return await this.experimentalPageVersions(pageId, limit);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return this.walkPageVersions(pageId, limit);
      throw error;
    }
  }

  private async experimentalPageVersions(
    pageId: string,
    limit: number,
  ): Promise<{ rawEntries: unknown[]; complete: boolean }> {
    const rawEntries: unknown[] = [];
    let start = 0;

    /* eslint-disable no-await-in-loop */
    while (rawEntries.length < limit) {
      const response = await this.transport.json<VersionsResponse>({
        method: 'GET',
        path: `/rest/experimental/content/${encodeURIComponent(pageId)}/version`,
        query: { start, limit: Math.min(SERVER_VERSIONS_PAGE, limit - rawEntries.length) },
      });
      const results = response.results ?? [];
      rawEntries.push(...results);
      // The same guards as `searchAllPages`: no next link, an empty page, or an offset the
      // instance did not honour all end the read rather than looping on the same rows.
      const paging = response.start === undefined || response.start === start;
      /* eslint-disable-next-line no-underscore-dangle -- Atlassian's field name */
      if (response._links?.next === undefined || results.length === 0 || !paging) {
        return { rawEntries, complete: true };
      }
      start += results.length;
    }
    /* eslint-enable no-await-in-loop */
    return { rawEntries, complete: false };
  }

  /** One supported read per version. A version that is gone (DC can delete them) is skipped. */
  private async walkPageVersions(pageId: string, limit: number): Promise<{ rawEntries: unknown[]; complete: boolean }> {
    const current = (await this.getPage(pageId, { expand: ['version'] })) as { version?: RawVersion };
    const latest = current.version;
    const top = typeof latest?.number === 'number' ? latest.number : undefined;
    // Without a version number there is nothing to walk down from, so the current version is all there is.
    if (latest === undefined || top === undefined) {
      return { rawEntries: latest === undefined ? [] : [latest], complete: true };
    }

    const rawEntries: unknown[] = [latest];
    let next = top - 1;
    /* eslint-disable no-await-in-loop */
    for (; next >= 1 && rawEntries.length < limit; next -= 1) {
      try {
        const page = await this.request<{ version?: unknown }>(`/content/${encodeURIComponent(pageId)}`, {
          method: 'GET',
          query: { status: 'historical', version: next, expand: 'version' },
        });
        if (page.version !== undefined) rawEntries.push(page.version);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
    }
    /* eslint-enable no-await-in-loop */
    return { rawEntries, complete: next < 1 };
  }

  /**
   * Cloud versions name their author by account id only. Names are a convenience, so a lookup the
   * credential may not be allowed to make leaves the ids in place instead of failing the read.
   */
  private async displayNames(rawEntries: readonly unknown[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rawEntries
          .map((raw) => (raw as RawVersion).authorId)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    ];
    const names = new Map<string, string>();
    /* eslint-disable no-await-in-loop */
    for (let index = 0; index < ids.length; index += USER_BULK_MAX) {
      try {
        const response = await this.request<UserBulkResponse>('/user/bulk', {
          method: 'GET',
          query: { accountId: ids.slice(index, index + USER_BULK_MAX) },
        });
        for (const user of response.results ?? []) {
          if (typeof user.accountId === 'string' && typeof user.displayName === 'string') {
            names.set(user.accountId, user.displayName);
          }
        }
      } catch (error) {
        if (!(error instanceof HttpError || error instanceof AuthError)) throw error;
      }
    }
    /* eslint-enable no-await-in-loop */
    return names;
  }

  private request<T>(path: string, call: Omit<JsonCall, 'path'>): Promise<T> {
    return this.transport.json<T>({ ...call, path: `${API_BASE}${path}` });
  }
}

/** The `cursor` parameter of a v2 next link, which arrives as a relative URL. */
function cursorFrom(next: string | undefined): string | undefined {
  if (next === undefined) return undefined;
  const cursor = new URL(next, 'http://next.invalid').searchParams.get('cursor');
  return cursor === null || cursor === '' ? undefined : cursor;
}

function versionNumber(raw: unknown): number | undefined {
  const value = (raw as RawVersion | null)?.number;
  return typeof value === 'number' ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Both deployments' fields in one place; values are type-checked because they come from the instance. */
function normalizeVersion(raw: unknown, names: ReadonlyMap<string, string>): ConfluencePageVersion {
  const version = (raw ?? {}) as RawVersion;
  const authorId = text(version.authorId);
  return {
    number: versionNumber(raw),
    when: text(version.createdAt) ?? text(version.when),
    author:
      (authorId === undefined ? undefined : (names.get(authorId) ?? authorId)) ??
      text(version.by?.displayName) ??
      text(version.by?.username) ??
      text(version.by?.accountId),
    message: text(version.message),
    minorEdit: typeof version.minorEdit === 'boolean' ? version.minorEdit : undefined,
  };
}
