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
import { CliError, ConfigError } from '../src/errors.js';
import { addIssuesToSprint, numericId, sprintChunkSizes } from '../src/jira-agile.js';
import { JiraClient } from '../src/jira-client.js';
import { buildCommentBody, buildCommentEditBody, deleteComment } from '../src/jira-comments.js';
import { changelogJson, filterChangelog, normalizeField } from '../src/jira-history.js';
import { buildCreateIssueBody, buildUpdateIssueBody, deleteIssue, readBackIssue } from '../src/jira-issues.js';
import { assertLinkId, buildIssueLinkBody, deleteIssueLink, describeIssueLink } from '../src/jira-links.js';
import { buildTransitionBody, resolveTransitionId } from '../src/jira-transitions.js';
import { assertAccount, currentAccount, userList } from '../src/jira-users.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function jira(deployment: AtlassianConfig['deployment'] = 'server'): JiraClient {
  return new JiraClient({
    url: server.baseUrl,
    deployment,
    auth:
      deployment === 'cloud'
        ? { kind: 'basic', username: 'user@example.com', apiToken: 'token' }
        : { kind: 'bearer', personalToken: 'pat' },
  });
}

describe('issue bodies', () => {
  it('assembles a create body with the deployment-specific shapes and typed fields over the raw body', () => {
    const body = buildCreateIssueBody(jira('cloud'), {
      project: 'P',
      type: 'Bug',
      parent: 'P-1',
      summary: 'Crash',
      description: 'It broke',
      assignee: 'acc-1',
      priority: 'High',
      labels: ['a'],
      // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
      body: { fields: { summary: 'overridden', customfield_1: 'kept' } },
    });
    expect(body).toEqual({
      fields: {
        // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
        customfield_1: 'kept',
        project: { key: 'P' },
        issuetype: { name: 'Bug' },
        parent: { key: 'P-1' },
        summary: 'Crash',
        description: { type: 'doc', version: 1, content: expect.any(Array) as unknown },
        assignee: { id: 'acc-1' },
        priority: { name: 'High' },
        labels: ['a'],
      },
    });
  });

  it('names accounts on Server/DC and keeps descriptions as strings', () => {
    const body = buildUpdateIssueBody(jira('server'), 'P-1', { assignee: 'ada', description: 'text' });
    expect(body).toEqual({ fields: { description: 'text', assignee: { name: 'ada' } } });
  });

  it('refuses an empty create or update rather than sending it', () => {
    expect(() => buildCreateIssueBody(jira(), {})).toThrow(/Nothing to create/);
    expect(() => buildUpdateIssueBody(jira(), 'P-1', {})).toThrow(/Nothing to update on P-1/);
  });

  it('reports a failed read-back instead of throwing it', async () => {
    server.route('/rest/api/2/issue/P-1', (_req, res) => respondJson(res, 403, { message: 'no browse' }));
    const outcome = await readBackIssue(jira(), 'P-1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/403|no browse/);
  });
});

describe('deleteIssue', () => {
  it('checks the key shape first, then answers a dry run before looking at consent', async () => {
    await expect(deleteIssue(jira(), { issue: 'false', confirm: true })).rejects.toThrow(/is not an issue key/);
    await expect(deleteIssue(jira(), { issue: 'P-1', dryRun: true })).resolves.toEqual({
      issue: 'P-1',
      deleteSubtasks: false,
      dryRun: true,
    });
    await expect(deleteIssue(jira(), { issue: 'P-1' })).rejects.toThrow(/Deleting P-1 cannot be undone/);
    expect(server.requests).toHaveLength(0);
  });

  it('sends the delete with deleteSubtasks only when asked', async () => {
    const seen: Array<string | null> = [];
    server.route('/rest/api/2/issue/P-1', (req, res) => {
      seen.push(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('deleteSubtasks'));
      res.writeHead(204);
      res.end();
    });
    await expect(deleteIssue(jira(), { issue: 'P-1', confirm: true })).resolves.toEqual({
      issue: 'P-1',
      deleted: true,
    });
    await deleteIssue(jira(), { issue: 'P-1', confirm: true, deleteSubtasks: true });
    expect(seen).toEqual([null, 'true']);
  });
});

describe('transitions', () => {
  it('takes digits as an id unless told to match by name', async () => {
    server.route('/rest/api/2/issue/P-1/transitions', (_req, res) => {
      respondJson(res, 200, { transitions: [{ id: '7', name: '41', to: { name: 'Done' } }] });
    });
    await expect(resolveTransitionId(jira(), 'P-1', '41')).resolves.toBe('41');
    await expect(resolveTransitionId(jira(), 'P-1', '41', { byName: true })).resolves.toBe('7');
  });

  it('lists what is available when a name does not match, one line per transition', async () => {
    server.route('/rest/api/2/issue/P-1/transitions', (_req, res) => {
      respondJson(res, 200, {
        transitions: [
          { id: '1', name: 'To\nDo' },
          { id: '2', name: 'Done', to: { name: 'Done' } },
        ],
      });
    });
    await expect(resolveTransitionId(jira(), 'P-1', 'Closed')).rejects.toThrow(
      'No transition named "Closed" is available for P-1. Available: To Do (id 1), Done (id 2 -> Done).',
    );
  });

  it('adds a comment into an existing update block and drops an empty fields object', () => {
    const body = buildTransitionBody(jira('server'), '2', {
      body: { update: { labels: [{ add: 'x' }] } },
      comment: 'shipped',
    });
    expect(body).toEqual({
      transition: { id: '2' },
      update: { labels: [{ add: 'x' }], comment: [{ add: { body: 'shipped' } }] },
    });
  });
});

describe('comments', () => {
  it('refuses an empty comment, and an edit that would erase the text', async () => {
    await expect(buildCommentBody(jira(), 'P-1', {})).rejects.toThrow(/Nothing to comment on P-1/);
    await expect(buildCommentEditBody(jira(), '9', {})).rejects.toThrow(/Nothing to change on comment 9/);
    await expect(buildCommentEditBody(jira(), '9', { mentions: ['ada'] })).rejects.toThrow(/would erase its text/);
  });

  it('builds the body from text in the deployment shape', async () => {
    await expect(buildCommentBody(jira('server'), 'P-1', { text: 'hi' })).resolves.toEqual({ body: 'hi' });
  });

  it('gates a delete on confirm after answering a dry run', async () => {
    await expect(deleteComment(jira(), { issue: 'P-1', comment: '9', dryRun: true })).resolves.toEqual({
      issue: 'P-1',
      comment: '9',
      dryRun: true,
    });
    await expect(deleteComment(jira(), { issue: 'P-1', comment: '9' })).rejects.toThrow(ConfigError);
    expect(server.requests).toHaveLength(0);
  });
});

describe('links', () => {
  it('resolves the phrase and sends the type by id', async () => {
    server.route('/rest/api/2/issueLinkType', (_req, res) => {
      respondJson(res, 200, {
        issueLinkTypes: [{ id: '10', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }],
      });
    });
    const { body, resolved } = await buildIssueLinkBody(jira('server'), 'A-1', 'is blocked by', 'B-2', 'why');
    expect(body).toEqual({
      type: { id: '10' },
      inwardIssue: { key: 'B-2' },
      outwardIssue: { key: 'A-1' },
      comment: { body: 'why' },
    });
    expect(resolved.phrase).toBe('is blocked by');
  });

  it('rejects an issue key where a link id belongs, and describes a link from both ends', () => {
    expect(() => assertLinkId('P-1')).toThrow(/is not a link id/);
    expect(
      describeIssueLink({ inwardIssue: { key: 'A-1' }, outwardIssue: { key: 'B-2' }, type: { outward: 'blocks' } }),
    ).toBe('A-1 blocks B-2');
    expect(describeIssueLink({ inwardIssue: { key: 'A-1' } })).toBe('A-1 is linked to (unknown issue)');
  });

  it('resolves the link before a dry run and only deletes when asked', async () => {
    const methods: string[] = [];
    server.route('/rest/api/2/issueLink/10201', (req, res) => {
      methods.push(req.method ?? '');
      if (req.method === 'GET') respondJson(res, 200, { inwardIssue: { key: 'A-1' }, outwardIssue: { key: 'B-2' } });
      else {
        res.writeHead(204);
        res.end();
      }
    });
    await expect(deleteIssueLink(jira(), '10201', { dryRun: true })).resolves.toEqual({
      linkId: '10201',
      relationship: 'A-1 is linked to B-2',
      deleted: false,
    });
    await expect(deleteIssueLink(jira(), '10201')).resolves.toMatchObject({ deleted: true });
    expect(methods).toEqual(['GET', 'GET', 'DELETE']);
  });
});

describe('agile', () => {
  it('insists on numeric ids and sizes the chunks Jira accepts', () => {
    expect(numericId('Board', '42')).toBe('42');
    expect(() => numericId('Board', 'My board')).toThrow(/Board id must be numeric/);
    expect(sprintChunkSizes(0)).toEqual([]);
    expect(sprintChunkSizes(50)).toEqual([50]);
    expect(sprintChunkSizes(120)).toEqual([50, 50, 20]);
  });

  it('answers a dry run with the payload and otherwise reports how it was sent', async () => {
    server.route('/rest/agile/1.0/sprint/7/issue', (_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await expect(addIssuesToSprint(jira(), '7', ['P-1'], { dryRun: true })).resolves.toEqual({
      sprint: '7',
      issues: ['P-1'],
    });
    expect(server.requests).toHaveLength(0);
    await expect(addIssuesToSprint(jira(), '7', ['P-1', 'P-2'])).resolves.toEqual({
      sprint: '7',
      issues: ['P-1', 'P-2'],
      chunks: 1,
      issueCount: 2,
    });
  });
});

describe('users and identity', () => {
  it('refuses a success response with no account in it', async () => {
    expect(() => assertAccount({ displayName: 'Login page' })).toThrow(CliError);
    server.route('/rest/api/2/myself', (_req, res) => respondJson(res, 200, { key: 'ada', displayName: 'Ada' }));
    await expect(currentAccount(jira())).resolves.toEqual({ key: 'ada', displayName: 'Ada' });
  });

  it('reads a user list from either response shape', () => {
    expect(userList([{ name: 'a' }])).toEqual([{ name: 'a' }]);
    expect(userList({ values: [{ name: 'b' }] })).toEqual([{ name: 'b' }]);
    expect(userList({})).toEqual([]);
    expect(userList(null)).toEqual([]);
  });
});

describe('history', () => {
  const result = {
    entries: [
      { id: '2', created: '2026-01-02', author: 'b', items: [{ field: 'Status', from: '1', to: '2' }] },
      { id: '1', created: '2026-01-01', author: 'a', items: [{ field: 'summary', from: 'x', to: 'y' }] },
    ],
    rawEntries: ['raw-status', 'raw-summary'],
    total: 2,
    pages: 1,
    complete: true,
  };

  it('normalises the field filter and keeps raw entries aligned with the filtered ones', () => {
    expect(normalizeField('  ')).toBeUndefined();
    expect(normalizeField(' Status ')).toBe('status');
    const filtered = filterChangelog(result, 'STATUS');
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.rawEntries).toEqual(['raw-status']);
    expect(filterChangelog(result, undefined)).toBe(result);
  });

  it('reports the machine-readable view', () => {
    expect(changelogJson(result)).toEqual({ rawEntries: ['raw-status', 'raw-summary'], total: 2, complete: true });
  });
});
