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

import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JiraIssueCommentAdd from '../../../../../../src/commands/atlassian/jira/issue/comment/add.js';
import JiraIssueCommentDelete from '../../../../../../src/commands/atlassian/jira/issue/comment/delete.js';
import JiraIssueCommentEdit from '../../../../../../src/commands/atlassian/jira/issue/comment/edit.js';
import JiraIssueCommentList from '../../../../../../src/commands/atlassian/jira/issue/comment/list.js';
import { respondJson, startTestServer, type TestServer } from '../../../../../core/support.js';

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

describe('issue comment add', () => {
  it('sends the text as the body', async () => {
    let sent: { body?: unknown } | undefined;
    server.route('/rest/api/2/issue/P-1/comment', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { id: '1', author: { displayName: 'Ada' } });
    });

    await JiraIssueCommentAdd.run(argv('P-1', '--text', 'hello'));

    expect(sent?.body).toBe('hello');
  });

  it('refuses a comment with no content', async () => {
    const error = (await JiraIssueCommentAdd.run(argv('P-1')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Nothing to comment');
    expect(server.requests).toHaveLength(0);
  });

  it('appends a resolved mention to the text', async () => {
    let sent: { body?: string } | undefined;
    server.route('/rest/api/2/user/search', (_req, res) => {
      respondJson(res, 200, [{ name: 'ada', displayName: 'Ada' }]);
    });
    server.route('/rest/api/2/issue/P-1/comment', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { id: '1' });
    });

    await JiraIssueCommentAdd.run(argv('P-1', '--text', 'please review', '--mention', 'ada'));

    expect(sent?.body).toBe('please review\n\n[~ada]');
  });

  it('sends nothing when a mention cannot be resolved', async () => {
    server.route('/rest/api/2/user/search', (_req, res) => {
      respondJson(res, 200, []);
    });

    const error = (await JiraIssueCommentAdd.run(argv('P-1', '--text', 'x', '--mention', 'ghost')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    // The lookup happened; the comment did not.
    expect(server.requests.filter((r) => r.url.includes('/comment'))).toHaveLength(0);
  });

  it('is covered by the read-only guard', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';

    const error = (await JiraIssueCommentAdd.run(argv('P-1', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it('sends nothing under --dry-run', async () => {
    await expect(JiraIssueCommentAdd.run(argv('P-1', '--text', 'x', '--dry-run'))).resolves.toBeDefined();
    expect(server.requests).toHaveLength(0);
  });
});

describe('issue comment list', () => {
  it('shows a mention in the preview rather than dropping it', async () => {
    // Found in review, and visible in a live run nobody read carefully: a mention node carries
    // no `text`, only `attrs.text`, so "please review @Ada" previewed as "please review" — and
    // a mention-only comment previewed as empty.
    server.route('/rest/api/2/issue/P-1/comment', (_req, res) => {
      respondJson(res, 200, {
        comments: [
          {
            id: '1',
            author: { displayName: 'Ada' },
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'please review' },
                    { type: 'mention', attrs: { id: 'a1', text: '@Ada' } },
                  ],
                },
              ],
            },
          },
        ],
        total: 1,
      });
    });

    const lines: string[] = [];
    const spy = vi
      .spyOn(JiraIssueCommentList.prototype as unknown as { log: (message?: string) => void }, 'log')
      .mockImplementation((message?: string) => {
        lines.push(message ?? '');
      });

    try {
      await JiraIssueCommentList.run(argv('P-1'));
    } finally {
      spy.mockRestore();
    }

    expect(lines.join('\n')).toContain('@Ada');
  });

  it('flattens an ADF body into a one-line preview', async () => {
    server.route('/rest/api/2/issue/P-1/comment', (_req, res) => {
      respondJson(res, 200, {
        comments: [
          {
            id: '1',
            author: { displayName: 'Ada' },
            body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] },
          },
        ],
        total: 1,
      });
    });

    const result = (await JiraIssueCommentList.run(argv('P-1'))) as { comments: unknown[] };

    expect(result.comments).toHaveLength(1);
  });

  it('handles an issue with no comments', async () => {
    server.route('/rest/api/2/issue/P-1/comment', (_req, res) => {
      respondJson(res, 200, { comments: [], total: 0 });
    });

    await expect(JiraIssueCommentList.run(argv('P-1'))).resolves.toBeDefined();
  });
});

describe('issue comment edit', () => {
  it('refuses --mention without --text, since an edit replaces the body', async () => {
    // Found in review: this posted a bare mention over whatever the comment said.
    const error = (await JiraIssueCommentEdit.run(argv('P-1', '10001', '--mention', 'ada')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('would erase its text');
    // Refused before the user lookup, so no request at all.
    expect(server.requests).toHaveLength(0);
  });

  it('replaces the body with a PUT', async () => {
    let method: string | undefined;
    let sent: { body?: unknown } | undefined;
    server.route('/rest/api/2/issue/P-1/comment/10001', (req, res, body) => {
      method = req.method;
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '10001', updated: 'now' });
    });

    await JiraIssueCommentEdit.run(argv('P-1', '10001', '--text', 'corrected'));

    expect(method).toBe('PUT');
    expect(sent?.body).toBe('corrected');
  });

  it('refuses an edit with nothing to change', async () => {
    const error = (await JiraIssueCommentEdit.run(argv('P-1', '10001')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Nothing to change');
  });
});

describe('issue comment delete', () => {
  it('refuses without --confirm, naming both ids', async () => {
    const error = (await JiraIssueCommentDelete.run(argv('P-1', '10001')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('10001');
    expect(error.message).toContain('P-1');
    expect(server.requests).toHaveLength(0);
  });

  it('deletes with --confirm', async () => {
    let method: string | undefined;
    server.route('/rest/api/2/issue/P-1/comment/10001', (req, res) => {
      method = req.method;
      res.writeHead(204);
      res.end();
    });

    await JiraIssueCommentDelete.run(argv('P-1', '10001', '--confirm'));

    expect(method).toBe('DELETE');
  });

  it('sends nothing under --dry-run, without needing --confirm', async () => {
    await expect(JiraIssueCommentDelete.run(argv('P-1', '10001', '--dry-run'))).resolves.toBeDefined();
    expect(server.requests).toHaveLength(0);
  });
});
