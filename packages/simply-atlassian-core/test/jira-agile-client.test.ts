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
import { JiraClient } from '../src/jira-client.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function makeClient(): JiraClient {
  const config: AtlassianConfig = {
    url: server.baseUrl,
    deployment: 'server',
    auth: { kind: 'bearer', personalToken: 'pat' },
  };
  return new JiraClient(config);
}

describe('JiraClient agile endpoints', () => {
  it('pages boards through values and preserves filters', async () => {
    server.route('/rest/agile/1.0/board', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const startAt = Number(url.searchParams.get('startAt'));
      if (startAt === 0) {
        expect(url.searchParams.get('projectKeyOrId')).toBe('PROJ');
        expect(url.searchParams.get('type')).toBe('scrum');
        respondJson(res, 200, { values: [{ id: 1 }], total: 2, isLast: false });
      } else {
        respondJson(res, 200, { values: [{ id: 2 }], total: 2, isLast: true });
      }
    });

    const result = await makeClient().getBoards({ projectKeyOrId: 'PROJ', type: 'scrum', maxResults: 1 });

    expect(result.values).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.pages).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('uses agile paths and query parameters for sprints and sprint issues', async () => {
    server.route('/rest/agile/1.0/board/7/sprint', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(url.searchParams.get('state')).toBe('active,future');
      respondJson(res, 200, { values: [{ id: 11, name: 'Current' }], isLast: true });
    });
    server.route('/rest/agile/1.0/sprint/11/issue', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(url.searchParams.get('fields')).toBe('summary,status');
      const startAt = Number(url.searchParams.get('startAt'));
      if (startAt === 0) {
        respondJson(res, 200, { issues: [{ key: 'PROJ-1' }], total: 2, isLast: false });
      } else {
        respondJson(res, 200, { issues: [{ key: 'PROJ-2' }], total: 2, isLast: true });
      }
    });

    expect((await makeClient().getSprints('7', { state: 'active,future' })).values).toEqual([
      { id: 11, name: 'Current' },
    ]);
    expect((await makeClient().getSprintIssues('11', { fields: ['summary', 'status'], maxResults: 1 })).values).toEqual(
      [{ key: 'PROJ-1' }, { key: 'PROJ-2' }],
    );
  });

  it("chunks sprint writes at Jira's 50-issue limit", async () => {
    const sent: string[][] = [];
    server.route('/rest/agile/1.0/sprint/11/issue', (req, res, body) => {
      expect(req.method).toBe('POST');
      sent.push((JSON.parse(body) as { issues: string[] }).issues);
      res.writeHead(204);
      res.end();
    });

    const issues = Array.from({ length: 51 }, (_, index) => `PROJ-${index + 1}`);
    const result = await makeClient().moveIssuesToSprint('11', issues);

    expect(result).toEqual({ chunks: 2, issueCount: 51 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(50);
    expect(sent[1]).toEqual(['PROJ-51']);
  });
});
