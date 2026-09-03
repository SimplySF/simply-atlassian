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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlassianConfig } from '../../src/core/config.js';
import { ConfluenceClient } from '../../src/core/confluence-client.js';
import { respondJson, startTestServer, type TestServer } from './support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function makeCloudConfig(): AtlassianConfig {
  return {
    url: `${server.baseUrl}/wiki`,
    deployment: 'cloud',
    auth: { kind: 'basic', username: 'user@example.com', apiToken: 'token' },
  };
}

describe('ConfluenceClient', () => {
  it('requests pages under the canonicalized /wiki base with default expansions', async () => {
    server.route('/wiki/rest/api/content/123', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      respondJson(res, 200, { id: '123', expand: url.searchParams.get('expand') });
    });

    const page = (await new ConfluenceClient(makeCloudConfig()).getPage('123')) as { id: string; expand: string };

    expect(page.id).toBe('123');
    expect(page.expand).toBe('body.storage,version,space');
  });

  it('searches with CQL and a default limit', async () => {
    server.route('/wiki/rest/api/content/search', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      respondJson(res, 200, { cql: url.searchParams.get('cql'), limit: url.searchParams.get('limit'), results: [] });
    });

    const result = (await new ConfluenceClient(makeCloudConfig()).searchPages('type = page')) as {
      cql: string;
      limit: string;
    };

    expect(result.cql).toBe('type = page');
    expect(result.limit).toBe('25');
  });

  it('lists page children', async () => {
    server.route('/wiki/rest/api/content/123/child/page', (_req, res) => {
      respondJson(res, 200, { results: [{ id: '456' }] });
    });

    const result = (await new ConfluenceClient(makeCloudConfig()).getPageChildren('123')) as {
      results: Array<{ id: string }>;
    };

    expect(result.results).toEqual([{ id: '456' }]);
  });
});
