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
import JiraIssueHistory from '../../../../../src/commands/atlassian/jira/issue/history.js';
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

describe('jira issue history', () => {
  it('renders grouped entries oldest first and strips control characters', async () => {
    server.route('/rest/api/2/issue/PROJ-1/changelog', (_req, res) => {
      respondJson(res, 200, {
        histories: [
          {
            id: '2',
            author: { displayName: 'New\u001b[31m' },
            created: '2026-09-08T02:00:00.000Z',
            items: [{ field: 'summary', from: 'old\u0007', to: 'new' }],
          },
          {
            id: '1',
            author: { displayName: 'Old' },
            created: '2026-09-08T01:00:00.000Z',
            items: [{ field: 'status', fromString: 'Open', toString: 'Done', from: '1', to: '5' }],
          },
        ],
      });
    });

    const logged: string[] = [];
    const command = new JiraIssueHistory(argv('PROJ-1'), {
      runHook: async () => ({ successes: [], failures: [] }),
    } as never);
    command.log = (message?: string): void => {
      logged.push(String(message));
    };
    await command.init();
    await command.run();

    const output = logged.join('\n');
    expect(output.indexOf('2026-09-08T01:00:00.000Z')).toBeLessThan(output.indexOf('2026-09-08T02:00:00.000Z'));
    expect(output).toContain('  status: Open → Done');
    expect(output).toContain('  summary: old → new');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });

  it('filters entries by field case-insensitively', async () => {
    server.route('/rest/api/2/issue/PROJ-1/changelog', (_req, res) => {
      respondJson(res, 200, {
        histories: [
          {
            id: '1',
            author: { displayName: 'Alice' },
            created: '2026-09-08T01:00:00.000Z',
            items: [{ field: 'status', fromString: 'Open', toString: 'Done' }],
          },
          {
            id: '2',
            author: { displayName: 'Bob' },
            created: '2026-09-08T02:00:00.000Z',
            items: [{ field: 'assignee', from: null, to: 'bob' }],
          },
        ],
      });
    });

    const logged: string[] = [];
    const command = new JiraIssueHistory(argv('PROJ-1', '--field', 'STATUS'), {
      runHook: async () => ({ successes: [], failures: [] }),
    } as never);
    command.log = (message?: string): void => {
      logged.push(String(message));
    };
    await command.init();
    await command.run();

    expect(logged.join('\n')).toContain('status: Open → Done');
    expect(logged.join('\n')).not.toContain('assignee');
    expect(logged.join('\n')).not.toContain('Bob');
  });

  it('caps entries and returns normalized data for JSON callers', async () => {
    server.route('/rest/api/2/issue/PROJ-1/changelog', (_req, res) => {
      respondJson(res, 200, {
        total: 3,
        histories: [
          { id: '1', author: { displayName: 'Alice' }, created: '2026-09-08T01:00:00.000Z', items: [] },
          { id: '2', author: { displayName: 'Bob' }, created: '2026-09-08T02:00:00.000Z', items: [] },
          { id: '3', author: { displayName: 'Cara' }, created: '2026-09-08T03:00:00.000Z', items: [] },
        ],
      });
    });

    const result = await JiraIssueHistory.run(argv('PROJ-1', '--limit', '2', '--json'));

    expect(result.entries.map((entry) => entry.id)).toEqual(['1', '2']);
    expect(result.total).toBe(3);
    expect(result.complete).toBe(false);
  });
});
