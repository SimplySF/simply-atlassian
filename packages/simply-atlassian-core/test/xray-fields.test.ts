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

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { createXrayBackend, type XrayBackend } from '../src/xray-backend.js';
import { defaultXrayCacheDir, loadXrayRecord, XRAY_FIELD_ROLES, xrayRecordPath } from '../src/xray-fields.js';
import {
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
let warnings: string[];

beforeEach(async () => {
  server = await startTestServer();
  cacheDir = mkdtempSync(path.join(tmpdir(), 'xray-cache-'));
  warnings = [];
});

afterEach(async () => {
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

function backend(dir = cacheDir): XrayBackend {
  return createXrayBackend(
    { url: server.baseUrl, deployment: 'server', auth: { kind: 'bearer', personalToken: 'pat' } },
    { cacheDir: dir, onWarning: (message) => warnings.push(message) },
  );
}

function requestsTo(pathname: string): number {
  return server.requests.filter((request) => new URL(request.url, 'http://x').pathname === pathname).length;
}

describe('Xray field discovery', () => {
  it('maps every role by schema type even though every field is renamed', async () => {
    routeXrayDiscovery(server);

    const instance = await backend().instance();

    expect(instance.record.fields).toEqual(XRAY_FIXTURE_IDS);
    expect(Object.keys(instance.record.fields)).toHaveLength(XRAY_FIELD_ROLES.length);
  });

  it('recognises renamed issue types by description, or by plugin icon when the description is blank', async () => {
    routeXrayDiscovery(server);

    const instance = await backend().instance();

    expect(instance.record.issueTypes).toEqual({
      test: 'Prüfung',
      testSet: 'Prüfsammlung',
      testPlan: 'Prüfplan',
      testExecution: 'Prüflauf',
      precondition: 'Vorbedingung',
    });
  });

  it('records Xray fields with no role, so they can still be requested by name', async () => {
    routeXrayDiscovery(server);

    const { record } = await backend().instance();

    // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
    expect(record.unmapped).toEqual({ customfield_93099: 'com.xpandit.plugins.xray:some-future-custom-field' });
    expect(record.fieldNames.customfield_93099).toBe('Neues Xray-Feld');
    expect(record.xrayVersion).toBe('7.4.0');
  });

  it('names the role and the Xray release that introduced it when an older instance lacks it', async () => {
    routeXrayDiscovery(server, {
      fields: XRAY_FIXTURE_FIELDS.filter((field) => (field as { id: string }).id !== XRAY_FIXTURE_IDS.repositoryPath),
    });

    const instance = await backend().instance();

    expect(() => instance.requireField('repositoryPath')).toThrow(ConfigError);
    expect(() => instance.requireField('repositoryPath')).toThrow(/"repositoryPath".*3\.x–4\.x/);
  });

  it('records a version it cannot read as null rather than failing discovery', async () => {
    routeXrayDiscovery(server);
    server.route('/rest/plugins/1.0/com.xpandit.plugins.xray-key', (_req, res) => respondJson(res, 401, {}));

    expect((await backend().instance()).record.xrayVersion).toBeNull();
  });
});

describe('the Xray instance record', () => {
  it('is saved on first use, and later commands send no discovery request', async () => {
    routeXrayDiscovery(server);

    await backend().instance();
    await backend().instance();

    expect(requestsTo('/rest/api/2/field')).toBe(1);
    const file = xrayRecordPath(cacheDir, server.baseUrl);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ jiraUrl: server.baseUrl });
  });

  it('is named after the host and path, with the port colon made file-system safe', () => {
    expect(xrayRecordPath('/c', 'https://jira.example.gov/jira')).toBe(path.join('/c', 'jira.example.gov_jira.json'));
    expect(xrayRecordPath('/c', 'http://127.0.0.1:8080')).toBe(path.join('/c', '127.0.0.1_8080.json'));
  });

  it('defaults under XDG_CACHE_HOME, then ~/.cache', () => {
    expect(defaultXrayCacheDir({ XDG_CACHE_HOME: '/xdg' })).toBe(path.join('/xdg', 'simply-atlassian', 'xray'));
    expect(defaultXrayCacheDir({ HOME: '/home/me' })).toBe(path.join('/home/me', '.cache', 'simply-atlassian', 'xray'));
  });

  it('refreshes on request', async () => {
    routeXrayDiscovery(server);

    await backend().instance();
    await backend().instance({ refresh: true });

    expect(requestsTo('/rest/api/2/field')).toBe(2);
  });

  it('refuses a corrupt record rather than overwriting hand-edited overrides', () => {
    writeFileSync(xrayRecordPath(cacheDir, server.baseUrl), '{ not json');

    expect(() => loadXrayRecord(xrayRecordPath(cacheDir, server.baseUrl))).toThrow(/not valid JSON/);
  });

  // A file the CLI cannot write must not stop a read.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still answers, with one warning, when the cache directory is not writable',
    async () => {
      routeXrayDiscovery(server);
      const readOnly = path.join(cacheDir, 'ro');
      chmodSync(cacheDir, 0o500);
      try {
        const instance = await backend(readOnly).instance();

        expect(instance.record.fields.steps).toBe(XRAY_FIXTURE_IDS.steps);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('using it for this run only');
      } finally {
        chmodSync(cacheDir, 0o700);
      }
    },
  );
});

describe('ambiguous roles and overrides', () => {
  const orphaned = [
    ...XRAY_FIXTURE_FIELDS,
    {
      id: 'customfield_99999',
      name: 'Schritte (alt)',
      custom: true,
      schema: { type: 'any', custom: 'com.xpandit.plugins.xray:manual-test-steps-custom-field' },
    },
  ];

  it('does not guess between two fields with one schema type, and names both ids and the record', async () => {
    routeXrayDiscovery(server, { fields: orphaned });

    const instance = await backend().instance();
    const error = (() => {
      try {
        instance.requireField('steps');
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).toContain(XRAY_FIXTURE_IDS.steps);
    expect(error?.message).toContain('customfield_99999');
    expect(error?.message).toContain(instance.path);
    expect(error?.message).toContain('"overrides"');
  });

  it('resolves through an override, which survives a refresh', async () => {
    routeXrayDiscovery(server, { fields: orphaned });
    const first = await backend().instance();
    const record = JSON.parse(readFileSync(first.path, 'utf8')) as Record<string, unknown>;
    record.overrides = { fields: { steps: 'customfield_99999' }, issueTypes: {} };
    writeFileSync(first.path, JSON.stringify(record));

    const refreshed = await backend().instance({ refresh: true });

    expect(refreshed.requireField('steps')).toBe('customfield_99999');
    expect(JSON.parse(readFileSync(first.path, 'utf8'))).toMatchObject({
      overrides: { fields: { steps: 'customfield_99999' } },
    });
  });
});

describe('rediscovery on a stale record', () => {
  const staleJql = (): string => `project = "OM" AND ${'cf[1]'} = 1`;

  it('rediscovers once and retries when Jira rejects a recorded field id', async () => {
    routeXrayDiscovery(server);
    let calls = 0;
    server.route('/rest/api/2/search', (_req, res) => {
      calls += 1;
      if (calls === 1) {
        respondJson(res, 400, { errorMessages: [`Field '${XRAY_FIXTURE_IDS.steps}' does not exist.`] });
        return;
      }
      respondJson(res, 200, { issues: [{ key: 'OM-1' }], total: 1, startAt: 0, maxResults: 100 });
    });

    const result = await backend().search(() => ({ jql: staleJql(), fields: [] }), { limit: 10 });

    expect(result.issues).toEqual([{ key: 'OM-1' }]);
    expect(requestsTo('/rest/api/2/field')).toBe(2);
  });

  it('surfaces a second failure as a normal error', async () => {
    routeXrayDiscovery(server);
    server.route('/rest/api/2/search', (_req, res) =>
      respondJson(res, 400, { errorMessages: [`Field '${XRAY_FIXTURE_IDS.steps}' does not exist.`] }),
    );

    await expect(backend().search(() => ({ jql: staleJql(), fields: [] }), { limit: 10 })).rejects.toThrow(/400/);
    expect(requestsTo('/rest/api/2/field')).toBe(2);
  });

  it('does not rediscover for an error that has nothing to do with the record', async () => {
    routeXrayDiscovery(server);
    server.route('/rest/api/2/search', (_req, res) => respondJson(res, 400, { errorMessages: ['Bad JQL.'] }));

    await expect(backend().search(() => ({ jql: 'x', fields: [] }), { limit: 10 })).rejects.toThrow(/Bad JQL/);
    expect(requestsTo('/rest/api/2/field')).toBe(1);
  });
});

describe('Cloud refusal', () => {
  it('refuses a Cloud site before sending anything', () => {
    expect(() =>
      createXrayBackend(
        { url: 'https://x.atlassian.net', deployment: 'cloud', auth: { kind: 'basic', username: 'u', apiToken: 't' } },
        { cacheDir },
      ),
    ).toThrow(/Server\/Data Center only/);
    expect(server.requests).toHaveLength(0);
  });
});

describe('--fields resolution', () => {
  it('resolves roles and Xray display names from the record, with no field-list request', async () => {
    routeXrayDiscovery(server);
    const xray = backend();
    const instance = await xray.instance();

    const resolved = await xray.resolveFields(instance, ['repositoryPath', 'neues xray-feld', 'customfield_93002']);

    expect(resolved).toEqual([
      { name: 'repositoryPath', id: XRAY_FIXTURE_IDS.repositoryPath },
      { name: 'neues xray-feld', id: 'customfield_93099' },
      { name: 'customfield_93002', id: XRAY_FIXTURE_IDS.steps },
    ]);
    expect(requestsTo('/rest/api/2/field')).toBe(1);
  });

  it('resolves any other Jira field by id or name, fetching the field list once', async () => {
    routeXrayDiscovery(server);
    const xray = backend();
    const instance = await xray.instance();

    const resolved = await xray.resolveFields(instance, ['components', 'Story Points']);

    expect(resolved).toEqual([
      { name: 'components', id: 'components' },
      { name: 'Story Points', id: 'customfield_40016' },
    ]);
    expect(requestsTo('/rest/api/2/field')).toBe(2);
  });

  it('refuses names that match nothing, all together and before any search', async () => {
    routeXrayDiscovery(server);
    routeJiraSearch(server, () => []);
    const xray = backend();
    const instance = await xray.instance();

    await expect(xray.resolveFields(instance, ['nope', 'summary', 'nada'])).rejects.toThrow(/"nope", "nada"/);
    expect(requestsTo('/rest/api/2/search')).toBe(0);
  });
});
