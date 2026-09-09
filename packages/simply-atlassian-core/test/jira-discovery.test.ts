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
import { JiraClient } from '../src/jira-client.js';
import { fieldType, listFields } from '../src/jira-discovery.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function jira(): JiraClient {
  return new JiraClient({
    url: server.baseUrl,
    deployment: 'server',
    auth: { kind: 'bearer', personalToken: 'pat' },
  });
}

const FIELDS = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  { id: 'customfield_10016', name: 'Story Points', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array' } },
];

function routeFields(fields: unknown = FIELDS): void {
  server.route('/rest/api/2/field', (_req, res) => respondJson(res, 200, fields));
}

describe('listFields', () => {
  it('returns every field when unfiltered', async () => {
    routeFields();

    expect(await listFields(jira())).toHaveLength(3);
  });

  /*
   * The reason this command exists: `issue create --body` is the escape hatch for anything
   * without a typed flag, and it is unusable without knowing that Story Points is
   * customfield_10016 *on this instance*. A person can read that off an admin screen; an agent
   * cannot.
   */
  it('filters to custom fields, which are the ones nobody can guess', async () => {
    routeFields();

    const custom = await listFields(jira(), { custom: true });

    expect(custom.map((f) => f.id)).toEqual(['customfield_10016', 'customfield_10020']);
  });

  it('matches a name case-insensitively', async () => {
    routeFields();

    expect((await listFields(jira(), { search: 'STORY points' })).map((f) => f.id)).toEqual(['customfield_10016']);
  });

  /*
   * Matching the id answers the other half of the same problem: a caller who has seen
   * customfield_10016 in a payload and wants to know what it is.
   */
  it('matches an id, so a payload can be read backwards', async () => {
    routeFields();

    expect((await listFields(jira(), { search: 'customfield_10020' })).map((f) => f.name)).toEqual(['Sprint']);
  });

  it('combines the two filters', async () => {
    routeFields();

    expect(await listFields(jira(), { custom: true, search: 'summary' })).toEqual([]);
  });

  it('treats an empty search as no search', async () => {
    routeFields();

    expect(await listFields(jira(), { search: '   ' })).toHaveLength(3);
  });

  it('accepts the wrapped shape some instances return', async () => {
    routeFields({ values: FIELDS });

    expect(await listFields(jira())).toHaveLength(3);
  });

  it('is not an error when an instance has no custom fields', async () => {
    routeFields([FIELDS[0]]);

    expect(await listFields(jira(), { custom: true })).toEqual([]);
  });

  it('reads the schema type, which tells a caller what shape --body needs', () => {
    expect(fieldType({ id: 'x', schema: { type: 'array' } })).toBe('array');
    expect(fieldType({ id: 'x' })).toBeUndefined();
  });
});
