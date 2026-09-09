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

export interface JiraAgileResult {
  readonly values: unknown[];
  readonly total?: number;
  readonly pages: number;
  /** False when the caller's limit cut the results short. */
  readonly complete: boolean;
}

/** One field change in a Jira issue history entry, normalized across deployments. */
export interface JiraChangelogItem {
  readonly field: string;
  readonly fromString?: unknown;
  readonly toString?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

/** One grouped set of field changes made at the same time by the same user. */
export interface JiraChangelogEntry {
  readonly id: string;
  readonly author?: string;
  readonly created?: string;
  readonly items: JiraChangelogItem[];
}

/** A deployment-independent changelog page. Cloud supplies a token; Server/DC uses an offset. */
export interface JiraChangelogPage {
  readonly entries: JiraChangelogEntry[];
  /** Original history entries, retained for consumers that need Jira's complete audit record. */
  readonly rawEntries: unknown[];
  readonly total?: number;
  readonly isLast: boolean;
  readonly nextStartAt?: number;
}

/** The flat result returned after following changelog pages up to the caller's limit. */
export interface JiraChangelogResult {
  readonly entries: JiraChangelogEntry[];
  /** Original history entries in the same order as `entries`, before normalization. */
  readonly rawEntries: unknown[];
  readonly total?: number;
  readonly pages: number;
  readonly complete: boolean;
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

interface RawChangelogItem {
  readonly field?: unknown;
  readonly fromString?: unknown;
  readonly toString?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

interface RawChangelogEntry {
  readonly id?: unknown;
  readonly author?: { readonly displayName?: unknown };
  readonly created?: unknown;
  readonly items?: RawChangelogItem[];
}

interface CloudChangelogResponse {
  readonly values?: RawChangelogEntry[];
  readonly total?: number;
  readonly isLast?: boolean;
}

interface ServerChangelogResponse {
  readonly histories?: RawChangelogEntry[];
  readonly startAt?: number;
  readonly total?: number;
  /** The instance's effective page size, which may be smaller than what was asked for. */
  readonly maxResults?: number;
}

/** Server/DC exposes history by expanding the issue rather than a changelog subresource. */
interface ServerIssueResponse {
  readonly changelog?: ServerChangelogResponse;
}

const DEFAULT_MAX_RESULTS = 50;
/** Jira accepts at most this many issue keys per sprint-move request; longer lists are chunked. */
export const MAX_ISSUES_PER_SPRINT_MOVE = 50;
const AGILE_BASE = '/rest/agile/1.0';

/**
 * Jira REST client. Owns the one thing callers should never have to think about: Cloud speaks
 * `/rest/api/3` and pages with an opaque `nextPageToken`, while Server/Data Center speaks
 * `/rest/api/2` and pages with numeric `startAt` offsets.
 */
export class JiraClient {
  /**
   * Exposed because callers building a request body need to know which shape the instance
   * expects. Inferring it from the data — "this body is a string, so it must be Server" — is
   * how mentions ended up silently dropped on Cloud.
   */
  public readonly deployment: AtlassianConfig['deployment'];
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

  /** Gets one changelog page and hides the Cloud versus Server/DC retrieval difference. */
  public async getChangelog(
    issueKey: string,
    options: { startAt?: number; maxResults?: number } = {},
  ): Promise<JiraChangelogPage> {
    if (this.deployment !== 'cloud') {
      const response = await this.request<ServerIssueResponse>(`/issue/${encodeURIComponent(issueKey)}`, {
        method: 'GET',
        query: { expand: 'changelog' },
      });
      const changelog = response.changelog;
      const rawEntries = changelog?.histories ?? [];
      const responseStartAt = changelog?.startAt ?? 0;
      return {
        entries: normalizeChangelogEntries(rawEntries),
        rawEntries,
        total: changelog?.total,
        // Expanded Server/DC changelogs have no supported follow-up endpoint. A capped response
        // must remain visibly incomplete instead of being presented as a complete history.
        isLast: changelog?.total === undefined || responseStartAt + rawEntries.length >= changelog.total,
      };
    }

    const startAt = options.startAt ?? 0;
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const response = await this.request<CloudChangelogResponse>(`/issue/${encodeURIComponent(issueKey)}/changelog`, {
      method: 'GET',
      query: { startAt, maxResults },
    });
    const entries = normalizeChangelogEntries(response.values);
    const nextStartAt = startAt + entries.length;
    return {
      entries,
      rawEntries: response.values ?? [],
      total: response.total,
      isLast:
        response.isLast ?? (response.total === undefined ? entries.length < maxResults : nextStartAt >= response.total),
      nextStartAt,
    };
  }

  /** Follows the deployment's changelog pagination until the limit or the full history is read. */
  public async getAllChangelog(issueKey: string, limit: number): Promise<JiraChangelogResult> {
    const collected: JiraChangelogEntry[] = [];
    const rawEntries: unknown[] = [];
    let startAt = 0;
    let total: number | undefined;
    let pages = 0;

    /* Paging is sequential by definition: each request needs the previous page's cursor. */
    /* eslint-disable no-await-in-loop */
    while (collected.length < limit) {
      const page = await this.getChangelog(issueKey, {
        startAt,
        maxResults: Math.min(DEFAULT_MAX_RESULTS, limit - collected.length),
      });
      pages += 1;
      collected.push(...page.entries);
      rawEntries.push(...page.rawEntries);
      total = typeof page.total === 'number' ? page.total : total;

      const nextStartAt = page.nextStartAt;
      const canAdvance = nextStartAt !== undefined && nextStartAt > startAt;
      const reachedLimit = collected.length >= limit;
      const moreEntries = total === undefined ? !page.isLast || collected.length > limit : total > limit;
      if (reachedLimit || page.isLast || page.entries.length === 0 || !canAdvance) {
        return {
          entries: collected.slice(0, limit),
          rawEntries: rawEntries.slice(0, limit),
          total,
          pages,
          // A Server/DC expanded response can state that more history exists but offer no
          // supported cursor. Preserve that incomplete state for callers instead of claiming
          // the truncated response is the full audit trail.
          complete: page.isLast && (!reachedLimit || !moreEntries),
        };
      }
      startAt = nextStartAt;
    }
    /* eslint-enable no-await-in-loop */

    return {
      entries: collected.slice(0, limit),
      rawEntries: rawEntries.slice(0, limit),
      total,
      pages,
      complete: false,
    };
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

  /**
   * Wraps plain text in the shape the deployment expects. Jira Cloud requires an Atlassian
   * Document Format object for a description; Server/DC takes a string. Callers pass text and
   * this decides, which is the whole reason the client knows about deployments.
   */
  public descriptionValue(text: string): unknown {
    if (this.deployment !== 'cloud') return text;
    return { type: 'doc', version: 1, content: adfParagraphs(text) };
  }

  public createIssue(body: Record<string, unknown>): Promise<unknown> {
    return this.request('/issue', { method: 'POST', body, mutating: true });
  }

  /** Jira answers 204 with no body, so there is nothing to return and nothing to verify. */
  public async updateIssue(issueKey: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}`, { method: 'PUT', body, mutating: true });
  }

  public async deleteIssue(issueKey: string, options: { deleteSubtasks?: boolean } = {}): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}`, {
      method: 'DELETE',
      mutating: true,
      // Only sent when asked: Jira's own error for an issue with subtasks is more useful than
      // quietly deciding on the caller's behalf what happens to them.
      query: { deleteSubtasks: options.deleteSubtasks === true ? 'true' : undefined },
    });
  }

  public addComment(issueKey: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}/comment`, { method: 'POST', body, mutating: true });
  }

  public getComments(issueKey: string, options: { startAt?: number; maxResults?: number } = {}): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'GET',
      query: { startAt: options.startAt, maxResults: options.maxResults },
    });
  }

  public updateComment(issueKey: string, commentId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
      method: 'PUT',
      body,
      mutating: true,
    });
  }

  public async deleteComment(issueKey: string, commentId: string): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
      mutating: true,
    });
  }

  /**
   * Cloud searches by a free-text `query`; Server/DC by `username`. Same intent, different
   * parameter, so the client owns the difference as it does everywhere else.
   */
  public searchUsers(query: string, maxResults = 20): Promise<unknown> {
    const key = this.deployment === 'cloud' ? 'query' : 'username';
    return this.request('/user/search', { method: 'GET', query: { [key]: query, maxResults } });
  }

  public getUser(account: string): Promise<unknown> {
    const key = this.deployment === 'cloud' ? 'accountId' : 'username';
    return this.request('/user', { method: 'GET', query: { [key]: account } });
  }

  /**
   * A mention is a structured node on Cloud and wiki markup on Server/DC. Returning the shape
   * rather than a string keeps the deployment difference out of every caller.
   */
  public mentionValue(accountId: string, display?: string): { adf?: unknown; text?: string } {
    if (this.deployment === 'cloud') {
      // `text` is a fallback Jira shows where it cannot render the pill — a notification email,
      // a text export. Putting a raw account id there reads as a uuid, so it is omitted when no
      // display name is known and Jira resolves the name from the id itself.
      const attrs = display === undefined ? { id: accountId } : { id: accountId, text: `@${display}` };
      return { adf: { type: 'mention', attrs } };
    }
    return { text: `[~${accountId}]` };
  }

  public getLinkTypes(): Promise<unknown> {
    return this.request('/issueLinkType', { method: 'GET' });
  }

  /** Resolves one link, so a command can say what it is about to change. Returns both ends. */
  public getIssueLink(linkId: string): Promise<unknown> {
    return this.request(`/issueLink/${encodeURIComponent(linkId)}`, { method: 'GET' });
  }

  /**
   * Creates an issue link. The caller passes the `inwardIssue`/`outwardIssue` pair already
   * resolved, because working out which end is which from a phrase is a decision with a right
   * and a wrong answer and it belongs in one place — see `shared/issue-links.ts`.
   */
  public createIssueLink(body: Record<string, unknown>): Promise<unknown> {
    return this.request('/issueLink', { method: 'POST', body, mutating: true });
  }

  /** Jira answers 204, so there is nothing to return. */
  public async deleteIssueLink(linkId: string): Promise<void> {
    await this.request(`/issueLink/${encodeURIComponent(linkId)}`, { method: 'DELETE', mutating: true });
  }

  /**
   * Lists projects. Cloud paginates `/project/search`; Server/DC answers `GET /project` with the
   * whole list and no paging, so the deployment difference is absorbed here as it is elsewhere.
   */
  public getProjects(options: { startAt?: number; maxResults?: number } = {}): Promise<unknown> {
    if (this.deployment !== 'cloud') return this.request('/project', { method: 'GET' });
    return this.request('/project/search', {
      method: 'GET',
      query: { startAt: options.startAt, maxResults: options.maxResults },
    });
  }

  /**
   * Lists every field, built-in and custom. Unpaginated on both deployments — a few hundred
   * entries — which is why there is no limit parameter to pass on.
   */
  public getFields(): Promise<unknown> {
    return this.request('/field', { method: 'GET' });
  }

  public getProjectVersions(projectKey: string): Promise<unknown> {
    return this.request(`/project/${encodeURIComponent(projectKey)}/versions`, { method: 'GET' });
  }

  /** Agile endpoints share a base across deployments, so these use it rather than `apiBase`. */
  public createSprint(body: Record<string, unknown>): Promise<unknown> {
    return this.request('/sprint', { method: 'POST', body, mutating: true }, AGILE_BASE);
  }

  public getSprint(sprintId: string): Promise<unknown> {
    return this.request(`/sprint/${encodeURIComponent(sprintId)}`, { method: 'GET' }, AGILE_BASE);
  }

  /**
   * Updates a sprint. Jira treats `POST /sprint/{id}` as a full replacement and clears anything
   * the caller omits, so the caller is expected to send the merged result — see
   * `prepareSprintUpdate`.
   */
  public updateSprint(sprintId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(
      `/sprint/${encodeURIComponent(sprintId)}`,
      { method: 'POST', body, mutating: true },
      AGILE_BASE,
    );
  }

  /**
   * Remote links: an issue's links to things outside Jira — a Confluence page, a document, a
   * dashboard. Distinct from `issueLink`, which only ever joins two Jira issues.
   */
  public getRemoteLinks(issueKey: string): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}/remotelink`, { method: 'GET' });
  }

  public createRemoteLink(issueKey: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}/remotelink`, {
      method: 'POST',
      body,
      mutating: true,
    });
  }

  public async deleteRemoteLink(issueKey: string, linkId: string): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}/remotelink/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      mutating: true,
    });
  }

  public getTransitions(issueKey: string): Promise<unknown> {
    return this.request(`/issue/${encodeURIComponent(issueKey)}/transitions`, { method: 'GET' });
  }

  public async transitionIssue(issueKey: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}/transitions`, { method: 'POST', body, mutating: true });
  }

  /** Agile endpoints share a base across both deployments, so they use it instead of `apiBase`. */
  public getBoards(
    options: {
      readonly projectKeyOrId?: string;
      readonly type?: string;
      readonly startAt?: number;
      readonly maxResults?: number;
      readonly limit?: number;
    } = {},
  ): Promise<JiraAgileResult> {
    return getAllAgile(
      (startAt, maxResults) =>
        this.request<AgilePage>(
          '/board',
          {
            method: 'GET',
            query: {
              projectKeyOrId: options.projectKeyOrId,
              type: options.type,
              startAt,
              maxResults,
            },
          },
          AGILE_BASE,
        ),
      options,
    );
  }

  public getSprints(
    boardId: string,
    options: {
      readonly state?: string;
      readonly startAt?: number;
      readonly maxResults?: number;
      readonly limit?: number;
    } = {},
  ): Promise<JiraAgileResult> {
    return getAllAgile(
      (startAt, maxResults) =>
        this.request<AgilePage>(
          `/board/${encodeURIComponent(boardId)}/sprint`,
          {
            method: 'GET',
            query: { state: options.state, startAt, maxResults },
          },
          AGILE_BASE,
        ),
      options,
    );
  }

  public getSprintIssues(
    sprintId: string,
    options: {
      readonly fields?: string[];
      readonly startAt?: number;
      readonly maxResults?: number;
      readonly limit?: number;
    } = {},
  ): Promise<JiraAgileResult> {
    return getAllAgile(
      (startAt, maxResults) =>
        this.request<AgilePage>(
          `/sprint/${encodeURIComponent(sprintId)}/issue`,
          {
            method: 'GET',
            query: { fields: joinFields(options.fields), startAt, maxResults },
          },
          AGILE_BASE,
        ),
      options,
      (page) => page.issues ?? [],
    );
  }

  public async moveIssuesToSprint(
    sprintId: string,
    issueKeys: readonly string[],
  ): Promise<{ readonly chunks: number; readonly issueCount: number }> {
    let chunks = 0;
    /* eslint-disable no-await-in-loop -- Jira requires each chunk to be sent as its own request. */
    for (let index = 0; index < issueKeys.length; index += MAX_ISSUES_PER_SPRINT_MOVE) {
      const issues = issueKeys.slice(index, index + MAX_ISSUES_PER_SPRINT_MOVE);
      await this.request(
        `/sprint/${encodeURIComponent(sprintId)}/issue`,
        {
          method: 'POST',
          body: { issues },
          mutating: true,
        },
        AGILE_BASE,
      );
      chunks += 1;
    }
    /* eslint-enable no-await-in-loop */
    return { chunks, issueCount: issueKeys.length };
  }

  private request<T>(path: string, call: Omit<JsonCall, 'path'>, base = this.apiBase): Promise<T> {
    return this.transport.json<T>({ ...call, path: `${base}${path}` });
  }
}

interface AgilePage {
  readonly issues?: unknown[];
  readonly values?: unknown[];
  readonly isLast?: boolean;
  readonly total?: number;
}

async function getAllAgile(
  fetchPage: (startAt: number, maxResults: number) => Promise<AgilePage>,
  options: { readonly startAt?: number; readonly maxResults?: number; readonly limit?: number },
  readItems: (page: AgilePage) => unknown[] = (page) => page.values ?? [],
): Promise<JiraAgileResult> {
  const values: unknown[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const pageSize = options.maxResults ?? DEFAULT_MAX_RESULTS;
  let startAt = options.startAt ?? 0;
  let total: number | undefined;
  let pages = 0;

  /* eslint-disable no-await-in-loop -- each page supplies the next page's cursor. */
  while (values.length < limit) {
    const page = await fetchPage(startAt, Math.min(pageSize, limit - values.length));
    pages += 1;
    const pageValues = readItems(page);
    values.push(...pageValues);
    total = typeof page.total === 'number' ? page.total : total;

    const nextStartAt = startAt + pageValues.length;
    const isLast = page.isLast ?? pageValues.length < pageSize;
    const exhausted = isLast || pageValues.length === 0 || nextStartAt <= startAt;
    if (exhausted) return { values: values.slice(0, limit), total, pages, complete: true };
    startAt = nextStartAt;
  }
  /* eslint-enable no-await-in-loop */

  return { values: values.slice(0, limit), total, pages, complete: false };
}

/**
 * Splits plain text into ADF paragraphs. Two rules are not optional: an ADF text node may not
 * contain a newline, so a single line break becomes a `hardBreak` node, and a paragraph with no
 * content is rejected outright by Cloud's validator, so blank segments are dropped rather than
 * emitted. Getting either wrong turns a formatting detail into a failed create.
 */
function adfParagraphs(text: string): unknown[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => {
      const lines = paragraph.split('\n');
      const content: unknown[] = [];
      for (const [index, line] of lines.entries()) {
        if (index > 0) content.push({ type: 'hardBreak' });
        if (line !== '') content.push({ type: 'text', text: line });
      }
      return { type: 'paragraph', content };
    });
}

/** An empty list must mean "default fields", so it is dropped rather than sent as `fields=`. */
function joinFields(fields: string[] | undefined): string | undefined {
  return fields !== undefined && fields.length > 0 ? fields.join(',') : undefined;
}

function normalizeChangelogEntries(entries: RawChangelogEntry[] | undefined): JiraChangelogEntry[] {
  return (entries ?? []).map((entry) => ({
    id: stringifyScalar(entry.id),
    author: typeof entry.author?.displayName === 'string' ? entry.author.displayName : undefined,
    created: typeof entry.created === 'string' ? entry.created : undefined,
    items: (entry.items ?? []).map((item) => ({
      field: typeof item.field === 'string' ? item.field : stringifyScalar(item.field),
      fromString: ownValue(item, 'fromString'),
      toString: ownValue(item, 'toString'),
      from: item.from,
      to: ownValue(item, 'to'),
    })),
  }));
}

function ownValue(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringifyScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}
