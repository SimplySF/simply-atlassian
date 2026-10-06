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
import { createXrayBackend, jqlString, type XrayBackend } from '../src/xray-backend.js';
import { combineJql, folderArgument, resolveScope, scopeJql, searchScopedTests } from '../src/xray-scope.js';
import {
  keysInJql,
  respondJson,
  routeJiraSearch,
  routeXrayDiscovery,
  startTestServer,
  XRAY_FIXTURE_FIELDS,
  XRAY_FIXTURE_IDS,
  type TestServer,
} from '../src/testing.js';

let server: TestServer;
let cacheDir: string;

beforeEach(async () => {
  server = await startTestServer();
  cacheDir = mkdtempSync(path.join(tmpdir(), 'xray-scope-'));
  routeXrayDiscovery(server);
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

function searchedJql(): string[] {
  return server.requests
    .map((request) => new URL(request.url, 'http://x'))
    .filter((url) => url.pathname === '/rest/api/2/search')
    .map((url) => url.searchParams.get('jql') ?? '');
}

describe('scope resolution', () => {
  it('requires exactly one scope', () => {
    expect(() => resolveScope({})).toThrow(/Pass one scope/);
    expect(() => resolveScope({ plan: 'OM-7', set: 'OM-8' })).toThrow(/only one scope.*--plan and --set/);
    expect(() => resolveScope({ path: '/A' })).toThrow(/pass --project with it/);
    expect(() => resolveScope({ project: 'OM', recursive: true })).toThrow(/--recursive applies to --path/);
  });

  it('refuses keys that are not shaped like keys', () => {
    expect(() => resolveScope({ plan: 'OM' })).toThrow(/--plan takes an issue key/);
    expect(() => resolveScope({ project: 'OM-1' })).toThrow(/not a project key/);
  });

  it('spells the repository root as "" and every other path one way', () => {
    expect(folderArgument('/')).toBe('');
    expect(folderArgument(' // ')).toBe('');
    expect(folderArgument('/O&M/Accounts')).toBe('/O&M/Accounts');
    expect(folderArgument('O&M/Accounts')).toBe('/O&M/Accounts');
    expect(folderArgument('/O&M/Accounts/')).toBe('/O&M/Accounts');
    expect(folderArgument('//O&M//Accounts')).toBe('/O&M/Accounts');
  });
});

describe('scope and filter JQL', () => {
  it('writes each scope with the discovered type name and Xray JQL functions', async () => {
    const instance = await backend().instance();

    expect(scopeJql(resolveScope({ project: 'OM' }), instance)).toBe('project = "OM" AND issuetype = "Prüfung"');
    expect(scopeJql(resolveScope({ plan: 'OM-7' }), instance)).toBe('issue in testPlanTests("OM-7")');
    expect(scopeJql(resolveScope({ set: 'OM-8' }), instance)).toBe('issue in testSetTests("OM-8")');
    expect(scopeJql(resolveScope({ project: 'OM', path: '/O&M', recursive: true }), instance)).toBe(
      'issue in testRepositoryFolderTests("OM", "/O&M", "true")',
    );
    expect(scopeJql(resolveScope({ project: 'OM', path: '/' }), instance)).toBe(
      'issue in testRepositoryFolderTests("OM", "", "false")',
    );
  });

  it('scopes by path even when discovery did not find the path field, which the function never uses', async () => {
    routeXrayDiscovery(server, {
      fields: XRAY_FIXTURE_FIELDS.filter((field) => (field as { id: string }).id !== XRAY_FIXTURE_IDS.repositoryPath),
    });
    const instance = await backend().instance();

    expect(instance.field('repositoryPath')).toBeUndefined();
    expect(scopeJql(resolveScope({ project: 'OM', path: 'O&M/' }), instance)).toBe(
      'issue in testRepositoryFolderTests("OM", "/O&M", "false")',
    );
  });

  it('parenthesises --jql, so an OR inside it cannot widen the scope', () => {
    expect(combineJql('S', { jql: 'labels = a OR labels = b' })).toBe(
      'S AND (labels = a OR labels = b) ORDER BY key ASC',
    );
  });

  it('moves an ORDER BY in --jql to the end, where JQL requires it', () => {
    expect(combineJql('S', { jql: 'labels = a order by created DESC' })).toBe(
      'S AND (labels = a) ORDER BY created DESC',
    );
    expect(combineJql('S', { jql: 'ORDER BY rank' })).toBe('S ORDER BY rank');
    expect(combineJql('S', { jql: '(labels = a)order by rank' })).toBe('S AND ((labels = a)) ORDER BY rank');
  });

  it('leaves an "order by" inside a quoted string alone', () => {
    expect(combineJql('S', { jql: 'summary ~ "sort order by date"' })).toBe(
      'S AND (summary ~ "sort order by date") ORDER BY key ASC',
    );
    expect(combineJql('S', { jql: "summary ~ 'say \\' order by x' ORDER BY created" })).toBe(
      "S AND (summary ~ 'say \\' order by x') ORDER BY created",
    );
    expect(combineJql('S', { jql: 'reorder by = 1' })).toBe('S AND (reorder by = 1) ORDER BY key ASC');
  });

  it('escapes --search for Lucene and then as a JQL string, so it matches as typed', () => {
    // Lucene sees `say \"hi\" \\ bye`; each backslash and quote is escaped again for JQL.
    expect(combineJql('S', { search: 'say "hi" \\ bye' })).toBe(
      'S AND (summary ~ "say \\\\\\"hi\\\\\\" \\\\\\\\ bye" OR description ~ "say \\\\\\"hi\\\\\\" \\\\\\\\ bye") ORDER BY key ASC',
    );
    expect(combineJql('S', { search: 'C++ foo-bar *' })).toBe(
      'S AND (summary ~ "C\\\\+\\\\+ foo\\\\-bar \\\\*" OR description ~ "C\\\\+\\\\+ foo\\\\-bar \\\\*") ORDER BY key ASC',
    );
    expect(jqlString('line\nbreak')).toBe('"line break"');
  });

  it('ORs several --linked-to keys together', () => {
    expect(combineJql('S', { linkedTo: ['OM-40', 'OM-41'] })).toBe(
      'S AND (issue in linkedIssues("OM-40") OR issue in linkedIssues("OM-41")) ORDER BY key ASC',
    );
    expect(() => combineJql('S', { linkedTo: ['nope'] })).toThrow(/--linked-to/);
  });
});

describe('searchScopedTests', () => {
  const fields = (): string[] => ['summary'];

  it('runs one JQL query when the instance has the function', async () => {
    routeJiraSearch(server, () => [{ key: 'OM-1' }, { key: 'OM-2' }]);

    const result = await searchScopedTests(backend(), { plan: 'OM-7' }, { search: 'login' }, fields, { limit: 25 });

    expect(result.issues).toHaveLength(2);
    expect(searchedJql()).toEqual([
      'issue in testPlanTests("OM-7") AND (summary ~ "login" OR description ~ "login") ORDER BY key ASC',
    ]);
  });

  it("returns a plan's tests whether added directly or through a Test Set, as Xray expands sets", async () => {
    // Xray stores a set added to a plan as the set's individual tests, so the function returns them.
    routeJiraSearch(server, (jql) => (jql.includes('testPlanTests') ? [{ key: 'OM-1' }, { key: 'OM-32' }] : []));

    const result = await searchScopedTests(backend(), { plan: 'OM-7' }, {}, fields, { limit: 25 });

    expect(result.issues).toEqual([{ key: 'OM-1' }, { key: 'OM-32' }]);
  });

  it('falls back to the REST API when the JQL function is missing, validating the filters once', async () => {
    const tests = [{ key: 'OM-1' }, { key: 'OM-2' }];
    server.route('/rest/api/2/search', (request, response) => {
      const jql = new URL(request.url ?? '/', 'http://x').searchParams.get('jql') ?? '';
      if (jql.includes('testPlanTests')) {
        respondJson(response, 400, { errorMessages: ["Unable to find JQL function 'testPlanTests(OM-7)'."] });
        return;
      }
      const wanted = keysInJql(jql);
      respondJson(response, 200, {
        issues: tests.filter((t) => wanted.includes(t.key)),
        total: 2,
        startAt: 0,
        maxResults: 100,
      });
    });
    server.route('/rest/raven/1.0/api/testplan/OM-7/test', (_req, res) =>
      respondJson(res, 200, [
        { key: 'OM-1', id: 1 },
        { key: 'OM-2', id: 2 },
      ]),
    );

    const result = await searchScopedTests(backend(), { plan: 'OM-7' }, { jql: 'labels = x' }, fields, { limit: 25 });

    expect(result.issues).toEqual(tests);
    expect(result.complete).toBe(true);
    expect(searchedJql().slice(1)).toEqual([
      '(labels = x)',
      'key in ("OM-1", "OM-2") AND (labels = x) ORDER BY key ASC',
    ]);
  });

  describe('on the fallback route', () => {
    /** A plan whose JQL function is missing, and whose REST answer lists `keys` in that order. */
    function fallbackPlan(keys: string[], onSearch?: (jql: string) => unknown): void {
      server.route('/rest/api/2/search', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://x');
        const jql = url.searchParams.get('jql') ?? '';
        if (jql.includes('testPlanTests')) {
          respondJson(response, 400, { errorMessages: ["Unable to find JQL function 'testPlanTests(OM-7)'."] });
          return;
        }
        const error = onSearch?.(jql);
        if (error !== undefined) {
          respondJson(response, 400, error);
          return;
        }
        const all = keysInJql(jql).map((key) => ({ key }));
        const maxResults = Number(url.searchParams.get('maxResults'));
        respondJson(response, 200, { issues: all.slice(0, maxResults), total: all.length, startAt: 0, maxResults });
      });
      server.route('/rest/raven/1.0/api/testplan/OM-7/test', (req, res) => {
        const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page'));
        respondJson(
          res,
          200,
          keys.slice((page - 1) * 100, page * 100).map((key) => ({ key })),
        );
      });
    }

    it('orders across chunks by key, so limit keeps the same tests as the JQL route', async () => {
      const keys = Array.from({ length: 150 }, (_value, index) => `OM-${150 - index}`);
      fallbackPlan(['AB-2', ...keys]);

      const result = await searchScopedTests(backend(), { plan: 'OM-7' }, {}, fields, { limit: 120 });

      const returned = result.issues.map((issue) => (issue as { key: string }).key);
      expect(returned.slice(0, 3)).toEqual(['AB-2', 'OM-1', 'OM-2']);
      expect(returned).toHaveLength(120);
      expect(returned.at(-1)).toBe('OM-119');
      expect(result.complete).toBe(false);
    });

    it('refuses an ORDER BY in --jql, which cannot apply across chunks', async () => {
      fallbackPlan(['OM-1']);

      await expect(
        searchScopedTests(backend(), { plan: 'OM-7' }, { jql: 'labels = x ORDER BY created' }, fields, { limit: 25 }),
      ).rejects.toThrow(/no testPlanTests JQL function.*Remove the ORDER BY/);
    });

    it('reports a mistake in --jql rather than returning no tests', async () => {
      fallbackPlan(['OM-1'], (jql) =>
        jql.startsWith('key in') ? undefined : { errorMessages: ["Field 'labelz' does not exist."] },
      );

      await expect(
        searchScopedTests(backend(), { plan: 'OM-7' }, { jql: 'labelz = x' }, fields, { limit: 25 }),
      ).rejects.toThrow(/labelz/);
    });
  });

  it('falls back for a repository path by resolving the folder id from the tree', async () => {
    server.route('/rest/api/2/search', (request, response) => {
      const jql = new URL(request.url ?? '/', 'http://x').searchParams.get('jql') ?? '';
      if (jql.includes('testRepositoryFolderTests')) {
        respondJson(response, 400, { errorMessages: ["Unable to find JQL function 'testRepositoryFolderTests'."] });
        return;
      }
      respondJson(response, 200, {
        issues: keysInJql(jql).map((key) => ({ key })),
        total: 1,
        startAt: 0,
        maxResults: 100,
      });
    });
    server.route('/rest/raven/1.0/api/testrepository/OM/folders', (_req, res) =>
      respondJson(res, 200, {
        id: -1,
        name: '',
        folders: [{ id: 12, name: 'O&M', testRepositoryPath: 'O&M', folders: [] }],
      }),
    );
    let recursive: string | null = null;
    server.route('/rest/raven/1.0/api/testrepository/OM/folders/12/tests', (req, res) => {
      recursive = new URL(req.url ?? '/', 'http://x').searchParams.get('allDescendants');
      respondJson(res, 200, { total: 1, tests: [{ key: 'OM-5' }] });
    });

    const result = await searchScopedTests(backend(), { project: 'OM', path: 'O&M', recursive: true }, {}, fields, {
      limit: 25,
    });

    expect(result.issues).toEqual([{ key: 'OM-5' }]);
    expect(recursive).toBe('true');
  });

  it('does not fall back for a project scope, which needs no Xray function', async () => {
    server.route('/rest/api/2/search', (_req, res) => respondJson(res, 400, { errorMessages: ['function broke'] }));

    await expect(searchScopedTests(backend(), { project: 'OM' }, {}, fields, { limit: 25 })).rejects.toThrow(/400/);
  });

  it('reports a limit that cuts the results short', async () => {
    routeJiraSearch(server, () => Array.from({ length: 30 }, (_value, index) => ({ key: `OM-${index + 1}` })));

    const result = await searchScopedTests(backend(), { project: 'OM' }, {}, fields, { limit: 10 });

    expect(result.issues).toHaveLength(10);
    expect(result.complete).toBe(false);
    expect(result.total).toBe(30);
  });
});
