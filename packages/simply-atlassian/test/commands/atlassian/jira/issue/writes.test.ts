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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JiraIssueCreate from '../../../../../src/commands/atlassian/jira/issue/create.js';
import JiraIssueTransition from '../../../../../src/commands/atlassian/jira/issue/transition.js';
import JiraIssueTransitions from '../../../../../src/commands/atlassian/jira/issue/transitions.js';
import JiraIssueUpdate from '../../../../../src/commands/atlassian/jira/issue/update.js';
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

type Failure = { oclif?: { exit?: number }; message: string };

describe('issue create', () => {
  it('builds the request from typed flags', async () => {
    let sent: unknown;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-1', id: '10', self: `${server.baseUrl}/rest/api/2/issue/10` });
    });

    await JiraIssueCreate.run(
      argv('--project', 'P', '--type', 'Task', '--summary', 'a title', '--label', 'x', '--label', 'y'),
    );

    expect(sent).toEqual({
      fields: {
        project: { key: 'P' },
        issuetype: { name: 'Task' },
        summary: 'a title',
        labels: ['x', 'y'],
      },
    });
  });

  it('sends a plain-string description on Server/DC', async () => {
    let sent: { fields: { description: unknown } } | undefined;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-1' });
    });

    await JiraIssueCreate.run(argv('--project', 'P', '--type', 'Task', '--summary', 's', '--description', 'plain'));

    expect(sent?.fields.description).toBe('plain');
  });

  it('lets a typed flag override the body it was merged over', async () => {
    let sent: { fields: Record<string, unknown> } | undefined;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-1' });
    });

    await JiraIssueCreate.run(
      argv('--body', '{"fields":{"summary":"from body","customfield_1":"kept"}}', '--summary', 'from flag'),
    );

    expect(sent?.fields.summary).toBe('from flag');
    // The point of the escape hatch: an unusual field passes through untouched.
    expect(sent?.fields['customfield_1']).toBe('kept');
  });

  it('refuses a create with nothing to send', async () => {
    const error = (await JiraIssueCreate.run(argv()).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Nothing to create');
    expect(server.requests).toHaveLength(0);
  });

  it('surfaces a field-validation failure from the instance', async () => {
    server.route('/rest/api/2/issue', (_req, res) => {
      respondJson(res, 400, { errors: { summary: 'Summary is required.' } });
    });

    const error = (await JiraIssueCreate.run(argv('--project', 'P', '--type', 'Task', '--summary', 's')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(1);
    expect(error.message).toContain('Summary is required');
  });
});

describe('issue update', () => {
  it('re-reads the issue after the empty 204 and prints it', async () => {
    let updated = false;
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      if (req.method === 'PUT') {
        updated = true;
        res.writeHead(204);
        res.end();
        return;
      }
      respondJson(res, 200, { key: 'P-1', fields: { summary: 'new title' } });
    });

    const result = (await JiraIssueUpdate.run(argv('P-1', '--summary', 'new title'))) as {
      fields: { summary: string };
    };

    expect(updated).toBe(true);
    expect(result.fields.summary).toBe('new title');
  });

  it('skips the re-read with --no-verify', async () => {
    const methods: string[] = [];
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      methods.push(req.method ?? '');
      res.writeHead(204);
      res.end();
    });

    await JiraIssueUpdate.run(argv('P-1', '--summary', 'x', '--no-verify'));

    expect(methods).toEqual(['PUT']);
  });

  it('reports success when the write landed but the re-read failed', async () => {
    // Found in review: a 403 on the verification read made a successful update look failed,
    // which an agent would then retry.
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      if (req.method === 'PUT') {
        res.writeHead(204);
        res.end();
        return;
      }
      respondJson(res, 403, { message: 'cannot browse' });
    });

    const result = (await JiraIssueUpdate.run(argv('P-1', '--summary', 'x'))) as {
      updated: boolean;
      verified: boolean;
    };

    expect(result.updated).toBe(true);
    expect(result.verified).toBe(false);
  });

  it('strips control characters from the server text it reports on a failed re-read', async () => {
    // Found in review: this path bypassed the sanitising every other output path gets, so a
    // non-JSON error body could put real escape sequences on the stream an agent parses.
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      if (req.method === 'PUT') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('gone \u001b[2J\u0007 and hidden');
    });

    // Intercepting the command's own log call captures exactly the string it chose to emit,
    // which is what the fix changes; spying on the stream misses it, since oclif holds its own
    // reference to process.stdout.
    const lines: string[] = [];
    const spy = vi
      .spyOn(JiraIssueUpdate.prototype as unknown as { log: (message?: string) => void }, 'log')
      .mockImplementation((message?: string) => {
        lines.push(message ?? '');
      });

    try {
      await JiraIssueUpdate.run(argv('P-1', '--summary', 'x'));
    } finally {
      spy.mockRestore();
    }

    const output = lines.join('\n');
    expect(output).toContain('Could not re-read');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });

  it('refuses an update with nothing to change', async () => {
    const error = (await JiraIssueUpdate.run(argv('P-1')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Nothing to update');
  });
});

describe('issue transitions', () => {
  it('lists id, name, and target status', async () => {
    server.route('/rest/api/2/issue/P-1/transitions', (_req, res) => {
      respondJson(res, 200, { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] });
    });

    const result = (await JiraIssueTransitions.run(argv('P-1'))) as { transitions: unknown[] };

    expect(result.transitions).toHaveLength(1);
  });

  it('handles an issue with no available transitions', async () => {
    server.route('/rest/api/2/issue/P-1/transitions', (_req, res) => {
      respondJson(res, 200, { transitions: [] });
    });

    await expect(JiraIssueTransitions.run(argv('P-1'))).resolves.toBeDefined();
  });
});

describe('issue transition', () => {
  function routeTransitions(): void {
    server.route('/rest/api/2/issue/P-1/transitions', (req, res) => {
      if (req.method === 'POST') {
        res.writeHead(204);
        res.end();
        return;
      }
      respondJson(res, 200, {
        transitions: [
          { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
          { id: '41', name: 'Done', to: { name: 'Done' } },
        ],
      });
    });
  }

  it('resolves a name case-insensitively', async () => {
    routeTransitions();

    const result = (await JiraIssueTransition.run(argv('P-1', 'done'))) as { transition: string };

    expect(result.transition).toBe('41');
  });

  it('uses a numeric id without looking anything up', async () => {
    let lookups = 0;
    server.route('/rest/api/2/issue/P-1/transitions', (req, res) => {
      if (req.method === 'GET') lookups += 1;
      res.writeHead(204);
      res.end();
    });

    await JiraIssueTransition.run(argv('P-1', '41'));

    expect(lookups).toBe(0);
  });

  it('lists what is available when the name does not match', async () => {
    routeTransitions();

    const error = (await JiraIssueTransition.run(argv('P-1', 'Shipped')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    // Self-correcting: an agent can retry with a name from this list rather than guessing.
    expect(error.message).toContain('In Progress');
    expect(error.message).toContain('Done');
  });

  it('keeps an update block the caller supplied when adding a comment', async () => {
    // Found in review: --comment replaced the whole update block, dropping other operations.
    let sent: { update?: Record<string, unknown> } | undefined;
    server.route('/rest/api/2/issue/P-1/transitions', (req, res, body) => {
      if (req.method === 'POST') {
        sent = JSON.parse(body);
        res.writeHead(204);
        res.end();
        return;
      }
      respondJson(res, 200, { transitions: [{ id: '41', name: 'Done', to: { name: 'Done' } }] });
    });

    await JiraIssueTransition.run(
      argv('P-1', 'Done', '--body', '{"update":{"labels":[{"add":"triage"}]}}', '--comment', 'shipped'),
    );

    expect(sent?.update?.labels).toEqual([{ add: 'triage' }]);
    expect(JSON.stringify(sent?.update?.comment)).toContain('shipped');
  });

  it('treats an all-digit argument as a name when --by-name is passed', async () => {
    // Found in review: a workflow step literally named "41" was unreachable.
    let lookups = 0;
    server.route('/rest/api/2/issue/P-1/transitions', (req, res) => {
      if (req.method === 'POST') {
        res.writeHead(204);
        res.end();
        return;
      }
      lookups += 1;
      respondJson(res, 200, { transitions: [{ id: '31', name: '41', to: { name: 'Done' } }] });
    });

    const result = (await JiraIssueTransition.run(argv('P-1', '41', '--by-name'))) as { transition: string };

    expect(lookups).toBe(1);
    expect(result.transition).toBe('31');
  });

  it('says so when a matched transition has no id, rather than claiming ambiguity', async () => {
    server.route('/rest/api/2/issue/P-1/transitions', (_req, res) => {
      respondJson(res, 200, { transitions: [{ name: 'Done', to: { name: 'Done' } }] });
    });

    const error = (await JiraIssueTransition.run(argv('P-1', 'Done')).catch((caught: unknown) => caught)) as Failure;

    expect(error.message).toContain('no id');
    expect(error.message).not.toContain('more than one');
  });

  it('attaches a comment when asked', async () => {
    let sent: { update?: unknown; transition?: unknown } | undefined;
    server.route('/rest/api/2/issue/P-1/transitions', (req, res, body) => {
      if (req.method === 'POST') {
        sent = JSON.parse(body);
        res.writeHead(204);
        res.end();
        return;
      }
      respondJson(res, 200, { transitions: [{ id: '41', name: 'Done', to: { name: 'Done' } }] });
    });

    await JiraIssueTransition.run(argv('P-1', 'Done', '--comment', 'shipped'));

    expect(sent?.transition).toEqual({ id: '41' });
    expect(JSON.stringify(sent?.update)).toContain('shipped');
  });
});
