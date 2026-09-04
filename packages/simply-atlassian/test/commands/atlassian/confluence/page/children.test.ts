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
import ConfluencePageChildren from '../../../../../src/commands/atlassian/confluence/page/children.js';
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

describe('confluence page children', () => {
  it('lists the direct children of a page', async () => {
    server.route('/rest/api/content/123456/child/page', (_req, res) => {
      respondJson(res, 200, { results: [{ id: '1', title: 'Child', status: 'current' }], size: 1 });
    });

    const response = (await ConfluencePageChildren.run(argv('123456'))) as { results: unknown[] };

    expect(response.results).toHaveLength(1);
  });

  it('accepts a page URL in place of an id', async () => {
    server.route('/rest/api/content/123456/child/page', (_req, res) => {
      respondJson(res, 200, { results: [], size: 0 });
    });

    await expect(
      ConfluencePageChildren.run(argv('https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title')),
    ).resolves.toBeDefined();
  });

  it('forwards --limit to the instance', async () => {
    let limit: string | null = null;
    server.route('/rest/api/content/123456/child/page', (req, res) => {
      limit = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('limit');
      respondJson(res, 200, { results: [], size: 0 });
    });

    await ConfluencePageChildren.run(argv('123456', '--limit', '50'));

    expect(limit).toBe('50');
  });

  it('handles a page with no children', async () => {
    server.route('/rest/api/content/123456/child/page', (_req, res) => {
      respondJson(res, 200, { results: [], size: 0 });
    });

    const response = (await ConfluencePageChildren.run(argv('123456'))) as { results: unknown[] };

    expect(response.results).toEqual([]);
  });
});
