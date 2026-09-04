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
import JiraUserSearch from '../../../../../src/commands/atlassian/jira/user/search.js';
import JiraUserView from '../../../../../src/commands/atlassian/jira/user/view.js';
import { respondJson, startTestServer, type TestServer } from '../../../../core/support.js';

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

describe('jira user search', () => {
  it('returns the raw payload', async () => {
    server.route('/rest/api/2/user/search', (_req, res) => {
      respondJson(res, 200, [{ name: 'ada', displayName: 'Ada Lovelace', active: true }]);
    });

    const users = (await JiraUserSearch.run(argv('ada'))) as Array<{ name: string }>;

    expect(users[0]?.name).toBe('ada');
  });

  it('searches by username on Server/DC, not by query', async () => {
    let params: URLSearchParams | undefined;
    server.route('/rest/api/2/user/search', (req, res) => {
      params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      respondJson(res, 200, []);
    });

    await JiraUserSearch.run(argv('ada'));

    expect(params?.get('username')).toBe('ada');
    expect(params?.get('query')).toBeNull();
  });

  it('treats no matches as an ordinary answer, not an error', async () => {
    server.route('/rest/api/2/user/search', (_req, res) => {
      respondJson(res, 200, []);
    });

    await expect(JiraUserSearch.run(argv('nobody'))).resolves.toBeDefined();
  });

  it('tolerates a user who hides their email', async () => {
    server.route('/rest/api/2/user/search', (_req, res) => {
      respondJson(res, 200, [{ name: 'ada', displayName: 'Ada', active: true }]);
    });

    await expect(JiraUserSearch.run(argv('ada'))).resolves.toBeDefined();
  });
});

describe('jira user view', () => {
  it('looks a user up by username on Server/DC', async () => {
    let params: URLSearchParams | undefined;
    server.route('/rest/api/2/user', (req, res) => {
      params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      respondJson(res, 200, { name: 'ada', displayName: 'Ada Lovelace', active: true });
    });

    const user = (await JiraUserView.run(argv('ada'))) as { displayName: string };

    expect(params?.get('username')).toBe('ada');
    expect(user.displayName).toBe('Ada Lovelace');
  });

  it('exits 1 with the API message for a user that does not exist', async () => {
    server.route('/rest/api/2/user', (_req, res) => {
      respondJson(res, 404, { errorMessages: ['The user named nobody does not exist'] });
    });

    const error = (await JiraUserView.run(argv('nobody')).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(1);
    expect(error.message).toContain('does not exist');
  });
});
