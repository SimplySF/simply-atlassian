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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import type { WorkDryRunResult, WorkItemView, WorkSaveResult } from '@simplysf/simply-atlassian-core';
import JiraIssueCreate from '../../../../../src/commands/atlassian/jira/issue/create.js';
import JiraIssueCommentAdd from '../../../../../src/commands/atlassian/jira/issue/comment/add.js';
import JiraWorkConfigCheck from '../../../../../src/commands/atlassian/jira/work/config-check.js';
import JiraWorkGet from '../../../../../src/commands/atlassian/jira/work/get.js';
import JiraWorkSave from '../../../../../src/commands/atlassian/jira/work/save.js';

/* eslint-disable camelcase -- a real Jira custom field is named customfield_10045 */

const CONFIG = {
  jira: {
    project: 'PAY',
    issueType: 'Story',
    fields: [
      { name: 'Summary', key: 'summary', type: 'text', required: true },
      { name: 'Acceptance Criteria', key: 'customfield_10045', type: 'markdown', required: true },
      { name: 'Labels', key: 'labels', type: 'labels', value: ['agent-drafted'], always: true },
    ],
  },
};

let server: TestServer;
let dir: string;

beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(tmpdir(), 'work-cli-'));
  writeFileSync(path.join(dir, 'atlassian.json'), JSON.stringify(CONFIG));
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function argv(...extra: string[]): string[] {
  return [
    '--jira-url',
    server.baseUrl,
    '--jira-personal-token',
    'pat',
    '--config',
    path.join(dir, 'atlassian.json'),
    ...extra,
  ];
}

function input(value: unknown): string {
  const file = path.join(dir, 'input.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

type Failure = { oclif?: { exit?: number }; message: string };

describe('jira work get', () => {
  it('returns the configured shape for a new idea without calling the instance', async () => {
    const view: WorkItemView = await JiraWorkGet.run(argv());
    expect(view.issue.fields.map((field) => field.name)).toEqual(['Summary', 'Acceptance Criteria', 'Labels']);
    expect(server.requests).toHaveLength(0);
  });

  it('reads an issue with its revision, as Markdown', async () => {
    server.route('/rest/api/2/issue/PAY-3', (_req, res) =>
      respondJson(res, 200, {
        key: 'PAY-3',
        fields: { issuetype: { name: 'Story' }, summary: 'S', customfield_10045: '# *AC-1* Given', labels: [] },
      }),
    );
    const view: WorkItemView = await JiraWorkGet.run(argv('PAY-3'));
    expect(view.issue.revision).toMatch(/^sha256:/);
    expect(view.issue.fields.find((field) => field.name === 'Acceptance Criteria')?.value).toBe('1. **AC-1** Given');
  });
});

describe('jira work save', () => {
  it('previews a create from a JSON file and sends nothing', async () => {
    const result = (await JiraWorkSave.run(
      argv('--file', input({ issue: { fields: { Summary: 'S', 'Acceptance Criteria': '1. Given' } } }), '--dry-run'),
    )) as WorkDryRunResult;
    expect(result.issue?.request).toEqual({
      fields: {
        project: { key: 'PAY' },
        issuetype: { name: 'Story' },
        summary: 'S',
        customfield_10045: '# Given',
        labels: ['agent-drafted'],
      },
    });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses an update without basedOn, as a usage error', async () => {
    server.route('/rest/api/2/issue/PAY-3', (_req, res) =>
      respondJson(res, 200, { key: 'PAY-3', fields: { issuetype: { name: 'Story' }, summary: 'S' } }),
    );
    const error = (await JiraWorkSave.run(
      argv('--file', input({ issue: { key: 'PAY-3', fields: { Summary: 'T' } } })),
    ).catch((caught: unknown) => caught)) as Failure;
    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Read it with jira_work_get first');
  });

  it('creates the issue and returns the item to base the next save on', async () => {
    let sent: unknown;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'PAY-9' });
    });
    server.route('/rest/api/2/issue/PAY-9', (_req, res) =>
      respondJson(res, 200, {
        key: 'PAY-9',
        fields: { issuetype: { name: 'Story' }, summary: 'S', customfield_10045: '# Given', labels: ['agent-drafted'] },
      }),
    );
    const result = (await JiraWorkSave.run(
      argv('--file', input({ issue: { fields: { Summary: 'S', 'Acceptance Criteria': '1. Given' } } })),
    )) as WorkSaveResult;
    expect(sent).toMatchObject({ fields: { summary: 'S' } });
    expect(result.saved.issue).toBe('create');
    expect(result.item.issue.key).toBe('PAY-9');
  });

  it('refuses input that is not JSON', async () => {
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, '{ nope');
    const error = (await JiraWorkSave.run(argv('--file', file)).catch((caught: unknown) => caught)) as Failure;
    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('is not valid JSON');
  });

  it('is refused under ATLASSIAN_READ_ONLY like every other write', async () => {
    process.env.ATLASSIAN_READ_ONLY = '1';
    try {
      const error = (await JiraWorkSave.run(argv('--file', input({ issue: { fields: {} } }))).catch(
        (caught: unknown) => caught,
      )) as Failure;
      expect(error.oclif?.exit).toBe(2);
      expect(server.requests).toHaveLength(0);
    } finally {
      delete process.env.ATLASSIAN_READ_ONLY;
    }
  });
});

describe('jira work config-check', () => {
  it('fails with the problems it found', async () => {
    server.route('/rest/api/2/project/PAY', (_req, res) => respondJson(res, 404, { errorMessages: ['No project'] }));
    const error = (await JiraWorkConfigCheck.run(argv()).catch((caught: unknown) => caught)) as Failure;
    expect(error.oclif?.exit).toBe(1);
    expect(error.message).toContain('has 1 problem(s)');
  });
});

describe('--markdown on issue and comment writes', () => {
  it('sends wiki markup on Server/DC, keeping the structure', async () => {
    let sent: { fields: { description: unknown } } | undefined;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-1' });
    });
    await JiraIssueCreate.run([
      '--jira-url',
      server.baseUrl,
      '--jira-personal-token',
      'pat',
      '--project',
      'P',
      '--type',
      'Task',
      '--summary',
      's',
      '--markdown',
      '## Scope\n\n- one\n- two',
    ]);
    expect(sent?.fields.description).toBe('h2. Scope\n\n* one\n* two');
  });

  it('refuses plain text and Markdown together', async () => {
    const error = (await JiraIssueCommentAdd.run([
      '--jira-url',
      server.baseUrl,
      '--jira-personal-token',
      'pat',
      'P-1',
      '--text',
      'a',
      '--markdown',
      'b',
    ]).catch((caught: unknown) => caught)) as Failure;
    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});
