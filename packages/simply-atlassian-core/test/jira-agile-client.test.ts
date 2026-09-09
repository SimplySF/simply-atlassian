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
import { ConfigError } from '../src/errors.js';
import { buildSprintCreateBody, prepareSprintUpdate } from '../src/jira-agile.js';
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

describe('sprint create', () => {
  it('builds the payload Jira expects, with the board as originBoardId', () => {
    expect(buildSprintCreateBody('42', { name: 'Sprint 7', goal: 'Ship it' })).toEqual({
      name: 'Sprint 7',
      goal: 'Ship it',
      originBoardId: 42,
    });
  });

  it("maps the date flags onto Jira's own field names", () => {
    expect(buildSprintCreateBody('42', { name: 'S', start: '2026-09-15', end: '2026-09-29' })).toMatchObject({
      startDate: '2026-09-15',
      endDate: '2026-09-29',
    });
  });

  it('refuses a sprint with no name', () => {
    expect(() => buildSprintCreateBody('42', {})).toThrow(/needs a --name/);
    expect(() => buildSprintCreateBody('42', { name: '  ' })).toThrow(ConfigError);
  });

  it('refuses a state Jira does not accept', () => {
    expect(() => buildSprintCreateBody('42', { name: 'S', state: 'paused' })).toThrow(/must be one of/);
  });
});

describe('sprint update', () => {
  function routeSprint(sprint: Record<string, unknown>): void {
    server.route('/rest/agile/1.0/sprint/101', (_req, res) => respondJson(res, 200, sprint));
  }

  /*
   * The assertion the command rests on. `POST /sprint/{id}` is a full replacement: Jira clears
   * anything the request omits, so sending only --name would blank the goal and both dates. The
   * sprint is read first and the change applied on top.
   */
  it('merges onto the current sprint rather than clearing what it did not send', async () => {
    routeSprint({
      id: 101,
      name: 'Old',
      goal: 'Keep me',
      startDate: '2026-09-01',
      endDate: '2026-09-14',
      state: 'active',
    });

    const payload = await prepareSprintUpdate(makeClient(), '101', { name: 'New' });

    expect(payload).toEqual({
      name: 'New',
      goal: 'Keep me',
      startDate: '2026-09-01',
      endDate: '2026-09-14',
      state: 'active',
    });
  });

  it('lets a change win over the current value', async () => {
    routeSprint({ id: 101, name: 'S', state: 'active' });

    expect(await prepareSprintUpdate(makeClient(), '101', { state: 'closed' })).toMatchObject({ state: 'closed' });
  });

  it('omits fields the sprint does not have rather than sending undefined', async () => {
    routeSprint({ id: 101, name: 'S' });

    const payload = await prepareSprintUpdate(makeClient(), '101', { goal: 'g' });

    expect(payload).toEqual({ name: 'S', goal: 'g' });
  });

  it('refuses an update with nothing to change, before reading the sprint', async () => {
    await expect(prepareSprintUpdate(makeClient(), '101', {})).rejects.toThrow(/Nothing to update/);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses an invalid state before reading the sprint', async () => {
    await expect(prepareSprintUpdate(makeClient(), '101', { state: 'done' })).rejects.toThrow(/must be one of/);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses when the instance reports a sprint with no name', async () => {
    routeSprint({ id: 101 });

    await expect(prepareSprintUpdate(makeClient(), '101', { goal: 'g' })).rejects.toThrow(/no name/);
  });
});
