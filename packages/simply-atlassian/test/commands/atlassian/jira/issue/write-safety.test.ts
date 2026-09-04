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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JiraIssueTransition from '../../../../../src/commands/atlassian/jira/issue/transition.js';
import JiraIssueCreate from '../../../../../src/commands/atlassian/jira/issue/create.js';
import JiraIssueDelete from '../../../../../src/commands/atlassian/jira/issue/delete.js';
import JiraIssueUpdate from '../../../../../src/commands/atlassian/jira/issue/update.js';
import JiraWhoami from '../../../../../src/commands/atlassian/jira/whoami.js';
import { respondJson, startTestServer, type TestServer } from '../../../../core/support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.ATLASSIAN_READ_ONLY;
});

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

type Failure = { oclif?: { exit?: number }; message: string };

describe('the read-only guard', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    it(`refuses a write when ATLASSIAN_READ_ONLY is "${value}"`, async () => {
      process.env.ATLASSIAN_READ_ONLY = value;

      const error = (await JiraIssueCreate.run(argv('--project', 'P', '--type', 'Task', '--summary', 's')).catch(
        (caught: unknown) => caught,
      )) as Failure;

      expect(error.oclif?.exit).toBe(2);
      expect(error.message).toContain('ATLASSIAN_READ_ONLY');
      // The refusal must happen before any request is made.
      expect(server.requests).toHaveLength(0);
    });
  }

  it('refuses every write command, not only the one it was first tested on', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';

    const failures = (await Promise.all(
      [
        JiraIssueCreate.run(argv('--project', 'P', '--type', 'Task', '--summary', 's')),
        JiraIssueUpdate.run(argv('P-1', '--summary', 's')),
        JiraIssueDelete.run(argv('P-1', '--confirm')),
        JiraIssueTransition.run(argv('P-1', '41')),
      ].map(async (attempt) => attempt.catch((caught: unknown) => caught)),
    )) as Failure[];

    for (const error of failures) {
      expect(error.oclif?.exit).toBe(2);
      expect(error.message).toContain('ATLASSIAN_READ_ONLY');
    }
    // Not one request escaped, including the transition's lookup call.
    expect(server.requests).toHaveLength(0);
  });

  it('cannot be cleared by an env file, because the real environment wins', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const path = join(mkdtempSync(join(tmpdir(), 'simply-guard-')), '.env');
    writeFileSync(path, 'ATLASSIAN_READ_ONLY=false\n', 'utf8');

    const error = (await JiraIssueCreate.run(
      argv('--env-file', path, '--project', 'P', '--type', 'Task', '--summary', 's'),
    ).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it('can be switched on by an env file, which is the intended arrangement', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'simply-guard-')), '.env');
    writeFileSync(path, 'ATLASSIAN_READ_ONLY=true\n', 'utf8');

    const error = (await JiraIssueCreate.run(
      argv('--env-file', path, '--project', 'P', '--type', 'Task', '--summary', 's'),
    ).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
  });

  it('leaves reads alone', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    server.route('/rest/api/2/myself', (_req, res) => {
      respondJson(res, 200, { displayName: 'Ada', name: 'ada' });
    });

    await expect(JiraWhoami.run(argv())).resolves.toBeDefined();
  });

  it('ignores a value that does not mean yes', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'false';
    server.route('/rest/api/2/issue', (_req, res) => {
      respondJson(res, 201, { key: 'P-1', id: '1' });
    });

    await expect(
      JiraIssueCreate.run(argv('--project', 'P', '--type', 'Task', '--summary', 's')),
    ).resolves.toBeDefined();
  });
});

describe('--confirm on an irreversible command', () => {
  it('refuses a delete without it, naming the issue', async () => {
    const error = (await JiraIssueDelete.run(argv('P-1')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('P-1');
    expect(error.message).toContain('--confirm');
    expect(server.requests).toHaveLength(0);
  });

  it('refuses an argument that is not an issue key', async () => {
    // `--confirm=false` makes oclif consume "false" as this argument while setting the flag
    // true; a shape check stops that, and catches an ordinary typo before a DELETE is sent.
    for (const value of ['false', 'true', 'PROJ', '123']) {
      // eslint-disable-next-line no-await-in-loop -- each case must be observed on its own
      const error = (await JiraIssueDelete.run(argv(value, '--confirm')).catch((caught: unknown) => caught)) as Failure;
      expect(error.oclif?.exit).toBe(2);
      expect(error.message).toContain('is not an issue key');
    }
    expect(server.requests).toHaveLength(0);
  });

  it('proceeds with it', async () => {
    let method: string | undefined;
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      method = req.method;
      res.writeHead(204);
      res.end();
    });

    await expect(JiraIssueDelete.run(argv('P-1', '--confirm'))).resolves.toBeDefined();
    expect(method).toBe('DELETE');
  });

  it('sends deleteSubtasks only when asked', async () => {
    const seen: Array<string | null> = [];
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      seen.push(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('deleteSubtasks'));
      res.writeHead(204);
      res.end();
    });

    await JiraIssueDelete.run(argv('P-1', '--confirm'));
    await JiraIssueDelete.run(argv('P-1', '--confirm', '--delete-subtasks'));

    expect(seen).toEqual([null, 'true']);
  });
});

describe('--dry-run', () => {
  it('sends nothing at all for a create', async () => {
    const body = (await JiraIssueCreate.run(
      argv('--project', 'P', '--type', 'Task', '--summary', 's', '--dry-run'),
    )) as { fields: Record<string, unknown> };

    expect(body.fields.summary).toBe('s');
    expect(server.requests).toHaveLength(0);
  });

  it('sends nothing at all for a delete, and does not need --confirm to preview', async () => {
    await expect(JiraIssueDelete.run(argv('P-1', '--dry-run'))).resolves.toBeDefined();
    expect(server.requests).toHaveLength(0);
  });

  it('sends nothing at all for an update', async () => {
    await expect(JiraIssueUpdate.run(argv('P-1', '--summary', 'x', '--dry-run'))).resolves.toBeDefined();
    expect(server.requests).toHaveLength(0);
  });
});
