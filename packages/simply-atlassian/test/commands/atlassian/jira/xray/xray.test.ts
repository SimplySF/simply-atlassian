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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keysInJql,
  respondJson,
  routeJiraSearch,
  routeXrayDiscovery,
  routeXraySteps,
  startTestServer,
  XRAY_FIXTURE_IDS,
  xrayFixtureIssue,
  xrayStep,
  type FakeXraySteps,
  type TestServer,
} from '@simplysf/simply-atlassian-core/testing';
import type { XrayTestRecord } from '@simplysf/simply-atlassian-core';
import JiraXrayFields from '../../../../../src/commands/atlassian/jira/xray/fields.js';
import JiraXrayPathList from '../../../../../src/commands/atlassian/jira/xray/path/list.js';
import JiraXrayPlanList from '../../../../../src/commands/atlassian/jira/xray/plan/list.js';
import JiraXraySetList from '../../../../../src/commands/atlassian/jira/xray/set/list.js';
import JiraXrayTestExport from '../../../../../src/commands/atlassian/jira/xray/test/export.js';
import JiraXrayTestGet from '../../../../../src/commands/atlassian/jira/xray/test/get.js';
import JiraXrayTestList from '../../../../../src/commands/atlassian/jira/xray/test/list.js';
import JiraXrayTestStepAdd from '../../../../../src/commands/atlassian/jira/xray/test/step/add.js';
import JiraXrayTestStepDelete from '../../../../../src/commands/atlassian/jira/xray/test/step/delete.js';
import JiraXrayTestStepUpdate from '../../../../../src/commands/atlassian/jira/xray/test/step/update.js';

let server: TestServer;
let cacheHome: string;
let stdout: string[];
let stderr: string[];
const store = new Map<string, unknown>();

beforeEach(async () => {
  server = await startTestServer();
  cacheHome = mkdtempSync(path.join(tmpdir(), 'xray-cli-'));
  process.env.XDG_CACHE_HOME = cacheHome;
  delete process.env.ATLASSIAN_READ_ONLY;
  store.clear();
  stdout = [];
  stderr = [];
  // oclif's this.log goes through console.log; the commands' own diagnostics go to process.stderr.
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]): void => {
    stdout.push(`${format(...args)}\n`);
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
    stderr.push(String(chunk));
    return true;
  });

  routeXrayDiscovery(server);
  routeJiraSearch(server, (jql) => {
    const keys = keysInJql(jql);
    if (keys.length > 0) return keys.map((key) => store.get(key)).filter((issue) => issue !== undefined);
    return [...store.values()];
  });
  server.route('/rest/api/2/issue/OM-12', (_req, res) => respondJson(res, 200, store.get('OM-12')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.XDG_CACHE_HOME;
  delete process.env.ATLASSIAN_READ_ONLY;
  await server.close();
  rmSync(cacheHome, { recursive: true, force: true });
});

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

function addTests(count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.set(`OM-${index}`, xrayFixtureIssue(`OM-${index}`, { steps: [xrayStep(1, `Do ${index}`, 'Done')] }));
  }
}

function fieldRequests(): number {
  return server.requests.filter((request) => request.url.startsWith('/rest/api/2/field')).length;
}

describe('jira xray fields', () => {
  it('discovers once, shows the roles, and returns the instance record', async () => {
    const record = await JiraXrayFields.run(argv());
    await JiraXrayFields.run(argv());

    expect(record.fields.steps).toBe(XRAY_FIXTURE_IDS.steps);
    expect(fieldRequests()).toBe(1);
    const out = stdout.join('');
    expect(out).toContain('Schritte');
    expect(out).toContain('(unmapped)');
    expect(out).toContain(path.join(cacheHome, 'simply-atlassian', 'xray'));
  });

  it('rediscovers with --refresh', async () => {
    await JiraXrayFields.run(argv());
    await JiraXrayFields.run(argv('--refresh'));

    expect(fieldRequests()).toBe(2);
  });

  it('refuses a Cloud site with a config error before any request', async () => {
    const error = (await JiraXrayFields.run([
      '--jira-url',
      'https://example.atlassian.net',
      '--jira-username',
      'me@example.com',
      '--jira-api-token',
      'token-value-long',
    ]).catch((caught: unknown) => caught)) as { message: string; oclif?: { exit?: number } };

    expect(error.message).toContain('Server/Data Center only');
    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe('jira xray test get', () => {
  beforeEach(() => {
    store.set('OM-9', xrayFixtureIssue('OM-9', { summary: 'Log in as admin', steps: [xrayStep(1, 'Log in')] }));
    store.set(
      'OM-12',
      xrayFixtureIssue('OM-12', {
        summary: 'Reset a password',
        steps: [xrayStep(1, 'Open Users', 'List shown'), { index: 2, testCallBean: { any: 'shape' } }],
        path: '/O&M/Accounts',
        plans: ['OM-7'],
      }),
    );
  });

  it('renders the test, naming step data it does not interpret rather than showing an empty row', async () => {
    await JiraXrayTestGet.run(argv('OM-12'));

    const out = stdout.join('');
    expect(out).toContain('Reset a password');
    expect(out).toContain('/O&M/Accounts');
    expect(out).toContain('(not interpreted: testCallBean)');
    expect(stderr.join('')).toContain('"testCallBean"');
  });

  it('keeps that step data under "extra" in the record', async () => {
    const record = (await JiraXrayTestGet.run(argv('OM-12', '--json'))) as XrayTestRecord;

    expect(record.steps[1]).toMatchObject({ index: '2', extra: { testCallBean: { any: 'shape' } } });
  });

  it('returns the export record under --json, and the Jira issue under --raw', async () => {
    const record = (await JiraXrayTestGet.run(argv('OM-12', '--json'))) as XrayTestRecord;
    const raw = (await JiraXrayTestGet.run(argv('OM-12', '--raw', '--json'))) as { fields: unknown };

    expect(record.key).toBe('OM-12');
    expect(record.plans).toEqual(['OM-7']);
    expect(raw.fields).toBeDefined();
  });

  it('takes --fields before the positional without swallowing it', async () => {
    const record = (await JiraXrayTestGet.run(argv('--fields', 'repositoryPath', 'OM-12', '--json'))) as XrayTestRecord;

    expect(record.fields).toEqual({ repositoryPath: '/O&M/Accounts' });
  });
});

describe('jira xray test list', () => {
  it('prints a table and returns the search envelope', async () => {
    addTests(3);

    const result = (await JiraXrayTestList.run(argv('--project', 'OM'))) as { issues: unknown[]; complete: boolean };

    expect(result.issues).toHaveLength(3);
    expect(result.complete).toBe(true);
    expect(stdout.join('')).toContain('Showing 3 of 3 test(s).');
  });

  it('says when --limit cut the list short', async () => {
    addTests(30);

    await JiraXrayTestList.run(argv('--project', 'OM'));

    expect(stdout.join('')).toContain('Showing 25 of 30 test(s) (limit 25 reached; more available).');
  });

  it('builds one JQL query from the scope and every filter, repeated or comma-separated', async () => {
    await JiraXrayTestList.run(
      argv(
        '--plan',
        'OM-7',
        '--search',
        'reset',
        '--linked-to',
        'OM-40,OM-41',
        '--linked-to',
        'OM-42',
        '--jql',
        'a OR b',
      ),
    );

    const jql = new URL(server.requests.at(-1)?.url ?? '', 'http://x').searchParams.get('jql');
    expect(jql).toBe(
      'issue in testPlanTests("OM-7") AND (a OR b) AND (summary ~ "reset" OR description ~ "reset") AND ' +
        '(issue in linkedIssues("OM-40") OR issue in linkedIssues("OM-41") OR issue in linkedIssues("OM-42")) ' +
        'ORDER BY key ASC',
    );
  });

  it('requires exactly one scope, as a config error', async () => {
    const error = (await JiraXrayTestList.run(argv('--plan', 'OM-7', '--set', 'OM-8')).catch(
      (caught: unknown) => caught,
    )) as { message: string; oclif?: { exit?: number } };

    expect(error.message).toContain('only one scope');
    expect(error.oclif?.exit).toBe(2);
  });

  it('refuses an unknown --fields name before searching', async () => {
    const error = (await JiraXrayTestList.run(argv('--project', 'OM', '--fields', 'nonsense')).catch(
      (caught: unknown) => caught,
    )) as { message: string };

    expect(error.message).toContain('No field matches "nonsense"');
    expect(server.requests.some((request) => request.url.startsWith('/rest/api/2/search'))).toBe(false);
  });
});

describe('jira xray test export', () => {
  it('writes a JSON array to stdout and progress to stderr only', async () => {
    addTests(2);

    await JiraXrayTestExport.run(argv('--project', 'OM'));

    const records = JSON.parse(stdout.join('')) as XrayTestRecord[];
    expect(records.map((record) => record.key)).toEqual(['OM-1', 'OM-2']);
    expect(stderr.join('')).toContain('fetched 2 of 2');
  });

  it('streams one record per line with --format jsonl, page by page', async () => {
    addTests(150);

    await JiraXrayTestExport.run(argv('--project', 'OM', '--format', 'jsonl'));

    const lines = stdout.join('').trim().split('\n');
    expect(lines).toHaveLength(150);
    expect((JSON.parse(lines[0] ?? '{}') as XrayTestRecord).key).toBe('OM-1');
    expect(stderr.join('')).toContain('fetched 100 of 150');
    expect(stderr.join('')).toContain('fetched 150 of 150');
  });

  it('renders Markdown sections', async () => {
    addTests(1);

    await JiraXrayTestExport.run(argv('--project', 'OM', '--format', 'markdown'));

    expect(stdout.join('')).toContain('## OM-1 — Summary of OM-1');
    expect(stdout.join('')).toContain('| 1 | Do 1 |  | Done |');
  });

  it('notes on stderr that --limit stopped the export, and still succeeds', async () => {
    addTests(5);

    await JiraXrayTestExport.run(argv('--project', 'OM', '--limit', '3'));

    expect(JSON.parse(stdout.join(''))).toHaveLength(3);
    expect(stderr.join('')).toContain('Stopped at --limit 3');
  });

  it('returns an envelope under --json, with nothing written to stdout by the command itself', async () => {
    addTests(5);

    const result = await JiraXrayTestExport.run(argv('--project', 'OM', '--limit', '3', '--json'));

    expect(result.records).toHaveLength(3);
    expect(result.complete).toBe(false);
    expect(result.total).toBe(5);
  });

  it('lets --json replace --format, streaming nothing and printing no progress', async () => {
    addTests(2);

    const result = await JiraXrayTestExport.run(argv('--project', 'OM', '--format', 'jsonl', '--json'));

    expect(result.records.map((record) => record.key)).toEqual(['OM-1', 'OM-2']);
    expect(stderr.join('')).not.toContain('fetched');
    expect(stdout.join('').split('\n')).not.toContain(JSON.stringify(result.records[0]));
  });
});

describe('jira xray plan list and set list', () => {
  it('lists plans with their test counts', async () => {
    store.set('OM-7', {
      key: 'OM-7',
      fields: { summary: 'Release 1', status: { name: 'Open' }, [XRAY_FIXTURE_IDS.testPlanTests]: ['OM-1', 'OM-2'] },
    });

    await JiraXrayPlanList.run(argv('--project', 'OM'));

    expect(stdout.join('')).toMatch(/OM-7\s+Open\s+2\s+Release 1/);
  });

  it('lists sets of the discovered set type', async () => {
    await JiraXraySetList.run(argv('--project', 'OM'));

    const jql = new URL(server.requests.at(-1)?.url ?? '', 'http://x').searchParams.get('jql');
    expect(jql).toBe('project = "OM" AND issuetype = "Prüfsammlung" ORDER BY key ASC');
    expect(stdout.join('')).toContain('No test sets matched.');
  });
});

describe('jira xray path list', () => {
  it('prints the folder tree with counts', async () => {
    server.route('/rest/raven/1.0/api/testrepository/OM/folders', (_req, res) =>
      respondJson(res, 200, [
        { id: 1, name: 'O&M', testsCount: 2, folders: [{ id: 2, name: 'Accounts', testsCount: 1, folders: [] }] },
      ]),
    );

    await JiraXrayPathList.run(argv('--project', 'OM'));

    expect(stdout.join('')).toBe('/\n  O&M  (2 tests)\n    Accounts  (1 test)\n');
  });
});

describe('write safety', () => {
  const commands = [
    JiraXrayFields,
    JiraXrayTestGet,
    JiraXrayTestList,
    JiraXrayTestExport,
    JiraXrayPlanList,
    JiraXraySetList,
    JiraXrayPathList,
  ];

  it('declares every Xray command a read', () => {
    for (const command of commands) expect(command.isWrite, command.name).toBe(false);
  });

  it('runs under ATLASSIAN_READ_ONLY, writing only its local instance record', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    addTests(1);

    const result = (await JiraXrayTestList.run(argv('--project', 'OM'))) as { issues: unknown[] };

    expect(result.issues).toHaveLength(1);
  });
});

describe('jira xray test step', () => {
  const STEP_PATH = '/rest/raven/1.0/api/test/OM-12/step';
  let fake: FakeXraySteps;

  beforeEach(() => {
    fake = routeXraySteps(server, 'OM-12', [
      { id: 311, action: 'Open Users', result: 'List shown' },
      { id: 312, action: 'Pick a user', data: 'bob' },
    ]);
    server.route('/rest/api/2/issue/OM-12', (_req, res) =>
      respondJson(res, 200, xrayFixtureIssue('OM-12', { steps: fake.fieldSteps() })),
    );
  });

  const writes = (): Array<{ method: string; url: string; body: string }> =>
    server.requests.filter((request) => request.method !== 'GET');
  const failure = async (run: Promise<unknown>): Promise<{ message: string; oclif?: { exit?: number } }> =>
    (await run.catch((caught: unknown) => caught)) as { message: string; oclif?: { exit?: number } };

  it('adds with the documented verb and body, accepts a plain-text 200, and returns the test read back', async () => {
    const result = (await JiraXrayTestStepAdd.run(
      argv('OM-12', '--action', 'Save', '--data', 'x', '--result', 'Saved', '--json'),
    )) as { record: XrayTestRecord; notes: string[] };

    expect(writes()).toEqual([
      { method: 'PUT', url: STEP_PATH, body: JSON.stringify({ step: 'Save', data: 'x', result: 'Saved' }) },
    ]);
    expect(result.record.steps.map((step) => step.action)).toEqual(['Open Users', 'Pick a user', 'Save']);
    expect(result.record.steps[2]?.id).toBe('1001');
  });

  it('shows the test and its step ids in the terminal', async () => {
    await JiraXrayTestStepAdd.run(argv('OM-12', '--action', 'Save'));

    expect(stdout.join('')).toContain('1001');
    expect(stdout.join('')).toContain('ID');
  });

  it('updates with POST, sending only what changed', async () => {
    await JiraXrayTestStepUpdate.run(argv('OM-12', '311', '--action', 'Open Users', '--result', 'Sorted', '--json'));

    expect(writes()).toEqual([{ method: 'POST', url: `${STEP_PATH}/311`, body: JSON.stringify({ result: 'Sorted' }) }]);
    expect(fake.steps[0]?.result).toBe('Sorted');
  });

  it('sends nothing when an update changes nothing', async () => {
    await JiraXrayTestStepUpdate.run(argv('OM-12', '311', '--action', 'Open Users', '--json'));

    expect(writes()).toEqual([]);
  });

  it('notes custom columns it leaves alone', async () => {
    fake.steps[0].extra = { fields: { Comment: 'keep' } };
    const result = (await JiraXrayTestStepUpdate.run(argv('OM-12', '311', '--result', 'New', '--json'))) as {
      notes: string[];
    };

    expect(result.notes.join()).toContain('Comment');
    expect(JSON.parse(writes()[0]?.body ?? '{}')).toEqual({ result: 'New' });
  });

  it('refuses to edit a call step', async () => {
    fake.steps[0].extra = { testCallBean: { key: 'OM-2' } };
    const error = await failure(JiraXrayTestStepUpdate.run(argv('OM-12', '311', '--result', 'New')));

    expect(error.message).toContain('calls another test');
    expect(error.oclif?.exit).toBe(2);
    expect(writes()).toEqual([]);
  });

  it('refuses a step id the test does not have, naming the ones it does', async () => {
    const error = await failure(JiraXrayTestStepUpdate.run(argv('OM-12', '99', '--result', 'New')));

    expect(error.message).toContain('311, 312');
    expect(error.oclif?.exit).toBe(2);
    expect(writes()).toEqual([]);
  });

  it('deletes with --confirm and returns the test without the step', async () => {
    const result = (await JiraXrayTestStepDelete.run(argv('OM-12', '311', '--confirm', '--json'))) as {
      record: XrayTestRecord;
    };

    expect(writes()).toEqual([{ method: 'DELETE', url: `${STEP_PATH}/311`, body: '' }]);
    expect(result.record.steps.map((step) => step.id)).toEqual(['312']);
  });

  it('refuses a delete without --confirm before any request', async () => {
    const error = await failure(JiraXrayTestStepDelete.run(argv('OM-12', '311')));

    expect(error.message).toContain('--confirm');
    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toEqual([]);
  });

  it('sends no write on a dry run, and prints what it would do', async () => {
    await JiraXrayTestStepDelete.run(argv('OM-12', '311', '--dry-run'));
    await JiraXrayTestStepAdd.run(argv('OM-12', '--action', 'Save', '--dry-run'));

    expect(writes()).toEqual([]);
    expect(stdout.join('')).toContain('delete step 311: Open Users');
    expect(stdout.join('')).toContain('add a step: Save');
  });

  it('refuses every write under ATLASSIAN_READ_ONLY with exit 2', async () => {
    process.env.ATLASSIAN_READ_ONLY = '1';
    const error = await failure(JiraXrayTestStepAdd.run(argv('OM-12', '--action', 'Save')));

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toEqual([]);
  });

  it('adds the write-scope hint to a 403, and does not retry a 500', async () => {
    server.route(STEP_PATH, (request, response) => {
      if (request.method === 'GET') respondJson(response, 200, []);
      else respondJson(response, 403, {});
    });
    const denied = await failure(JiraXrayTestStepAdd.run(argv('OM-12', '--action', 'Save')));
    expect(denied.message).toContain('may lack write scope');

    server.route(`${STEP_PATH}/311`, (_request, response) => respondJson(response, 500, {}));
    server.route(STEP_PATH, (_request, response) =>
      respondJson(response, 200, [{ id: 311, index: 1, step: { raw: 'a' }, data: { raw: '' }, result: { raw: '' } }]),
    );
    const failed = await failure(JiraXrayTestStepUpdate.run(argv('OM-12', '311', '--result', 'New')));
    expect(failed.message).toContain('may have been applied');
    expect(writes().filter((request) => request.url === `${STEP_PATH}/311`)).toHaveLength(1);
  });
});
