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
import JiraIssueSearch from '../../../../src/commands/jira/issue/search.js';
import { respondJson, startTestServer, type TestServer } from '../../../core/support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

interface SearchOutcome {
  issues: unknown[];
  total?: number;
  pages: number;
  complete: boolean;
}

describe('jira issue search', () => {
  it('follows pages until the instance reports no more', async () => {
    server.route('/rest/api/2/search', (req, res) => {
      const startAt = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('startAt'));
      respondJson(res, 200, {
        issues: [{ key: startAt === 0 ? 'PROJ-1' : 'PROJ-2' }],
        total: 2,
        maxResults: 1,
      });
    });

    const result = (await JiraIssueSearch.run(argv('--jql', 'project = PROJ', '--limit', '10'))) as SearchOutcome;

    expect(result.issues).toEqual([{ key: 'PROJ-1' }, { key: 'PROJ-2' }]);
    expect(result.pages).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('stops at --limit and reports the results as incomplete', async () => {
    server.route('/rest/api/2/search', (_req, res) => {
      respondJson(res, 200, { issues: [{ key: 'PROJ-1' }, { key: 'PROJ-2' }], total: 500, maxResults: 2 });
    });

    const result = (await JiraIssueSearch.run(argv('--jql', 'order by updated desc', '--limit', '2'))) as SearchOutcome;

    expect(result.issues).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.total).toBe(500);
  });

  it('never requests more issues than the caller wants', async () => {
    let requestedMax: string | null = null;
    server.route('/rest/api/2/search', (req, res) => {
      requestedMax = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('maxResults');
      respondJson(res, 200, { issues: [{ key: 'PROJ-1' }], total: 1, maxResults: 1 });
    });

    await JiraIssueSearch.run(argv('--jql', 'project = PROJ', '--limit', '3'));

    expect(requestedMax).toBe('3');
  });

  it('handles an empty result set without erroring', async () => {
    server.route('/rest/api/2/search', (_req, res) => {
      respondJson(res, 200, { issues: [], total: 0, maxResults: 50 });
    });

    const result = (await JiraIssueSearch.run(argv('--jql', 'project = EMPTY'))) as SearchOutcome;

    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('requires --jql', async () => {
    const error = (await JiraIssueSearch.run(argv()).catch((caught: unknown) => caught)) as { message: string };

    expect(error.message).toContain('jql');
  });
});
