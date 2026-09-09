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

import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import JiraBoardList from '../../../../src/commands/atlassian/jira/board/list.js';
import JiraSprintAdd from '../../../../src/commands/atlassian/jira/sprint/add.js';
import JiraSprintIssues from '../../../../src/commands/atlassian/jira/sprint/issues.js';
import JiraSprintList from '../../../../src/commands/atlassian/jira/sprint/list.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
  delete process.env.ATLASSIAN_READ_ONLY;
});

afterEach(async () => {
  await server.close();
  delete process.env.ATLASSIAN_READ_ONLY;
});

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

type Failure = { oclif?: { exit?: number }; message: string };

describe('jira agile commands', () => {
  it('lists boards with filters', async () => {
    server.route('/rest/agile/1.0/board', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(url.searchParams.get('projectKeyOrId')).toBe('PROJ');
      expect(url.searchParams.get('type')).toBe('kanban');
      respondJson(res, 200, { values: [{ id: 1, name: 'Work', type: 'kanban' }], isLast: true });
    });

    const result = (await JiraBoardList.run(argv('--project', 'PROJ', '--type', 'kanban'))) as { values: unknown[] };
    expect(result.values).toEqual([{ id: 1, name: 'Work', type: 'kanban' }]);
  });

  it('lists sprints with the active/future default and rejects names', async () => {
    server.route('/rest/agile/1.0/board/7/sprint', (req, res) => {
      expect(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('state')).toBe('active,future');
      respondJson(res, 200, { values: [{ id: 11, name: 'Current', state: 'ACTIVE' }], isLast: true });
    });

    const result = (await JiraSprintList.run(argv('7'))) as { values: unknown[] };
    expect(result.values).toHaveLength(1);

    const error = (await JiraSprintList.run(argv('Current')).catch((caught: unknown) => caught)) as Failure;
    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('numeric');
    expect(server.requests).toHaveLength(1);
  });

  it('lists sprint issues through the shared issue columns', async () => {
    server.route('/rest/agile/1.0/sprint/11/issue', (_req, res) => {
      respondJson(res, 200, {
        issues: [{ key: 'PROJ-1', fields: { summary: 'Fix it', status: { name: 'To Do' } } }],
        isLast: true,
      });
    });

    const result = (await JiraSprintIssues.run(argv('11'))) as { values: unknown[] };
    expect(result.values).toEqual([{ key: 'PROJ-1', fields: { summary: 'Fix it', status: { name: 'To Do' } } }]);
  });

  it('does not send a dry-run sprint move', async () => {
    const result = await JiraSprintAdd.run(argv('11', 'PROJ-1', 'PROJ-2', '--dry-run'));

    expect(result).toEqual({ sprint: '11', issues: ['PROJ-1', 'PROJ-2'] });
    expect(server.requests).toHaveLength(0);
  });

  it('marks sprint add as a write for the read-only guard', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';

    const error = (await JiraSprintAdd.run(argv('11', 'PROJ-1')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('ATLASSIAN_READ_ONLY');
    expect(server.requests).toHaveLength(0);
  });
});
