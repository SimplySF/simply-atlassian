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

import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliResult, CliRunner } from '../src/cli.js';
import { createServer, mapCliError, SERVER_NAME, SERVER_VERSION, type ServerOptions } from '../src/index.js';
import { TOOLS } from '../src/tools.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (exitCode: number, error: Record<string, unknown>): CliResult => ({
  exitCode,
  stdout: '',
  stderr: `${JSON.stringify({ error })}\n`,
  timedOut: false,
});

/** A runner that records every argv it was handed and answers with a scripted result. */
function recordingRunner(result: CliResult | Error = ok('{"ok":true}')): CliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((args: readonly string[]) => {
    calls.push([...args]);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }) as CliRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

type TextResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const textOf = (result: unknown): string => {
  const first = (result as TextResult).content[0];
  if (first?.type !== 'text' || first.text === undefined) throw new Error('expected a text content block');
  return first.text;
};

describe('createServer', () => {
  let client: Client | undefined;
  let closeServer: (() => Promise<void>) | undefined;

  async function connect(options: ServerOptions): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(options);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeServer = () => server.close();
    return client;
  }

  afterEach(async () => {
    await client?.close();
    await closeServer?.();
    client = undefined;
    closeServer = undefined;
  });

  it('announces the package name and version during the initialize handshake', async () => {
    const c = await connect({ runCli: recordingRunner() });
    expect(c.getServerVersion()).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(SERVER_VERSION).toBe(packageVersion);
  });

  it('registers only read tools by default', async () => {
    const c = await connect({ runCli: recordingRunner() });
    const { tools } = await c.listTools();
    const expected = TOOLS.filter((tool) => tool.kind === 'read').map((tool) => tool.name);
    expect(tools.map((tool) => tool.name).sort()).toEqual(expected.sort());
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('registers every tool with --allow-writes, with destructive ones annotated', async () => {
    const c = await connect({ allowWrites: true, runCli: recordingRunner() });
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());

    const del = tools.find((tool) => tool.name === 'jira_issue_delete');
    expect(del?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const create = tools.find((tool) => tool.name === 'jira_issue_create');
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('exposes each tool input schema with the described properties', async () => {
    const c = await connect({ runCli: recordingRunner() });
    const { tools } = await c.listTools();
    const search = tools.find((tool) => tool.name === 'jira_issue_search');
    const schema = search?.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['fields', 'jql', 'limit']);
    expect(schema.required).toEqual(['jql']);
  });

  it('invokes the CLI with the command path, mapped args, and --json', async () => {
    const runner = recordingRunner(ok('{"issues":[]}'));
    const c = await connect({ runCli: runner });

    const result = await c.callTool({
      name: 'jira_issue_search',
      arguments: { jql: 'project = P', limit: 10, fields: ['summary'] },
    });

    expect(runner.calls).toEqual([
      [
        'atlassian',
        'jira',
        'issue',
        'search',
        '--jql',
        'project = P',
        '--limit',
        '10',
        '--fields',
        'summary',
        '--json',
      ],
    ]);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('{"issues":[]}');
  });

  it('appends --env-file to every call when configured', async () => {
    const runner = recordingRunner();
    const c = await connect({ envFile: '/home/me/atlassian.env', runCli: runner });

    await c.callTool({ name: 'jira_whoami', arguments: {} });

    expect(runner.calls[0]).toEqual(['atlassian', 'jira', 'whoami', '--json', '--env-file', '/home/me/atlassian.env']);
  });

  it('passes dryRun through as --dry-run on a write tool', async () => {
    const runner = recordingRunner(ok('{"fields":{"summary":"x"}}'));
    const c = await connect({ allowWrites: true, runCli: runner });

    await c.callTool({ name: 'jira_issue_create', arguments: { project: 'P', summary: 'x', dryRun: true } });

    expect(runner.calls[0]).toEqual([
      'atlassian',
      'jira',
      'issue',
      'create',
      '--project',
      'P',
      '--summary',
      'x',
      '--dry-run',
      '--json',
    ]);
  });

  it('refuses a destructive call without confirm before invoking the CLI', async () => {
    const runner = recordingRunner();
    const c = await connect({ allowWrites: true, runCli: runner });

    const result = await c.callTool({ name: 'jira_issue_delete', arguments: { issue: 'P-1' } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ code: 'confirm-required' });
    expect(runner.calls).toEqual([]);
  });

  it('passes --confirm through on a destructive call that carries confirm: true', async () => {
    const runner = recordingRunner(ok('{"issue":"P-1","deleted":true}'));
    const c = await connect({ allowWrites: true, runCli: runner });

    const result = await c.callTool({ name: 'jira_issue_delete', arguments: { issue: 'P-1', confirm: true } });

    expect(runner.calls[0]).toEqual(['atlassian', 'jira', 'issue', 'delete', 'P-1', '--confirm', '--json']);
    expect(result.isError).toBeFalsy();
  });

  it('lets a destructive dry run through without confirm', async () => {
    const runner = recordingRunner(ok('{"dryRun":true}'));
    const c = await connect({ allowWrites: true, runCli: runner });

    await c.callTool({ name: 'jira_issue_comment_delete', arguments: { issue: 'P-1', comment: '9', dryRun: true } });

    expect(runner.calls[0]).toEqual([
      'atlassian',
      'jira',
      'issue',
      'comment',
      'delete',
      'P-1',
      '9',
      '--dry-run',
      '--json',
    ]);
  });

  it('maps a CLI failure onto an isError result with the CLI error and a stable code', async () => {
    const runner = recordingRunner(failed(3, { name: 'AuthError', message: 'rejected', exitCode: 3, status: 401 }));
    const c = await connect({ runCli: runner });

    const result = await c.callTool({ name: 'jira_whoami', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      code: 'auth',
      name: 'AuthError',
      message: 'rejected',
      exitCode: 3,
      status: 401,
    });
  });

  it('reports a timeout and a runner failure as their own codes', async () => {
    const timedOut = await connect({
      runCli: () => Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    });
    const timeoutResult = await timedOut.callTool({ name: 'jira_whoami', arguments: {} });
    expect(JSON.parse(textOf(timeoutResult))).toMatchObject({ code: 'timeout' });
    await timedOut.close();

    const broken = await connect({ runCli: recordingRunner(new Error('spawn ENOENT')) });
    const serverResult = await broken.callTool({ name: 'jira_whoami', arguments: {} });
    expect(JSON.parse(textOf(serverResult))).toMatchObject({
      code: 'server',
      message: expect.stringContaining('ENOENT'),
    });
  });

  it('rejects input that fails the schema before invoking the CLI', async () => {
    const runner = recordingRunner();
    const c = await connect({ runCli: runner });

    const result = await c.callTool({ name: 'jira_issue_search', arguments: { limit: 'ten' } });

    expect(result.isError).toBe(true);
    expect(runner.calls).toEqual([]);
  });
});

describe('mapCliError', () => {
  it('maps exit codes 2 and 3 to config and auth, and anything else to error', () => {
    expect(mapCliError(failed(2, { name: 'ConfigError', message: 'no url', exitCode: 2 })).code).toBe('config');
    expect(mapCliError(failed(3, { name: 'AuthError', message: 'nope', exitCode: 3 })).code).toBe('auth');
    expect(mapCliError(failed(1, { name: 'HttpError', message: '500', exitCode: 1 })).code).toBe('error');
  });

  it('passes non-JSON stderr through as the message', () => {
    const result = mapCliError({ exitCode: 1, stdout: '', stderr: 'node: bad option\n', timedOut: false });
    expect(result).toEqual({ code: 'error', message: 'node: bad option', exitCode: 1 });
  });

  it('describes an empty stderr by exit code', () => {
    expect(mapCliError({ exitCode: 7, stdout: '', stderr: '', timedOut: false }).message).toBe(
      'The CLI exited with code 7.',
    );
  });
});
