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
import type { AtlassianConfig } from '../src/config.js';
import { JiraClient } from '../src/jira-client.js';
import { respondJson, startTestServer, type TestServer } from './support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function makeConfig(deployment: AtlassianConfig['deployment']): AtlassianConfig {
  return {
    url: server.baseUrl,
    deployment,
    auth:
      deployment === 'cloud'
        ? { kind: 'basic', username: 'user@example.com', apiToken: 'token' }
        : { kind: 'bearer', personalToken: 'pat' },
  };
}

describe('JiraClient on Cloud', () => {
  it('fetches issues from /rest/api/3 with Basic auth', async () => {
    server.route('/rest/api/3/issue/PROJ-1', (req, res) => {
      respondJson(res, 200, { key: 'PROJ-1', authorization: req.headers.authorization });
    });

    const issue = (await new JiraClient(makeConfig('cloud')).getIssue('PROJ-1')) as {
      key: string;
      authorization: string;
    };

    expect(issue.key).toBe('PROJ-1');
    expect(issue.authorization).toMatch(/^Basic /);
  });

  it('searches via POST /search/jql and follows nextPageToken', async () => {
    server.route('/rest/api/3/search/jql', (_req, res, body) => {
      const parsed = JSON.parse(body) as { nextPageToken?: string };
      if (parsed.nextPageToken === 'page-2') {
        respondJson(res, 200, { issues: [{ key: 'PROJ-2' }], isLast: true });
      } else {
        respondJson(res, 200, { issues: [{ key: 'PROJ-1' }], nextPageToken: 'page-2', isLast: false });
      }
    });

    const client = new JiraClient(makeConfig('cloud'));
    const first = await client.searchIssues({ jql: 'project = PROJ' });

    expect(first.issues).toEqual([{ key: 'PROJ-1' }]);
    expect(first.isLast).toBe(false);
    expect(first.nextPageToken).toBe('page-2');

    const second = await client.searchIssues({ jql: 'project = PROJ', nextPageToken: first.nextPageToken });

    expect(second.issues).toEqual([{ key: 'PROJ-2' }]);
    expect(second.isLast).toBe(true);
    expect(server.requests.every((request) => request.method === 'POST')).toBe(true);
  });

  it('pages and normalizes the changelog endpoint', async () => {
    server.route('/rest/api/3/issue/PROJ-1/changelog', (req, res) => {
      const startAt = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('startAt'));
      if (startAt === 1) {
        respondJson(res, 200, {
          values: [{ id: '2', author: { displayName: 'Bob' }, created: '2026-09-08T02:00:00.000Z', items: [] }],
          total: 2,
          isLast: true,
        });
        return;
      }
      respondJson(res, 200, {
        values: [
          {
            id: '1',
            author: { displayName: 'Alice' },
            created: '2026-09-08T01:00:00.000Z',
            items: [{ field: 'status', fromString: 'Open', toString: 'Done', from: '1', to: '5' }],
          },
        ],
        total: 2,
        isLast: false,
      });
    });

    const result = await new JiraClient(makeConfig('cloud')).getAllChangelog('PROJ-1', 2);

    expect(result.entries).toEqual([
      {
        id: '1',
        author: 'Alice',
        created: '2026-09-08T01:00:00.000Z',
        items: [{ field: 'status', fromString: 'Open', toString: 'Done', from: '1', to: '5' }],
      },
      { id: '2', author: 'Bob', created: '2026-09-08T02:00:00.000Z', items: [] },
    ]);
    expect(result.total).toBe(2);
    expect(result.complete).toBe(true);
    expect(server.requests.map((request) => new URL(request.url, 'http://127.0.0.1').pathname)).toEqual([
      '/rest/api/3/issue/PROJ-1/changelog',
      '/rest/api/3/issue/PROJ-1/changelog',
    ]);
  });
});

describe('JiraClient on Server/DC', () => {
  it('fetches issues from /rest/api/2 with Bearer auth', async () => {
    server.route('/rest/api/2/issue/PROJ-1', (req, res) => {
      respondJson(res, 200, { key: 'PROJ-1', authorization: req.headers.authorization });
    });

    const issue = (await new JiraClient(makeConfig('server')).getIssue('PROJ-1')) as {
      key: string;
      authorization: string;
    };

    expect(issue.key).toBe('PROJ-1');
    expect(issue.authorization).toBe('Bearer pat');
  });

  it('reads and normalizes the expanded issue changelog response', async () => {
    server.route('/rest/api/2/issue/PROJ-1', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(url.searchParams.get('expand')).toBe('changelog');
      respondJson(res, 200, {
        key: 'PROJ-1',
        changelog: {
          startAt: 0,
          maxResults: 2,
          total: 2,
          histories: [
            {
              id: '7',
              author: { displayName: 'Alice', name: 'alice', emailAddress: 'alice@example.test' },
              created: '2026-09-08T01:00:00.000Z',
              historyMetadata: { type: 'automation' },
              items: [{ field: 'assignee', from: null, to: 'alice' }],
            },
            { id: '8', author: { displayName: 'Bob' }, created: '2026-09-08T02:00:00.000Z', items: [] },
          ],
        },
      });
    });

    const result = await new JiraClient(makeConfig('server')).getAllChangelog('PROJ-1', 50);

    expect(result).toEqual({
      entries: [
        {
          id: '7',
          author: 'Alice',
          created: '2026-09-08T01:00:00.000Z',
          items: [{ field: 'assignee', fromString: undefined, toString: undefined, from: null, to: 'alice' }],
        },
        { id: '8', author: 'Bob', created: '2026-09-08T02:00:00.000Z', items: [] },
      ],
      rawEntries: [
        {
          id: '7',
          author: { displayName: 'Alice', name: 'alice', emailAddress: 'alice@example.test' },
          created: '2026-09-08T01:00:00.000Z',
          historyMetadata: { type: 'automation' },
          items: [{ field: 'assignee', from: null, to: 'alice' }],
        },
        { id: '8', author: { displayName: 'Bob' }, created: '2026-09-08T02:00:00.000Z', items: [] },
      ],
      total: 2,
      pages: 1,
      complete: true,
    });
    expect(server.requests.map((request) => new URL(request.url, 'http://127.0.0.1').pathname)).toEqual([
      '/rest/api/2/issue/PROJ-1',
    ]);
  });

  it('reports a capped expanded changelog as incomplete', async () => {
    server.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
      respondJson(res, 200, {
        changelog: {
          startAt: 0,
          maxResults: 2,
          total: 3,
          histories: [
            { id: '7', author: { displayName: 'Alice' }, items: [] },
            { id: '8', author: { displayName: 'Bob' }, items: [] },
          ],
        },
      });
    });

    const result = await new JiraClient(makeConfig('server')).getAllChangelog('PROJ-1', 50);

    expect(result.entries.map((entry) => entry.id)).toEqual(['7', '8']);
    expect(result.total).toBe(3);
    expect(result.complete).toBe(false);
    expect(result.pages).toBe(1);
  });

  it('searches via GET /search and pages with startAt against total', async () => {
    server.route('/rest/api/2/search', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const startAt = Number(url.searchParams.get('startAt'));
      if (startAt === 0) {
        respondJson(res, 200, { issues: [{ key: 'PROJ-1' }], total: 2 });
      } else {
        respondJson(res, 200, { issues: [{ key: 'PROJ-2' }], total: 2 });
      }
    });

    const client = new JiraClient(makeConfig('server'));
    const first = await client.searchIssues({ jql: 'project = PROJ', maxResults: 1 });

    expect(first.issues).toEqual([{ key: 'PROJ-1' }]);
    expect(first.isLast).toBe(false);
    expect(first.nextStartAt).toBe(1);

    const second = await client.searchIssues({ jql: 'project = PROJ', maxResults: 1, startAt: first.nextStartAt });

    expect(second.issues).toEqual([{ key: 'PROJ-2' }]);
    expect(second.isLast).toBe(true);
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('treats a short page as the last one when total is absent', async () => {
    server.route('/rest/api/2/search', (_req, res) => {
      respondJson(res, 200, { issues: [{ key: 'PROJ-1' }], maxResults: 50 });
    });

    const page = await new JiraClient(makeConfig('server')).searchIssues({ jql: 'project = PROJ', maxResults: 50 });

    expect(page.isLast).toBe(true);
  });

  it('keeps paging when the instance caps maxResults below what was requested', async () => {
    // total absent, 3 issues returned, caller asked for 50 — but the instance capped the page
    // at 3 (its own maxResults). A capped-but-full page must NOT read as the last one.
    server.route('/rest/api/2/search', (_req, res) => {
      respondJson(res, 200, { issues: [{ key: 'A' }, { key: 'B' }, { key: 'C' }], maxResults: 3 });
    });

    const page = await new JiraClient(makeConfig('server')).searchIssues({ jql: 'project = PROJ', maxResults: 50 });

    expect(page.isLast).toBe(false);
    expect(page.nextStartAt).toBe(3);
  });

  it('stops paging when a non-last page carries no usable cursor', async () => {
    // A proxy or older instance can answer isLast:false with no token; repeating the identical
    // request would return the same issues until the limit was filled.
    let calls = 0;
    server.route('/rest/api/3/search/jql', (_req, res) => {
      calls += 1;
      respondJson(res, 200, { issues: [{ key: 'PROJ-1' }], isLast: false });
    });

    const result = await new JiraClient(makeConfig('cloud')).searchAllIssues({ jql: 'project = PROJ' }, 50);

    expect(calls).toBe(1);
    expect(result.issues).toEqual([{ key: 'PROJ-1' }]);
    expect(result.complete).toBe(true);
  });

  it('builds ADF paragraphs a Cloud validator accepts', async () => {
    // Found in review: an ADF text node may not contain a newline, and a paragraph with no
    // content is rejected outright, so both used to make a create fail over formatting.
    const client = new JiraClient(makeConfig('cloud'));
    const single = client.descriptionValue('line1\nline2') as { content: Array<{ content: unknown[] }> };

    expect(single.content).toHaveLength(1);
    expect(single.content[0]?.content).toEqual([
      { type: 'text', text: 'line1' },
      { type: 'hardBreak' },
      { type: 'text', text: 'line2' },
    ]);

    const paragraphs = client.descriptionValue('one\n\ntwo') as { content: unknown[] };
    expect(paragraphs.content).toHaveLength(2);

    // No empty paragraphs, whatever the whitespace.
    for (const text of ['', '   ', '\n\n', '\n\nfoo', 'foo\n\n']) {
      const doc = client.descriptionValue(text) as { content: Array<{ content: unknown[] }> };
      for (const paragraph of doc.content) expect(paragraph.content.length).toBeGreaterThan(0);
    }
    expect((client.descriptionValue('   ') as { content: unknown[] }).content).toEqual([]);
  });

  it('sends a description as a plain string on Server/DC', () => {
    expect(new JiraClient(makeConfig('server')).descriptionValue('line1\nline2')).toBe('line1\nline2');
  });

  it('omits the fields param entirely for an empty fields array', async () => {
    server.route('/rest/api/2/issue/PROJ-9', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      respondJson(res, 200, { hasFieldsParam: url.searchParams.has('fields') });
    });

    const issue = (await new JiraClient(makeConfig('server')).getIssue('PROJ-9', { fields: [] })) as {
      hasFieldsParam: boolean;
    };

    expect(issue.hasFieldsParam).toBe(false);
  });
});
