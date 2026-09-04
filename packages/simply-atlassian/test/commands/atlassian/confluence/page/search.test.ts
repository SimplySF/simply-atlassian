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
import ConfluencePageSearch from '../../../../../src/commands/atlassian/confluence/page/search.js';
import { respondJson, startTestServer, type TestServer } from '../../../../core/support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function argv(...extra: string[]): string[] {
  return ['--confluence-url', server.baseUrl, '--confluence-personal-token', 'pat', ...extra];
}

interface Outcome {
  results: unknown[];
  size?: number;
  pages: number;
  complete: boolean;
}

describe('confluence page search', () => {
  it('follows pages until the instance stops offering a next link', async () => {
    server.route('/rest/api/content/search', (req, res) => {
      const start = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('start'));
      if (start === 0) {
        respondJson(res, 200, {
          results: [{ id: '1', title: 'One' }],
          totalSize: 2,
          _links: { next: '/rest/api/content/search?start=1' },
        });
      } else {
        respondJson(res, 200, { results: [{ id: '2', title: 'Two' }], totalSize: 2 });
      }
    });

    const result = (await ConfluencePageSearch.run(argv('--cql', 'type = page', '--limit', '10'))) as Outcome;

    expect(result.pages).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  it('stops at --limit and reports the results as incomplete', async () => {
    server.route('/rest/api/content/search', (_req, res) => {
      respondJson(res, 200, {
        results: [{ id: '1' }, { id: '2' }],
        totalSize: 500,
        _links: { next: '/next' },
      });
    });

    const result = (await ConfluencePageSearch.run(argv('--cql', 'type = page', '--limit', '2'))) as Outcome;

    expect(result.results).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.size).toBe(500);
  });

  it('stops rather than looping when a next link comes with no results', async () => {
    let calls = 0;
    server.route('/rest/api/content/search', (_req, res) => {
      calls += 1;
      respondJson(res, 200, { results: [], _links: { next: '/next' } });
    });

    const result = (await ConfluencePageSearch.run(argv('--cql', 'type = page'))) as Outcome;

    expect(calls).toBe(1);
    expect(result.complete).toBe(true);
  });

  it('handles an empty result set', async () => {
    server.route('/rest/api/content/search', (_req, res) => {
      respondJson(res, 200, { results: [], size: 0 });
    });

    const result = (await ConfluencePageSearch.run(argv('--cql', 'type = blogpost'))) as Outcome;

    expect(result.results).toEqual([]);
  });

  it('requires --cql', async () => {
    const error = (await ConfluencePageSearch.run(argv()).catch((caught: unknown) => caught)) as { message: string };

    expect(error.message).toContain('cql');
  });
});
