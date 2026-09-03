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

  public getPage(pageId: string, options: { expand?: string[] } = {}): Promise<unknown> {
    const expand = options.expand ?? ['body.storage', 'version', 'space'];
    return this.request(`/content/${encodeURIComponent(pageId)}`, {
      method: 'GET',
      query: { expand: expand.join(',') },
    });
  }

  public searchPages(cql: string, options: { limit?: number; start?: number } = {}): Promise<unknown> {
    return this.request('/content/search', {
      method: 'GET',
      query: { cql, limit: options.limit ?? DEFAULT_LIMIT, start: options.start },
    });
  }

  public getPageChildren(pageId: string, options: { limit?: number; start?: number } = {}): Promise<unknown> {
    return this.request(`/content/${encodeURIComponent(pageId)}/child/page`, {
      method: 'GET',
      query: { limit: options.limit ?? DEFAULT_LIMIT, start: options.start },
    });
  }

  private request<T>(path: string, call: Omit<JsonCall, 'path'>): Promise<T> {
    return this.transport.json<T>({ ...call, path: `${API_BASE}${path}` });
  }
}
