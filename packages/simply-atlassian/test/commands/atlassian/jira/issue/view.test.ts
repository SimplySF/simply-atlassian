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
import JiraIssueView from '../../../../../src/commands/atlassian/jira/issue/view.js';
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

describe('jira issue view', () => {
  it('returns the raw issue payload untouched', async () => {
    server.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
      respondJson(res, 200, {
        key: 'PROJ-1',
        // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
        fields: { summary: 'Fix the thing', status: { name: 'In Progress' }, customfield_1: 'kept' },
      });
    });

    const issue = (await JiraIssueView.run(argv('PROJ-1'))) as {
      key: string;
      fields: Record<string, unknown>;
    };

    expect(issue.key).toBe('PROJ-1');
    // Passthrough matters: a curated view must not strip fields a caller asked for.
    expect(issue.fields['customfield_1']).toBe('kept');
  });

  it("shows a subtask's parent, so --parent is readable back", async () => {
    const logged: string[] = [];
    server.route('/rest/api/2/issue/PROJ-2', (_req, res) => {
      respondJson(res, 200, {
        key: 'PROJ-2',
        fields: {
          summary: 'write the tests',
          issuetype: { name: 'Subtask' },
          parent: { key: 'PROJ-1', fields: { summary: 'ship the thing' } },
        },
      });
    });

    const command = new JiraIssueView(argv('PROJ-2'), {
      runHook: async () => ({ successes: [], failures: [] }),
    } as never);
    command.log = (message?: string): void => {
      logged.push(String(message));
    };
    await command.init();
    await command.run();

    expect(logged.join('\n')).toContain('PROJ-1 — ship the thing');
  });

  it('omits the parent row for an issue that has none', async () => {
    const logged: string[] = [];
    server.route('/rest/api/2/issue/PROJ-3', (_req, res) => {
      respondJson(res, 200, { key: 'PROJ-3', fields: { summary: 'a task', issuetype: { name: 'Task' } } });
    });

    const command = new JiraIssueView(argv('PROJ-3'), {
      runHook: async () => ({ successes: [], failures: [] }),
    } as never);
    command.log = (message?: string): void => {
      logged.push(String(message));
    };
    await command.init();
    await command.run();

    expect(logged.join('\n')).not.toContain('Parent');
  });

  it('percent-encodes the issue key into the path', async () => {
    server.route('/rest/api/2/issue/PROJ%2F1', (_req, res) => {
      respondJson(res, 200, { key: 'PROJ/1' });
    });

    await expect(JiraIssueView.run(argv('PROJ/1'))).resolves.toBeDefined();
  });

  it('forwards --fields as a comma-separated query param', async () => {
    let requested: string | null = null;
    server.route('/rest/api/2/issue/PROJ-1', (req, res) => {
      requested = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('fields');
      respondJson(res, 200, { key: 'PROJ-1' });
    });

    await JiraIssueView.run(argv('PROJ-1', '--fields', 'summary, status'));

    expect(requested).toBe('summary,status');
  });

  it('exits 1 with the API message when the issue does not exist', async () => {
    server.route('/rest/api/2/issue/NOPE-1', (_req, res) => {
      respondJson(res, 404, { errorMessages: ['Issue does not exist'] });
    });

    const error = (await JiraIssueView.run(argv('NOPE-1')).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(1);
    expect(error.message).toContain('Issue does not exist');
  });
});
