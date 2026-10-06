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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createXrayBackend, type XrayBackend } from '../src/xray-backend.js';
import { listXrayContainers, listXrayFolders, xrayFieldRows } from '../src/xray-catalogue.js';
import { flattenFolders } from '../src/xray-folders.js';
import { exportXrayTests, getXrayTest, listXrayTests, renderXrayMarkdown, stepRows } from '../src/xray-tests.js';
import {
  keysInJql,
  respondJson,
  routeJiraSearch,
  routeXrayDiscovery,
  startTestServer,
  XRAY_FIXTURE_FIELDS,
  XRAY_FIXTURE_IDS,
  xrayFixtureIssue,
  xrayStep,
  type TestServer,
} from '../src/testing.js';

let server: TestServer;
let cacheDir: string;
/** The fake instance's issues, by key. */
let store: Map<string, unknown>;

beforeEach(async () => {
  server = await startTestServer();
  cacheDir = mkdtempSync(path.join(tmpdir(), 'xray-tests-'));
  store = new Map();
  routeXrayDiscovery(server);
  server.route('/rest/api/2/issue/OM-12', (_req, res) => respondJson(res, 200, store.get('OM-12')));
  routeJiraSearch(server, (jql) => {
    const keys = keysInJql(jql);
    if (keys.length > 0) return keys.map((key) => store.get(key)).filter((issue) => issue !== undefined);
    // Any scope query: every Test in the store, in key order.
    return [...store.values()].filter(
      (issue) => (issue as { fields: { issuetype: { name: string } } }).fields.issuetype.name === 'Prüfung',
    );
  });
});

afterEach(async () => {
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

function backend(): XrayBackend {
  return createXrayBackend(
    { url: server.baseUrl, deployment: 'server', auth: { kind: 'bearer', personalToken: 'pat' } },
    { cacheDir },
  );
}

function add(key: string, options: Parameters<typeof xrayFixtureIssue>[1] = {}): void {
  store.set(key, xrayFixtureIssue(key, options));
}

function keySearches(): string[][] {
  return server.requests
    .map((request) => new URL(request.url, 'http://x'))
    .filter((url) => url.pathname === '/rest/api/2/search')
    .map((url) => keysInJql(url.searchParams.get('jql') ?? ''))
    .filter((keys) => keys.length > 0);
}

describe('test get', () => {
  it('assembles a manual test with steps, preconditions, links, membership and path', async () => {
    add('OM-3', { summary: 'Admin account exists', issueType: 'Vorbedingung' });
    add('OM-12', {
      summary: "Admin can reset a user's password",
      steps: [xrayStep(1, 'Open Users', 'List shown'), xrayStep(2, 'Pick a user', 'Details shown', 'bob')],
      preconditions: ['OM-3'],
      plans: ['OM-7'],
      sets: ['OM-31'],
      path: 'O&M/Accounts',
      links: [
        {
          id: '1',
          type: { name: 'Tests', inward: 'is tested by', outward: 'tests' },
          outwardIssue: {
            key: 'OM-40',
            fields: { summary: 'Reset passwords', status: { name: 'Done' }, issuetype: { name: 'Story' } },
          },
        },
      ],
    });

    const { record, notes } = await getXrayTest(backend(), 'OM-12');

    expect(record).toEqual({
      key: 'OM-12',
      id: '10012',
      summary: "Admin can reset a user's password",
      status: 'Ready',
      type: 'Manual',
      path: '/O&M/Accounts',
      preconditions: [{ key: 'OM-3', summary: 'Admin account exists' }],
      steps: [
        { index: '1', action: 'Open Users', data: '', result: 'List shown', attachments: [] },
        { index: '2', action: 'Pick a user', data: 'bob', result: 'Details shown', attachments: [] },
      ],
      definition: null,
      links: [
        {
          type: 'Tests',
          direction: 'outward',
          relationship: 'tests',
          key: 'OM-40',
          issueType: 'Story',
          status: 'Done',
          summary: 'Reset passwords',
        },
      ],
      plans: ['OM-7'],
      sets: ['OM-31'],
      fields: {},
    });
    expect(notes).toEqual([]);
  });

  it('refuses an issue that is not an Xray Test', async () => {
    add('OM-12', { issueType: 'Story' });

    await expect(getXrayTest(backend(), 'OM-12')).rejects.toThrow(/OM-12 is a Story, not an Xray Prüfung/);
  });

  it('reads a Cucumber definition', async () => {
    add('OM-12', { testType: 'Cucumber', scenario: 'Scenario: log in\n  Given a user' });

    const { record } = await getXrayTest(backend(), 'OM-12');

    expect(record.type).toBe('Cucumber');
    expect(record.definition).toBe('Scenario: log in\n  Given a user');
    expect(renderXrayMarkdown(record)).toContain('```gherkin\nScenario: log in');
  });

  it('puts requested fields in "fields", keyed by the name the caller used and simplified', async () => {
    // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
    add('OM-12', { extra: { components: [{ id: '1', name: 'Accounts' }], customfield_40016: 3 } });

    const { record } = await getXrayTest(backend(), 'OM-12', { fields: ['components', 'Story Points'] });

    expect(record.fields).toEqual({ components: ['Accounts'], 'Story Points': 3 });
  });
});

describe('step data this version does not interpret', () => {
  it('passes a call to another test through under "extra", names it in the table, and notes it once', async () => {
    const bean = { anything: 'as Xray sent it', nested: { id: 10_009 } };
    add('OM-12', {
      steps: [
        xrayStep(1, 'Open Users'),
        {
          id: 2,
          index: 2,
          fields: { Action: '', Data: '', 'Expected Result': '' },
          attachments: [],
          testCallBean: bean,
        },
        {
          id: 3,
          index: 3,
          fields: { Action: '', Data: '', 'Expected Result': '' },
          attachments: [],
          testCallBean: bean,
        },
      ],
    });

    const { record, notes } = await getXrayTest(backend(), 'OM-12');

    expect(record.steps[0]).not.toHaveProperty('extra');
    expect(record.steps[1]).toEqual({
      index: '2',
      action: '',
      data: '',
      result: '',
      attachments: [],
      extra: { testCallBean: bean },
    });
    expect(stepRows(record.steps).map((row) => row.action)).toEqual([
      'Open Users',
      '(not interpreted: testCallBean)',
      '(not interpreted: testCallBean)',
    ]);
    expect(notes).toEqual([
      'Steps carry "testCallBean", which this version does not interpret; it is passed through under the step\'s "extra".',
    ]);
    expect(renderXrayMarkdown(record)).toContain('| 2 | (not interpreted: testCallBean) |  |  |');
  });

  it("keeps a step column beyond action, data and expected result, and the step's own text", async () => {
    add('OM-12', {
      steps: [{ id: 1, index: 1, fields: { Action: 'Log in', Data: '', 'Expected Result': 'Home', Comment: 'flaky' } }],
    });

    const { record, notes } = await getXrayTest(backend(), 'OM-12');

    expect(record.steps[0]).toMatchObject({
      action: 'Log in',
      result: 'Home',
      extra: { fields: { Comment: 'flaky' } },
    });
    expect(stepRows(record.steps)[0]?.action).toBe('Log in');
    expect(notes[0]).toContain('"fields.Comment"');
  });

  it('names a custom column by its column name when it is all a step carries', async () => {
    add('OM-12', { steps: [{ id: 1, index: 1, fields: { Action: '', Comment: 'see ticket' } }] });

    const { record } = await getXrayTest(backend(), 'OM-12');

    expect(stepRows(record.steps)[0]?.action).toBe('(not interpreted: fields.Comment)');
  });

  it('leaves out testVersionId, which every step carries, without noting it', async () => {
    add('OM-12', { steps: [xrayStep(1, 'Open Users'), xrayStep(2, 'Pick a user')] });

    const { record, notes } = await getXrayTest(backend(), 'OM-12');

    expect(record.steps[0]).not.toHaveProperty('extra');
    expect(JSON.stringify(record)).not.toContain('testVersionId');
    expect(notes).toEqual([]);
  });

  it('reads the older flat form and keeps only what it does not read', async () => {
    add('OM-12', { steps: [{ id: 1, index: 1, step: { raw: 'Open' }, data: 'x', result: 'Shown', rank: 7 }] });

    const { record } = await getXrayTest(backend(), 'OM-12');

    expect(record.steps[0]).toEqual({
      index: '1',
      action: 'Open',
      data: 'x',
      result: 'Shown',
      attachments: [],
      extra: { rank: 7 },
    });
  });

  it('fetches only preconditions besides the page itself: one search per page', async () => {
    add('OM-3', { issueType: 'Vorbedingung' });
    add('OM-12', { steps: [{ index: 1, testCallBean: 'OM-9' }], preconditions: ['OM-3'] });

    await getXrayTest(backend(), 'OM-12');

    expect(keySearches()).toEqual([['OM-3']]);
  });
});

describe('test list', () => {
  it('returns rows plus the raw search envelope, with requested fields as columns', async () => {
    add('OM-1', { extra: { labels: ['smoke'] } });
    add('OM-2', { testType: 'Generic' });
    store.set('OM-50', xrayFixtureIssue('OM-50', { issueType: 'Story' }));
    routeXrayDiscovery(server, {
      fields: [...XRAY_FIXTURE_FIELDS, { id: 'labels', name: 'Labels', custom: false, schema: { type: 'array' } }],
    });

    const result = await listXrayTests(backend(), { scope: { project: 'OM' }, fields: ['labels'], limit: 25 });

    expect(result.rows).toEqual([
      { key: 'OM-1', type: 'Manual', status: 'Ready', summary: 'Summary of OM-1', fields: { labels: ['smoke'] } },
      { key: 'OM-2', type: 'Generic', status: 'Ready', summary: 'Summary of OM-2', fields: { labels: null } },
    ]);
    expect(result.search.complete).toBe(true);
    expect(result.search.total).toBe(2);
  });
});

describe('test export', () => {
  it('streams records page by page without also collecting them', async () => {
    for (let index = 1; index <= 150; index += 1) add(`OM-${index}`, { steps: [xrayStep(1, `step ${index}`)] });
    const pages: number[] = [];

    const result = await exportXrayTests(backend(), {
      scope: { project: 'OM' },
      limit: 1000,
      onRecords: (records) => {
        pages.push(records.length);
      },
    });

    expect(pages).toEqual([100, 50]);
    expect(result.records).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('collects every record when nothing streams them, with every contract key', async () => {
    for (let index = 1; index <= 150; index += 1) add(`OM-${index}`, { steps: [xrayStep(1, `step ${index}`)] });

    const result = await exportXrayTests(backend(), { scope: { project: 'OM' }, limit: 1000 });

    expect(result.records).toHaveLength(150);
    expect(Object.keys(result.records[0] ?? {}).sort()).toEqual(
      [
        'definition',
        'fields',
        'id',
        'key',
        'links',
        'path',
        'plans',
        'preconditions',
        'sets',
        'status',
        'steps',
        'summary',
        'type',
      ].sort(),
    );
  });

  it('reports a limit that stopped the export early', async () => {
    for (let index = 1; index <= 5; index += 1) add(`OM-${index}`);

    const result = await exportXrayTests(backend(), { scope: { project: 'OM' }, limit: 3 });

    expect(result.records).toHaveLength(3);
    expect(result.complete).toBe(false);
    expect(result.total).toBe(5);
  });

  it('renders Markdown, one section per test, with pipes and newlines made table-safe', async () => {
    add('OM-12', { summary: 'Reset', steps: [xrayStep(1, 'Type a|b', 'line one\nline two')], plans: ['OM-7'] });

    const { records } = await exportXrayTests(backend(), { scope: { project: 'OM' }, limit: 10 });
    const markdown = records.map((record) => renderXrayMarkdown(record)).join('');

    expect(markdown).toContain('## OM-12 — Reset');
    expect(markdown).toContain('- **Plans:** OM-7');
    expect(markdown).toContain('| 1 | Type a\\|b |  | line one<br>line two |');
  });
});

describe('after a rediscovery', () => {
  /** The same fields before a reinstall gave them new ids. */
  const oldFields = XRAY_FIXTURE_FIELDS.map((field: unknown) => {
    const { id, ...rest } = field as { id: string };
    return { ...rest, id: id.replace('customfield_93', 'customfield_80') };
  });

  /**
   * Like Jira: only the requested fields that exist come back, an empty one as `null`, and an id it
   * does not know is left out with no error.
   */
  function onlyRequested(issue: unknown, requested: string[]): unknown {
    const { fields = {}, ...rest } = issue as { fields?: Record<string, unknown> };
    return {
      ...rest,
      fields: Object.fromEntries(requested.filter((id) => id in fields).map((id) => [id, fields[id]])),
    };
  }

  /** Records the old ids, then answers like the reinstalled instance, which knows only the new ones. */
  async function reinstall(answer: (jql: string) => unknown[]): Promise<void> {
    routeXrayDiscovery(server, { fields: oldFields });
    await backend().instance();
    routeXrayDiscovery(server);
    server.route('/rest/api/2/search', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const requested = (url.searchParams.get('fields') ?? '').split(',');
      const issues = answer(url.searchParams.get('jql') ?? '').map((issue) => onlyRequested(issue, requested));
      respondJson(response, 200, { startAt: 0, maxResults: 100, total: issues.length, issues });
    });
    server.route('/rest/api/2/issue/OM-12', (request, response) => {
      const requested = (new URL(request.url ?? '/', 'http://x').searchParams.get('fields') ?? '').split(',');
      respondJson(response, 200, onlyRequested(store.get('OM-12'), requested));
    });
  }

  it('gets a test with the fresh field ids', async () => {
    add('OM-12', { steps: [xrayStep(1, 'Open Users', 'List shown')], path: 'O&M' });
    await reinstall(() => []);

    const { record } = await getXrayTest(backend(), 'OM-12');

    expect(record).toMatchObject({ type: 'Manual', path: '/O&M', steps: [{ action: 'Open Users' }] });
  });

  const testsOnly = (jql: string): unknown[] =>
    jql.includes('key in') ? keysInJql(jql).map((key) => store.get(key)) : [store.get('OM-12')];

  it('exports with the fresh field ids, so steps and type are read', async () => {
    add('OM-12', { steps: [xrayStep(1, 'Open Users', 'List shown')], path: 'O&M' });
    await reinstall(testsOnly);

    const { records } = await exportXrayTests(backend(), { scope: { project: 'OM' }, fields: ['steps'], limit: 10 });

    expect(records[0]).toMatchObject({
      type: 'Manual',
      path: '/O&M',
      steps: [{ index: '1', action: 'Open Users', result: 'List shown' }],
    });
    expect(records[0]?.fields.steps).not.toBeNull();
  });

  it('lists tests with the fresh test type field', async () => {
    add('OM-12', { testType: 'Generic' });
    await reinstall(testsOnly);

    const { rows, search } = await listXrayTests(backend(), { scope: { project: 'OM' }, limit: 10 });

    expect(rows[0]?.type).toBe('Generic');
    expect(search).not.toHaveProperty('instance');
  });

  it("counts a plan's tests with the fresh tests field", async () => {
    store.set('OM-7', {
      key: 'OM-7',
      fields: {
        summary: 'Release 1',
        status: { name: 'Open' },
        issuetype: { name: 'Prüfplan' },
        [XRAY_FIXTURE_IDS.testPlanTests]: ['OM-1', 'OM-2'],
      },
    });
    await reinstall(() => [store.get('OM-7')]);

    const { rows } = await listXrayContainers(backend(), 'plan', { project: 'OM', limit: 25 });

    expect(rows[0]?.testCount).toBe(2);
  });
});

describe('plan list and set list', () => {
  it('lists plans in a project with how many tests each holds', async () => {
    store.set('OM-7', {
      key: 'OM-7',
      fields: {
        summary: 'Release 1',
        status: { name: 'Open' },
        issuetype: { name: 'Prüfplan' },
        [XRAY_FIXTURE_IDS.testPlanTests]: ['OM-1', 'OM-2', 'OM-3'],
      },
    });
    routeJiraSearch(server, (jql) => (jql.includes('"Prüfplan"') ? [store.get('OM-7')] : []));

    const { rows } = await listXrayContainers(backend(), 'plan', { project: 'OM', limit: 25 });

    expect(rows).toEqual([{ key: 'OM-7', status: 'Open', summary: 'Release 1', testCount: 3, fields: {} }]);
  });

  it('asks for the set type and its tests field for sets', async () => {
    routeJiraSearch(server, () => []);

    await listXrayContainers(backend(), 'set', { project: 'OM', search: 'smoke', limit: 25 });

    const url = new URL(server.requests.at(-1)?.url ?? '', 'http://x');
    expect(url.searchParams.get('jql')).toBe(
      'project = "OM" AND issuetype = "Prüfsammlung" AND (summary ~ "smoke" OR description ~ "smoke") ORDER BY key ASC',
    );
    expect(url.searchParams.get('fields')).toContain(XRAY_FIXTURE_IDS.testSetTests);
  });
});

describe('path list', () => {
  beforeEach(() => {
    server.route('/rest/raven/1.0/api/testrepository/OM/folders', (_req, res) =>
      respondJson(res, 200, {
        id: -1,
        name: 'Test Repository',
        testsCount: 1,
        folders: [
          {
            id: 1,
            name: 'O&M',
            testRepositoryPath: 'O&M',
            testsCount: 2,
            folders: [{ id: 2, name: 'Accounts', testRepositoryPath: 'O&M/Accounts', testsCount: 5, folders: [] }],
          },
        ],
      }),
    );
  });

  it('shows the whole tree with test counts and leading-slash paths', async () => {
    const tree = await listXrayFolders(backend(), { project: 'OM' });

    expect(flattenFolders(tree).map(({ folder, depth }) => `${depth} ${folder.path} ${folder.testCount}`)).toEqual([
      '0 / 1',
      '1 /O&M 2',
      '2 /O&M/Accounts 5',
    ]);
  });

  it('starts at --path, with or without the leading slash, and cuts at --depth', async () => {
    expect((await listXrayFolders(backend(), { project: 'OM', path: 'O&M/Accounts' })).path).toBe('/O&M/Accounts');
    expect((await listXrayFolders(backend(), { project: 'OM', path: '/O&M' })).folders).toHaveLength(1);
    expect((await listXrayFolders(backend(), { project: 'OM', depth: 1 })).folders[0]?.folders).toEqual([]);
    await expect(listXrayFolders(backend(), { project: 'OM', path: '/nope' })).rejects.toThrow(/No folder/);
  });

  it("needs no discovered path field, since it reads Xray's REST API", async () => {
    routeXrayDiscovery(server, {
      fields: XRAY_FIXTURE_FIELDS.filter((field) => (field as { id: string }).id !== XRAY_FIXTURE_IDS.repositoryPath),
    });

    const tree = await listXrayFolders(backend(), { project: 'OM' });

    expect(flattenFolders(tree)).toHaveLength(3);
  });
});

describe('the fields report', () => {
  it('lists every role and the unmapped fields', async () => {
    const rows = xrayFieldRows(await backend().instance());

    expect(rows.find((row) => row.role === 'steps')).toMatchObject({ id: XRAY_FIXTURE_IDS.steps, name: 'Schritte' });
    expect(rows.find((row) => row.role === null)).toMatchObject({ id: 'customfield_93099', name: 'Neues Xray-Feld' });
  });
});
