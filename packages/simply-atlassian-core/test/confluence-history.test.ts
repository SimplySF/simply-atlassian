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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlassianConfig } from '../src/config.js';
import { ConfluenceClient } from '../src/confluence-client.js';
import { pageHistoryJson } from '../src/confluence-history.js';
import { HttpError } from '../src/errors.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function client(deployment: AtlassianConfig['deployment']): ConfluenceClient {
  return new ConfluenceClient(
    deployment === 'cloud'
      ? {
          url: `${server.baseUrl}/wiki`,
          deployment,
          auth: { kind: 'basic', username: 'user@example.com', apiToken: 'token' },
        }
      : { url: server.baseUrl, deployment, auth: { kind: 'bearer', personalToken: 'pat' } },
  );
}

function query(url: string): URLSearchParams {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

function cloudVersion(number: number, authorId: string, message = ''): Record<string, unknown> {
  return { number, authorId, message, minorEdit: number % 2 === 0, createdAt: `2026-10-${10 + number}T09:00:00.000Z` };
}

describe('ConfluenceClient.getAllPageVersions on Cloud', () => {
  it('follows the v2 cursor newest first and resolves author names once each', async () => {
    server.route('/wiki/api/v2/pages/123/versions', (req, res) => {
      const params = query(req.url ?? '/');
      if (params.get('cursor') === null) {
        respondJson(res, 200, {
          results: [cloudVersion(3, 'acc-a', 'third'), cloudVersion(2, 'acc-b')],
          _links: { next: '/wiki/api/v2/pages/123/versions?cursor=abc&limit=2', base: 'https://evil.example' },
        });
      } else {
        respondJson(res, 200, { results: [cloudVersion(1, 'acc-a', 'first')], _links: {} });
      }
    });
    server.route('/wiki/rest/api/user/bulk', (_req, res) => {
      respondJson(res, 200, {
        results: [
          { accountId: 'acc-a', displayName: 'Ada Lovelace' },
          { accountId: 'acc-b', displayName: 'Grace Hopper' },
        ],
      });
    });

    const history = await client('cloud').getAllPageVersions('123', 10);

    expect(history.complete).toBe(true);
    expect(history.versions).toEqual([
      { number: 3, author: 'Ada Lovelace', message: 'third', minorEdit: false, when: '2026-10-13T09:00:00.000Z' },
      { number: 2, author: 'Grace Hopper', message: undefined, minorEdit: true, when: '2026-10-12T09:00:00.000Z' },
      { number: 1, author: 'Ada Lovelace', message: 'first', minorEdit: false, when: '2026-10-11T09:00:00.000Z' },
    ]);
    expect(history.rawEntries.map((raw) => (raw as { number: number }).number)).toEqual([3, 2, 1]);

    const [first, second, bulk] = server.requests;
    expect(query(first.url).get('sort')).toBe('-modified-date');
    expect(query(first.url).get('limit')).toBe('10');
    // Only the cursor is taken from the link; the request stays on the configured host.
    expect(query(second.url).get('cursor')).toBe('abc');
    expect(query(bulk.url).getAll('accountId')).toEqual(['acc-a', 'acc-b']);
  });

  it('caps the page size at 250 and reports a limit-truncated history as incomplete', async () => {
    server.route('/wiki/api/v2/pages/123/versions', (_req, res) => {
      respondJson(res, 200, {
        results: [cloudVersion(9, 'acc-a'), cloudVersion(8, 'acc-a')],
        _links: { next: '/wiki/api/v2/pages/123/versions?cursor=more' },
      });
    });
    server.route('/wiki/rest/api/user/bulk', (_req, res) => respondJson(res, 200, { results: [] }));

    const history = await client('cloud').getAllPageVersions('123', 2);

    expect(history.complete).toBe(false);
    expect(history.versions).toHaveLength(2);
    expect(server.requests.filter((r) => r.url.includes('/versions'))).toHaveLength(1);

    await client('cloud').getAllPageVersions('123', 1000);
    const big = server.requests.find((r) => r.url.includes('/versions') && query(r.url).get('limit') !== '2');
    expect(query(big?.url ?? '').get('limit')).toBe('250');
  });

  it('falls back to account ids when the user lookup is refused', async () => {
    server.route('/wiki/api/v2/pages/123/versions', (_req, res) => {
      respondJson(res, 200, { results: [cloudVersion(1, 'acc-a')], _links: {} });
    });
    server.route('/wiki/rest/api/user/bulk', (_req, res) => respondJson(res, 403, { message: 'nope' }));

    const history = await client('cloud').getAllPageVersions('123', 5);

    expect(history.versions[0].author).toBe('acc-a');
  });

  it('surfaces an unknown page as the instance 404', async () => {
    await expect(client('cloud').getAllPageVersions('999', 5)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('ConfluenceClient.getAllPageVersions on Server/DC', () => {
  function serverVersion(number: number, name: string): Record<string, unknown> {
    return {
      number,
      by: { displayName: name, username: name.toLowerCase() },
      when: `2026-09-0${number}`,
      message: `v${number}`,
    };
  }

  it('pages the experimental endpoint with start and sorts newest first', async () => {
    server.route('/rest/experimental/content/123/version', (req, res) => {
      const start = Number(query(req.url ?? '/').get('start'));
      if (start === 0) {
        respondJson(res, 200, {
          results: [serverVersion(1, 'Ada'), serverVersion(2, 'Grace')],
          start: 0,
          _links: { next: '/rest/experimental/content/123/version?start=2' },
        });
      } else {
        respondJson(res, 200, { results: [serverVersion(3, 'Ada')], start: 2, _links: {} });
      }
    });

    const history = await client('server').getAllPageVersions('123', 10);

    expect(history.complete).toBe(true);
    expect(history.versions.map((v) => [v.number, v.author, v.message])).toEqual([
      [3, 'Ada', 'v3'],
      [2, 'Grace', 'v2'],
      [1, 'Ada', 'v1'],
    ]);
    expect(server.requests.map((r) => query(r.url).get('start'))).toEqual(['0', '2']);
    expect(server.requests.some((r) => r.url.includes('user/bulk'))).toBe(false);
  });

  it('walks historical versions when the experimental endpoint is gone, skipping deleted ones', async () => {
    server.route('/rest/api/content/123', (req, res) => {
      const params = query(req.url ?? '/');
      const version = params.get('version');
      if (params.get('status') !== 'historical') {
        respondJson(res, 200, { id: '123', version: serverVersion(4, 'Ada') });
      } else if (version === '3') {
        respondJson(res, 404, { message: 'No content found with id 123 and version 3' });
      } else {
        respondJson(res, 200, { id: '123', version: serverVersion(Number(version), 'Grace') });
      }
    });

    const all = await client('server').getAllPageVersions('123', 10);
    expect(all.complete).toBe(true);
    expect(all.versions.map((v) => v.number)).toEqual([4, 2, 1]);

    server.requests.length = 0;
    const limited = await client('server').getAllPageVersions('123', 2);
    expect(limited.complete).toBe(false);
    expect(limited.versions.map((v) => v.number)).toEqual([4, 2]);
    // The walk stops as soon as it has enough, rather than reading the whole history.
    expect(server.requests.some((r) => query(r.url).get('version') === '1')).toBe(false);
  });

  it('reports an unknown page from the walk when the experimental endpoint 404s too', async () => {
    await expect(client('server').getAllPageVersions('999', 5)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('pageHistoryJson', () => {
  it('carries only the raw entries and completeness', () => {
    expect(pageHistoryJson({ versions: [{ number: 1 }], rawEntries: [{ number: 1 }], complete: false })).toEqual({
      rawEntries: [{ number: 1 }],
      complete: false,
    });
  });
});
