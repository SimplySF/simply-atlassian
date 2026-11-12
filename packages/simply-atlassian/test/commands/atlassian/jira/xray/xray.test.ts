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
import JiraXrayTestCreate from '../../../../../src/commands/atlassian/jira/xray/test/create.js';
import JiraXrayTestUpdate from '../../../../../src/commands/atlassian/jira/xray/test/update.js';
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
  delete process.env.SIMPLY_ATLASSIAN_READ_ONLY;
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
  delete process.env.SIMPLY_ATLASSIAN_READ_ONLY;
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

  it('runs under SIMPLY_ATLASSIAN_READ_ONLY, writing only its local instance record', async () => {
    process.env.SIMPLY_ATLASSIAN_READ_ONLY = 'true';
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

  it('refuses every write under SIMPLY_ATLASSIAN_READ_ONLY with exit 2', async () => {
    process.env.SIMPLY_ATLASSIAN_READ_ONLY = '1';
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

describe('jira xray test create', () => {
  const ALLOWED = {
    values: [
      {
        fieldId: XRAY_FIXTURE_IDS.testType,
        allowedValues: [{ value: 'Manual' }, { value: 'Cucumber' }, { value: 'Generic' }],
      },
    ],
  };
  let created: Record<string, unknown> | undefined;

  beforeEach(() => {
    created = undefined;
    server.route('/rest/api/2/issue/createmeta/OM/issuetypes', (_req, res) =>
      respondJson(res, 200, { values: [{ id: '10100', name: 'Prüfung' }] }),
    );
    server.route('/rest/api/2/issue/createmeta/OM/issuetypes/10100', (_req, res) => respondJson(res, 200, ALLOWED));
    server.route('/rest/api/2/issue', (_req, res, body) => {
      created = (JSON.parse(body) as { fields: Record<string, unknown> }).fields;
      respondJson(res, 201, { id: '10500', key: 'OM-50', self: `${server.baseUrl}/rest/api/2/issue/10500` });
    });
    server.route('/rest/api/2/issue/OM-50', (_req, res) => respondJson(res, 200, xrayFixtureIssue('OM-50')));
    server.route('/rest/api/2/issueLinkType', (_req, res) =>
      respondJson(res, 200, { issueLinkTypes: [{ id: '7', name: 'Tests', inward: 'is tested by', outward: 'tests' }] }),
    );
  });

  const writes = (): Array<{ method: string; url: string; body: string }> =>
    server.requests.filter((request) => request.method !== 'GET');
  const failure = async (run: Promise<unknown>): Promise<{ message: string; oclif?: { exit?: number } }> =>
    (await run.catch((caught: unknown) => caught)) as { message: string; oclif?: { exit?: number } };
  const base = (...extra: string[]): string[] => argv('--project', 'OM', '--summary', 'S', ...extra);

  it('creates a Manual test in one request, with the documented step shape and non-default ids', async () => {
    const result = (await JiraXrayTestCreate.run(base('--step', 'Open|x|Shown', '--step', 'Save', '--json'))) as {
      record: XrayTestRecord;
    };

    expect(created).toEqual({
      project: { key: 'OM' },
      issuetype: { name: 'Prüfung' },
      summary: 'S',
      [XRAY_FIXTURE_IDS.testType]: { value: 'Manual' },
      [XRAY_FIXTURE_IDS.steps]: {
        steps: [
          { index: 1, fields: { action: 'Open', data: 'x', 'expected result': 'Shown' } },
          { index: 2, fields: { action: 'Save', data: '', 'expected result': '' } },
        ],
      },
    });
    expect(writes()).toHaveLength(1);
    expect(result.record.key).toBe('OM-50');
  });

  it('creates a Cucumber test with a plain-string scenario, and no Cucumber type on current Xray', async () => {
    await JiraXrayTestCreate.run(base('--gherkin', 'Given a user', '--json'));

    expect(created).toMatchObject({
      [XRAY_FIXTURE_IDS.testType]: { value: 'Cucumber' },
      [XRAY_FIXTURE_IDS.cucumberScenario]: 'Given a user',
    });
    expect(created).not.toHaveProperty(XRAY_FIXTURE_IDS.cucumberType);
  });

  it('creates a Generic test with a plain-string definition', async () => {
    await JiraXrayTestCreate.run(base('--type', 'generic', '--definition', 'sum.sh', '--json'));

    expect(created).toMatchObject({
      [XRAY_FIXTURE_IDS.testType]: { value: 'Generic' },
      [XRAY_FIXTURE_IDS.genericDefinition]: 'sum.sh',
    });
  });

  it('lists the allowed values for an unknown --type', async () => {
    const error = await failure(JiraXrayTestCreate.run(base('--type', 'exploratory')));

    expect(error.message).toContain('Manual, Cucumber, Generic');
    expect(error.oclif?.exit).toBe(2);
    expect(writes()).toEqual([]);
  });

  it('still creates when the instance will not list the types, and says so', async () => {
    server.route('/rest/api/2/issue/createmeta/OM/issuetypes', (_req, res) => respondJson(res, 404, {}));
    server.route('/rest/api/2/issue/createmeta', (_req, res) => respondJson(res, 404, {}));
    const result = (await JiraXrayTestCreate.run(base('--type', 'manual', '--json'))) as { notes: string[] };

    expect(created).toMatchObject({ [XRAY_FIXTURE_IDS.testType]: { value: 'Manual' } });
    expect(result.notes.join()).toContain('could not be read');
  });

  it('refuses to guess a Cucumber type on an Xray older than 7.3.0, and takes the flag', async () => {
    routeXrayDiscovery(server, { version: '7.2.0' });
    const error = await failure(JiraXrayTestCreate.run(base('--gherkin', 'Given')));
    expect(error.message).toContain('cucumberType=Scenario');
    expect(writes()).toEqual([]);

    await JiraXrayTestCreate.run(base('--gherkin', 'Given', '--field', 'cucumberType=Scenario', '--json'));
    expect(created).toMatchObject({ [XRAY_FIXTURE_IDS.cucumberType]: { value: 'Scenario' } });
  });

  it('applies a record, overriding it with flags and naming the keys it ignored', async () => {
    const file = path.join(cacheHome, 'record.json');
    writeFileSync(
      file,
      JSON.stringify({
        key: 'OM-1',
        id: '1',
        summary: 'From the record',
        status: 'Ready',
        type: 'Manual',
        path: '/x',
        preconditions: [],
        steps: [{ index: '1', id: '9', action: 'Open', data: '', result: '', attachments: [] }],
        definition: null,
        links: [],
        plans: [],
        sets: [],
        fields: { components: ['Accounts'], 'Story Points': 3 },
      }),
    );
    const result = (await JiraXrayTestCreate.run(
      argv('--project', 'OM', '--file', file, '--summary', 'Flag wins', '--json'),
    )) as { notes: string[] };

    expect(created).toMatchObject({
      summary: 'Flag wins',
      components: [{ name: 'Accounts' }],
      // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
      customfield_40016: 3,
    });
    expect(result.notes[0]).toBe(
      'Ignored from the record, as this command does not write them: key, id, status, path, preconditions, links, plans, sets.',
    );
  });

  it('refuses a list of records, and a call step, before sending anything', async () => {
    const list = path.join(cacheHome, 'list.json');
    writeFileSync(list, '[{}]');
    expect((await failure(JiraXrayTestCreate.run(argv('--project', 'OM', '--file', list)))).message).toContain(
      '--format jsonl',
    );

    const call = path.join(cacheHome, 'call.json');
    writeFileSync(call, JSON.stringify({ summary: 'S', steps: [{ action: '', extra: { testCallBean: {} } }] }));
    expect((await failure(JiraXrayTestCreate.run(argv('--project', 'OM', '--file', call)))).message).toContain(
      'calls another test',
    );
    expect(writes()).toEqual([]);
  });

  it('links --verifies with the test as the subject of "tests"', async () => {
    server.route('/rest/api/2/issueLink', (_req, res) => respondJson(res, 201, {}));
    await JiraXrayTestCreate.run(base('--step', 'Open', '--verifies', 'OM-40', '--json'));

    const link = writes().find((request) => request.url === '/rest/api/2/issueLink');
    expect(JSON.parse(link?.body ?? '{}')).toEqual({
      type: { id: '7' },
      inwardIssue: { key: 'OM-50' },
      outwardIssue: { key: 'OM-40' },
    });
  });

  it('creates nothing when no link type matches', async () => {
    server.route('/rest/api/2/issueLinkType', (_req, res) => respondJson(res, 200, { issueLinkTypes: [] }));
    const error = await failure(JiraXrayTestCreate.run(base('--step', 'Open', '--verifies', 'OM-40')));

    expect(error.oclif?.exit).toBe(2);
    expect(writes()).toEqual([]);
  });

  it('reports the created key when a link fails, and does not delete the test', async () => {
    server.route('/rest/api/2/issueLink', (_req, res) => respondJson(res, 400, { errorMessages: ['nope'] }));
    const error = await failure(JiraXrayTestCreate.run(base('--step', 'Open', '--verifies', 'OM-40')));

    expect(error.message).toContain('OM-50 was created');
    expect(error.message).toContain('link to OM-40');
    expect(error.message).toContain('jira issue link create OM-50 tests OM-40');
    expect(writes().some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('sends no write on a dry run, and prints the request', async () => {
    await JiraXrayTestCreate.run(base('--step', 'Open', '--verifies', 'OM-40', '--dry-run'));

    expect(writes()).toEqual([]);
    expect(stdout.join('')).toContain('Would link to OM-40');
    expect(stdout.join('')).toContain(XRAY_FIXTURE_IDS.steps);
  });
});

describe('jira xray test update', () => {
  const STEP_PATH = '/rest/raven/1.0/api/test/OM-12/step';
  let fake: FakeXraySteps;
  let summary: string;

  beforeEach(() => {
    summary = 'Original';
    fake = routeXraySteps(server, 'OM-12', [
      { id: 311, action: 'Open', result: 'Shown' },
      { id: 312, action: 'Save', attachments: [{ id: 1, fileName: 'shot.png' }] },
    ]);
    server.route('/rest/api/2/issue/OM-12', (request, res, body) => {
      if (request.method === 'PUT') {
        summary = (JSON.parse(body) as { fields: { summary?: string } }).fields.summary ?? summary;
        res.writeHead(204);
        res.end();
        return;
      }
      respondJson(res, 200, xrayFixtureIssue('OM-12', { summary, steps: fake.fieldSteps() }));
    });
  });

  const writes = (): Array<{ method: string; url: string; body: string }> =>
    server.requests.filter((request) => request.method !== 'GET');
  const failure = async (run: Promise<unknown>): Promise<{ message: string; oclif?: { exit?: number } }> =>
    (await run.catch((caught: unknown) => caught)) as { message: string; oclif?: { exit?: number } };
  const exported = async (): Promise<XrayTestRecord> =>
    (await JiraXrayTestGet.run(argv('OM-12', '--json'))) as XrayTestRecord;
  const fileWith = (record: unknown): string => {
    const file = path.join(cacheHome, 'record.json');
    writeFileSync(file, JSON.stringify(record));
    return file;
  };

  it('sends no write at all for an unchanged export → update round trip', async () => {
    const file = fileWith(await exported());
    const result = (await JiraXrayTestUpdate.run(argv('OM-12', '--file', file, '--json'))) as {
      record: XrayTestRecord;
    };

    expect(writes()).toEqual([]);
    expect(result.record.key).toBe('OM-12');
  });

  it('applies an edited export: fields, then each step, and returns the test read back', async () => {
    const record = await exported();
    const file = fileWith({
      ...record,
      summary: 'Edited',
      steps: [{ ...record.steps[0], result: 'Sorted' }, record.steps[1], { action: 'New', data: '', result: '' }],
    });
    const result = (await JiraXrayTestUpdate.run(argv('OM-12', '--file', file, '--json'))) as {
      record: XrayTestRecord;
    };

    expect(writes()).toEqual([
      { method: 'PUT', url: '/rest/api/2/issue/OM-12', body: JSON.stringify({ fields: { summary: 'Edited' } }) },
      { method: 'POST', url: `${STEP_PATH}/311`, body: JSON.stringify({ result: 'Sorted' }) },
      { method: 'PUT', url: STEP_PATH, body: JSON.stringify({ step: 'New', data: '', result: '' }) },
    ]);
    expect(result.record.summary).toBe('Edited');
    expect(result.record.steps.map((step) => step.action)).toEqual(['Open', 'Save', 'New']);
  });

  it('refuses a shrinking replace without --confirm, and sends nothing', async () => {
    const record = await exported();
    const file = fileWith({ ...record, steps: [record.steps[0]] });
    const error = await failure(JiraXrayTestUpdate.run(argv('OM-12', '--file', file)));

    expect(error.message).toContain('delete step 312');
    expect(error.oclif?.exit).toBe(2);
    expect(writes()).toEqual([]);

    await JiraXrayTestUpdate.run(argv('OM-12', '--file', file, '--confirm', '--json'));
    expect(writes()).toEqual([{ method: 'DELETE', url: `${STEP_PATH}/312`, body: '' }]);
  });

  it('prints the plan on a dry run and writes nothing, even when it would delete', async () => {
    const record = await exported();
    const file = fileWith({ ...record, steps: [{ ...record.steps[0], action: 'Opened' }] });
    await JiraXrayTestUpdate.run(argv('OM-12', '--file', file, '--dry-run'));

    expect(writes()).toEqual([]);
    expect(stdout.join('')).toContain('update step 311: action');
    expect(stdout.join('')).toContain('delete step 312: Save');
  });

  it('refuses a stale id and a reordered list before anything is sent', async () => {
    const record = await exported();
    const stale = await failure(
      JiraXrayTestUpdate.run(
        argv('OM-12', '--file', fileWith({ ...record, summary: 'X', steps: [{ ...record.steps[0], id: '999' }] })),
      ),
    );
    expect(stale.message).toContain('Step 999 is not on OM-12');

    const reordered = await failure(
      JiraXrayTestUpdate.run(
        argv('OM-12', '--file', fileWith({ ...record, steps: [record.steps[1], record.steps[0]] })),
      ),
    );
    expect(reordered.message).toContain('delete and re-add');
    expect(writes()).toEqual([]);
  });

  it('matches hand-written steps by position, and warns about attachments', async () => {
    const result = (await JiraXrayTestUpdate.run(
      argv('OM-12', '--step', 'Open||Shown', '--step', 'Saved', '--json'),
    )) as { notes: string[] };

    expect(writes()).toEqual([{ method: 'POST', url: `${STEP_PATH}/312`, body: JSON.stringify({ step: 'Saved' }) }]);
    expect(result.notes.join()).toContain('shot.png');
  });

  it('notes custom columns, and does not send them', async () => {
    fake.steps[0].extra = { fields: { Comment: 'keep' } };
    const record = await exported();
    const file = fileWith({ ...record, steps: [{ ...record.steps[0], result: 'New' }, record.steps[1]] });
    const result = (await JiraXrayTestUpdate.run(argv('OM-12', '--file', file, '--json'))) as { notes: string[] };

    expect(result.notes.join()).toContain('Comment');
    expect(writes()[0]?.body).toBe(JSON.stringify({ result: 'New' }));
  });

  it('refuses to change the type of a test that has steps', async () => {
    const error = await failure(JiraXrayTestUpdate.run(argv('OM-12', '--type', 'generic')));

    expect(error.message).toContain('Delete the steps first');
    expect(writes()).toEqual([]);
  });

  it('reports what landed when a later step fails', async () => {
    server.route(`${STEP_PATH}/312`, (_req, res) => respondJson(res, 400, { error: 'nope' }));
    const error = await failure(
      JiraXrayTestUpdate.run(argv('OM-12', '--summary', 'Edited', '--step', 'Open||Shown', '--step', 'Saved')),
    );

    expect(error.message).toContain('only partly updated');
    expect(error.message).toContain('Applied: the issue fields');
    expect(error.message).toContain('Not applied: update step 312');
  });

  it('refuses nothing-to-do and a bad key, and the read-only guard holds', async () => {
    expect((await failure(JiraXrayTestUpdate.run(argv('OM-12')))).message).toContain('Nothing to update');
    expect((await failure(JiraXrayTestUpdate.run(argv('nope', '--summary', 'S')))).oclif?.exit).toBe(2);

    process.env.SIMPLY_ATLASSIAN_READ_ONLY = '1';
    expect((await failure(JiraXrayTestUpdate.run(argv('OM-12', '--summary', 'S')))).oclif?.exit).toBe(2);
    expect(writes()).toEqual([]);
  });
});
