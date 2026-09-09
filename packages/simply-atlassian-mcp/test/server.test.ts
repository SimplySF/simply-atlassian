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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { EnvLike } from '@simplysf/simply-atlassian-core';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, mapError, SERVER_NAME, SERVER_VERSION, type ServerOptions } from '../src/index.js';
import { TOOLS } from '../src/tools.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

/** A token long enough to be treated as a secret, and distinctive enough to spot in output. */
const TOKEN = 'pat-sup3r-s3cret-t0ken';

type TextResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const textOf = (result: unknown): string => {
  const first = (result as TextResult).content[0];
  if (first?.type !== 'text' || first.text === undefined) throw new Error('expected a text content block');
  return first.text;
};
const jsonOf = (result: unknown): unknown => JSON.parse(textOf(result)) as unknown;

let atlassian: TestServer;
let client: Client | undefined;
let closeServer: (() => Promise<void>) | undefined;

/** Connection settings pointing both products at the fake instance, as a host would set them. */
function env(extra: EnvLike = {}): EnvLike {
  return {
    JIRA_URL: atlassian.baseUrl,
    JIRA_PERSONAL_TOKEN: TOKEN,
    CONFLUENCE_URL: atlassian.baseUrl,
    CONFLUENCE_PERSONAL_TOKEN: TOKEN,
    ...extra,
  };
}

async function connect(options: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeServer = () => server.close();
  return client;
}

beforeEach(async () => {
  atlassian = await startTestServer();
});

afterEach(async () => {
  await client?.close();
  await closeServer?.();
  client = undefined;
  closeServer = undefined;
  await atlassian.close();
});

describe('createServer', () => {
  it('announces the package name and version during the initialize handshake', async () => {
    const c = await connect({ env: env() });
    expect(c.getServerVersion()).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(SERVER_VERSION).toBe(packageVersion);
  });

  it('registers only read tools by default', async () => {
    const c = await connect({ env: env() });
    const { tools } = await c.listTools();
    const expected = TOOLS.filter((tool) => tool.kind === 'read').map((tool) => tool.name);
    expect(tools.map((tool) => tool.name).sort()).toEqual(expected.sort());
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('registers every tool with --allow-writes, with destructive ones annotated', async () => {
    const c = await connect({ allowWrites: true, env: env() });
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());

    const del = tools.find((tool) => tool.name === 'jira_issue_delete');
    expect(del?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const create = tools.find((tool) => tool.name === 'jira_issue_create');
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('exposes each tool input schema with the described properties', async () => {
    const c = await connect({ env: env() });
    const { tools } = await c.listTools();
    const search = tools.find((tool) => tool.name === 'jira_issue_search');
    const schema = search?.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['fields', 'jql', 'limit']);
    expect(schema.required).toEqual(['jql']);
  });
});

describe('read tools', () => {
  it('call the instance in-process and return the raw payload as JSON text', async () => {
    atlassian.route('/rest/api/2/myself', (req, res) => {
      respondJson(res, 200, { name: 'ada', displayName: 'Ada', authorization: req.headers.authorization });
    });
    const c = await connect({ env: env() });

    const result = await c.callTool({ name: 'jira_whoami', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toEqual({ name: 'ada', displayName: 'Ada', authorization: `Bearer ${TOKEN}` });
  });

  it('pass typed inputs through to the request the CLI would make', async () => {
    let seen: URL | undefined;
    atlassian.route('/rest/api/2/search', (req, res) => {
      seen = new URL(req.url ?? '/', 'http://127.0.0.1');
      respondJson(res, 200, { issues: [{ key: 'P-1' }], total: 1 });
    });
    const c = await connect({ env: env() });

    const result = await c.callTool({
      name: 'jira_issue_search',
      arguments: { jql: 'project = P', limit: 10, fields: ['summary', 'status'] },
    });

    expect(seen?.searchParams.get('jql')).toBe('project = P');
    expect(seen?.searchParams.get('fields')).toBe('summary,status');
    expect(jsonOf(result)).toMatchObject({ issues: [{ key: 'P-1' }], complete: true });
  });

  it('answer the open tools with a URL and open nothing', async () => {
    const c = await connect({ env: env() });
    const result = await c.callTool({ name: 'jira_open', arguments: { target: 'P-7' } });
    expect(jsonOf(result)).toEqual({ url: `${atlassian.baseUrl}/browse/P-7` });
    expect(atlassian.requests).toHaveLength(0);
  });

  it('load connection settings from --env-file, with the environment winning', async () => {
    atlassian.route('/rest/api/2/myself', (_req, res) => respondJson(res, 200, { name: 'ada' }));
    const path = join(mkdtempSync(join(tmpdir(), 'simply-mcp-')), '.env');
    writeFileSync(path, `JIRA_URL=${atlassian.baseUrl}\nJIRA_PERSONAL_TOKEN=${TOKEN}\n`, 'utf8');
    const c = await connect({ envFile: path, env: {} });

    const result = await c.callTool({ name: 'jira_whoami', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toEqual({ name: 'ada' });
  });

  it('report a missing setting as a config error from the tool that needed it', async () => {
    const c = await connect({ env: {} });
    const result = await c.callTool({ name: 'jira_whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect(jsonOf(result)).toMatchObject({ code: 'config', name: 'ConfigError', exitCode: 2 });
    expect(textOf(result)).toContain('JIRA_URL');
  });
});

describe('write tools', () => {
  it('return the assembled request on dryRun without sending anything', async () => {
    const c = await connect({ allowWrites: true, env: env() });

    const result = await c.callTool({
      name: 'jira_issue_create',
      arguments: { project: 'P', type: 'Task', summary: 'x', labels: ['a'], dryRun: true },
    });

    expect(jsonOf(result)).toEqual({
      fields: { project: { key: 'P' }, issuetype: { name: 'Task' }, summary: 'x', labels: ['a'] },
    });
    expect(atlassian.requests).toHaveLength(0);
  });

  it('send the request and return what the instance answered', async () => {
    let sent: unknown;
    atlassian.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-9', id: '9' });
    });
    const c = await connect({ allowWrites: true, env: env() });

    const result = await c.callTool({ name: 'jira_issue_create', arguments: { project: 'P', summary: 'x' } });

    expect(sent).toEqual({ fields: { project: { key: 'P' }, summary: 'x' } });
    expect(jsonOf(result)).toEqual({ key: 'P-9', id: '9' });
  });

  it('refuse an empty request the way the CLI does, as a config error', async () => {
    const c = await connect({ allowWrites: true, env: env() });
    const result = await c.callTool({ name: 'jira_issue_create', arguments: {} });
    expect(jsonOf(result)).toMatchObject({ code: 'config', message: expect.stringContaining('Nothing to create') });
  });

  it('are refused by ATLASSIAN_READ_ONLY even when the server allows writes', async () => {
    const c = await connect({ allowWrites: true, env: env({ ATLASSIAN_READ_ONLY: 'true' }) });

    const result = await c.callTool({ name: 'jira_issue_create', arguments: { project: 'P', summary: 'x' } });

    expect(result.isError).toBe(true);
    expect(jsonOf(result)).toMatchObject({ code: 'config', message: expect.stringContaining('ATLASSIAN_READ_ONLY') });
    expect(atlassian.requests).toHaveLength(0);
  });
});

describe('the confirm gate', () => {
  it('refuses a destructive call without confirm before touching the instance', async () => {
    const c = await connect({ allowWrites: true, env: env() });

    const result = await c.callTool({ name: 'jira_issue_delete', arguments: { issue: 'P-1' } });

    expect(result.isError).toBe(true);
    expect(jsonOf(result)).toMatchObject({ code: 'confirm-required' });
    expect(atlassian.requests).toHaveLength(0);
  });

  it('proceeds with confirm: true', async () => {
    let method: string | undefined;
    atlassian.route('/rest/api/2/issue/P-1', (req, res) => {
      method = req.method;
      res.writeHead(204);
      res.end();
    });
    const c = await connect({ allowWrites: true, env: env() });

    const result = await c.callTool({ name: 'jira_issue_delete', arguments: { issue: 'P-1', confirm: true } });

    expect(method).toBe('DELETE');
    expect(jsonOf(result)).toEqual({ issue: 'P-1', deleted: true });
  });

  it('lets a destructive dry run through without confirm', async () => {
    const c = await connect({ allowWrites: true, env: env() });

    const result = await c.callTool({
      name: 'jira_issue_comment_delete',
      arguments: { issue: 'P-1', comment: '9', dryRun: true },
    });

    expect(jsonOf(result)).toEqual({ issue: 'P-1', comment: '9', dryRun: true });
    expect(atlassian.requests).toHaveLength(0);
  });

  it('does not demand confirm to trash a page, only to purge it, matching the CLI', async () => {
    atlassian.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') respondJson(res, 200, { id: '123', title: 'Plan', status: 'current' });
      else {
        res.writeHead(204);
        res.end();
      }
    });
    const c = await connect({ allowWrites: true, env: env() });

    const trashed = await c.callTool({ name: 'confluence_page_delete', arguments: { page: '123' } });
    expect(jsonOf(trashed)).toEqual({ pageId: '123', title: '"Plan"', purge: false, deleted: true });

    const refused = await c.callTool({ name: 'confluence_page_delete', arguments: { page: '123', purge: true } });
    expect(jsonOf(refused)).toMatchObject({ code: 'confirm-required' });
  });
});

describe('error mapping', () => {
  it('maps an auth failure onto code auth with the status', async () => {
    atlassian.route('/rest/api/2/myself', (_req, res) => respondJson(res, 401, { message: 'nope' }));
    const c = await connect({ env: env() });

    const result = await c.callTool({ name: 'jira_whoami', arguments: {} });

    expect(result.isError).toBe(true);
    expect(jsonOf(result)).toMatchObject({ code: 'auth', name: 'AuthError', exitCode: 3, status: 401 });
  });

  it('carries an API error body, redacted and control-stripped', async () => {
    atlassian.route('/rest/api/2/issue/P-1', (_req, res) => {
      respondJson(res, 400, { errorMessages: [`bad token ${TOKEN}[31m`] });
    });
    const c = await connect({ env: env() });

    const result = await c.callTool({ name: 'jira_issue_view', arguments: { issue: 'P-1' } });

    const error = jsonOf(result) as {
      code: string;
      status: number;
      body: { errorMessages: string[] };
      message: string;
    };
    expect(error).toMatchObject({ code: 'error', name: 'HttpError', status: 400 });
    expect(error.body.errorMessages[0]).toBe('bad token <redacted>[31m');
    expect(textOf(result)).not.toContain(TOKEN);
  });

  it('rejects input that fails the schema before anything runs', async () => {
    const c = await connect({ env: env() });
    const result = await c.callTool({ name: 'jira_issue_search', arguments: { limit: 'ten' } });
    expect(result.isError).toBe(true);
    expect(atlassian.requests).toHaveLength(0);
  });
});

describe('mapError', () => {
  it('describes an unexpected error as a plain error with exit code 1', () => {
    expect(mapError(new TypeError('boom'), { env: {} })).toEqual({
      code: 'error',
      name: 'Error',
      message: 'boom',
      exitCode: 1,
    });
  });

  it('redacts credentials from the environment out of any message', () => {
    const mapped = mapError(new Error(`token ${TOKEN} leaked`), { env: { JIRA_API_TOKEN: TOKEN } });
    expect(mapped.message).toBe('token <redacted> leaked');
  });
});
