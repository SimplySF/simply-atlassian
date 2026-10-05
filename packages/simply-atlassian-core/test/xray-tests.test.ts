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
import {
  exportXrayTests,
  getXrayTest,
  listXrayTests,
  renderXrayMarkdown,
  stepRows,
  type XrayCallStep,
} from '../src/xray-tests.js';
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

describe('called tests', () => {
  it('detects a call in both the testCallBean and the "Call Test KEY" forms, and renders it', async () => {
    add('OM-9', { summary: 'Log in as admin', steps: [xrayStep(1, 'Log in')] });
    add('OM-10', { summary: 'Open settings', steps: [xrayStep(1, 'Settings')] });
    add('OM-12', {
      steps: [
        {
          index: 1,
          fields: { Action: '', Data: '', 'Expected Result': '' },
          testCallBean: { calledTestIssueKey: 'OM-9' },
        },
        xrayStep(2, 'Call Test OM-10'),
      ],
    });

    const { record } = await getXrayTest(backend(), 'OM-12');

    expect(record.steps).toEqual([
      { index: '1', call: { key: 'OM-9', summary: 'Log in as admin' }, steps: [] },
      { index: '2', call: { key: 'OM-10', summary: 'Open settings' }, steps: [] },
    ]);
    expect(stepRows(record.steps).map((row) => row.action)).toEqual([
      '→ calls OM-9 "Log in as admin"',
      '→ calls OM-10 "Open settings"',
    ]);
  });

  it('prefers testCallBean over the action text when both are present', async () => {
    add('OM-9', {});
    add('OM-12', { steps: [{ index: 1, fields: { Action: 'Call Test OM-99' }, testCallBean: 'OM-9' }] });

    const { record } = await getXrayTest(backend(), 'OM-12');

    expect((record.steps[0] as XrayCallStep).call.key).toBe('OM-9');
  });

  it('inlines recursively with 3.1-style numbering, one search per call level', async () => {
    add('OM-8', { steps: [xrayStep(1, 'Deepest')] });
    add('OM-9', { steps: [xrayStep(1, 'Log in'), { index: 2, testCallBean: 'OM-8' }] });
    add('OM-12', { steps: [xrayStep(1, 'A'), xrayStep(2, 'B'), { index: 3, testCallBean: 'OM-9' }] });

    const { record } = await getXrayTest(backend(), 'OM-12', { expandCalls: true });

    expect(stepRows(record.steps).map((row) => `${row.index} ${row.action}`)).toEqual([
      '1 A',
      '2 B',
      '3 → calls OM-9 "Summary of OM-9"',
      '3.1 Log in',
      '3.2 → calls OM-8 "Summary of OM-8"',
      '3.2.1 Deepest',
    ]);
    expect(keySearches()).toEqual([['OM-9'], ['OM-8']]);
  });

  it('stops at a cycle, at the depth limit, and at a test the caller cannot see — none fatal', async () => {
    add('OM-1', { steps: [{ index: 1, testCallBean: 'OM-2' }] });
    add('OM-2', {
      steps: [
        { index: 1, testCallBean: 'OM-1' },
        { index: 2, testCallBean: 'OM-3' },
      ],
    });
    add('OM-3', { steps: [{ index: 1, testCallBean: 'OM-4' }] });
    add('OM-4', { steps: [xrayStep(1, 'too deep')] });
    add('OM-12', {
      steps: [
        { index: 1, testCallBean: 'OM-1' },
        { index: 2, testCallBean: 'OM-404' },
      ],
    });

    const { record, notes } = await getXrayTest(backend(), 'OM-12', { expandCalls: true, maxCallDepth: 2 });

    expect(stepRows(record.steps).map((row) => `${row.index} ${row.action}`)).toEqual([
      '1 → calls OM-1 "Summary of OM-1"',
      '1.1 → calls OM-2 "Summary of OM-2"',
      '1.1.1 ↺ cycle: OM-1',
      '1.1.2 → calls OM-3 (call depth limit reached)',
      '2 ⚠ not accessible: OM-404',
    ]);
    expect(notes).toEqual(['OM-404 (called test of OM-12) is not accessible; skipped.']);
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
  it('writes one record per test with every contract key, page by page', async () => {
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
    expect(result.records).toHaveLength(150);
    expect(result.complete).toBe(true);
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

  it('needs the repository path role', async () => {
    routeXrayDiscovery(server, {
      fields: XRAY_FIXTURE_FIELDS.filter((field) => (field as { id: string }).id !== XRAY_FIXTURE_IDS.repositoryPath),
    });

    await expect(listXrayFolders(backend(), { project: 'OM' })).rejects.toThrow(/"repositoryPath"/);
  });
});

describe('the fields report', () => {
  it('lists every role and the unmapped fields', async () => {
    const rows = xrayFieldRows(await backend().instance());

    expect(rows.find((row) => row.role === 'steps')).toMatchObject({ id: XRAY_FIXTURE_IDS.steps, name: 'Schritte' });
    expect(rows.find((row) => row.role === null)).toMatchObject({ id: 'customfield_93099', name: 'Neues Xray-Feld' });
  });
});
