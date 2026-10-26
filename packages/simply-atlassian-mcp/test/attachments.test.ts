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

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Block[] };

let atlassian: TestServer;
let folder: string;
let client: Client | undefined;
let closeServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  atlassian = await startTestServer();
  folder = mkdtempSync(join(tmpdir(), 'mcp-attachments-'));
});

afterEach(async () => {
  await client?.close();
  await closeServer?.();
  client = undefined;
  closeServer = undefined;
  await atlassian.close();
  rmSync(folder, { recursive: true, force: true });
});

/** Connects a client; with `answer`, it declares form elicitation and answers each prompt with it. */
async function connect(answer?: (message: string) => ElicitResult): Promise<{ prompts: string[] }> {
  const prompts: string[] = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ env: { JIRA_URL: atlassian.baseUrl, JIRA_PERSONAL_TOKEN: 'pat-attachments-token' } });
  client = new Client(
    { name: 'test-client', version: '0.0.0' },
    answer === undefined ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  if (answer !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      const message = request.params.message;
      prompts.push(message);
      return answer(message);
    });
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeServer = () => server.close();
  return { prompts };
}

/** PROJ-1 with the given attachments, served on the Server/DC paths. */
function serve(files: Array<{ id: string; filename: string; mimeType: string; content: Buffer | string }>): void {
  atlassian.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
    respondJson(res, 200, {
      fields: {
        attachment: files.map((file) => ({
          id: file.id,
          filename: file.filename,
          mimeType: file.mimeType,
          size: Buffer.byteLength(file.content),
        })),
      },
    });
  });
  for (const file of files) {
    atlassian.route(`/secure/attachment/${file.id}/${encodeURIComponent(file.filename)}`, (_req, res) => {
      res.writeHead(200);
      res.end(file.content);
    });
  }
}

async function download(args: Record<string, unknown>): Promise<{ result: Result; meta: Record<string, unknown> }> {
  const result = (await client?.callTool({ name: 'jira_issue_attachment_download', arguments: args })) as Result;
  const meta = JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown>;
  return { result, meta };
}

const contentRequests = (): number => atlassian.requests.filter((request) => request.url.startsWith('/secure/')).length;

describe('attachment tools', () => {
  it('registers both as read tools, with download marked as able to write', async () => {
    await connect();
    const { tools } = await client!.listTools();
    const list = tools.find((tool) => tool.name === 'jira_issue_attachment_list');
    const get = tools.find((tool) => tool.name === 'jira_issue_attachment_download');
    expect(list?.annotations?.readOnlyHint).toBe(true);
    expect(get?.annotations?.readOnlyHint).toBe(false);
    expect(get?.inputSchema.properties).not.toHaveProperty('directory');
  });

  it('lists the raw attachment objects', async () => {
    serve([{ id: '10', filename: 'a.txt', mimeType: 'text/plain', content: 'hi' }]);
    await connect();
    const result = (await client!.callTool({
      name: 'jira_issue_attachment_list',
      arguments: { issue: 'PROJ-1' },
    })) as Result;
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([
      { id: '10', filename: 'a.txt', mimeType: 'text/plain', size: 2 },
    ]);
  });

  it('returns text inline after its metadata, with a browser link', async () => {
    serve([{ id: '10', filename: 'a.log', mimeType: 'text/plain', content: 'line one' }]);
    await connect();

    const { result, meta } = await download({ issue: 'PROJ-1', id: '10' });

    expect(meta).toMatchObject({ id: '10', returned: true, saved: false });
    expect(meta.browserUrl).toBe(`${atlassian.baseUrl}/secure/attachment/10/a.log`);
    expect(result.content[1]).toEqual({ type: 'text', text: 'line one' });
  });

  it('returns an image block with its type', async () => {
    serve([{ id: '10', filename: 'a.png', mimeType: 'image/png', content: Buffer.from([1, 2, 3]) }]);
    await connect();
    const { result } = await download({ issue: 'PROJ-1', id: '10' });
    expect(result.content[1]).toEqual({ type: 'image', data: 'AQID', mimeType: 'image/png' });
  });

  it('without elicitation, describes an unreadable file and points at the link', async () => {
    serve([{ id: '10', filename: 'a.pdf', mimeType: 'application/pdf', content: 'pdf' }]);
    await connect();

    const { result, meta } = await download({ issue: 'PROJ-1', id: '10' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(meta).toMatchObject({ returned: false, saved: false });
    expect(meta.reason).toContain('application/pdf cannot be returned inline.');
    expect(meta.reason).toContain('cannot ask the user for a folder');
    expect(contentRequests()).toBe(0);
  });

  it('asks for a folder and saves an unreadable file there', async () => {
    serve([{ id: '10', filename: 'report.pdf', mimeType: 'application/pdf', content: 'pdf-bytes' }]);
    const { prompts } = await connect(() => ({ action: 'accept', content: { directory: folder } }));

    const { meta } = await download({ issue: 'PROJ-1', id: '10' });

    expect(prompts).toEqual(['Save "report.pdf" (9 B) from PROJ-1?']);
    expect(meta).toMatchObject({ saved: true, path: join(folder, 'report.pdf') });
    expect(readFileSync(join(folder, 'report.pdf'), 'utf8')).toBe('pdf-bytes');
  });

  it('asks for a folder when save is true, even for a readable file', async () => {
    serve([{ id: '10', filename: 'a.txt', mimeType: 'text/plain', content: 'hi' }]);
    const { prompts } = await connect(() => ({ action: 'accept', content: { directory: folder } }));

    const { result, meta } = await download({ issue: 'PROJ-1', id: '10', save: true });

    expect(prompts).toHaveLength(1);
    expect(result.content).toHaveLength(1);
    expect(meta).toMatchObject({ returned: false, saved: true });
  });

  it.each<[string, ElicitResult, string]>([
    ['declines', { action: 'decline' }, 'The user declined to save the file.'],
    ['cancels', { action: 'cancel' }, 'The user declined to save the file.'],
    ['gives a relative path', { action: 'accept', content: { directory: 'relative' } }, 'not an absolute path'],
    [
      'gives a missing folder',
      { action: 'accept', content: { directory: '/no/such/folder/here' } },
      'not an existing folder',
    ],
  ])('saves nothing, without an error or a second prompt, when the user %s', async (_label, answer, reason) => {
    serve([{ id: '10', filename: 'a.pdf', mimeType: 'application/pdf', content: 'pdf' }]);
    const { prompts } = await connect(() => answer);

    const { result, meta } = await download({ issue: 'PROJ-1', id: '10' });

    expect(result.isError).toBeFalsy();
    expect(prompts).toHaveLength(1);
    expect(meta).toMatchObject({ saved: false });
    expect(meta.reason).toContain(reason);
    expect(meta.browserUrl).toBeDefined();
  });

  it('reuses a remembered folder without asking again, and never overwrites', async () => {
    serve([{ id: '10', filename: 'a.pdf', mimeType: 'application/pdf', content: 'pdf' }]);
    const { prompts } = await connect(() => ({
      action: 'accept',
      content: { directory: folder, rememberForSession: true },
    }));

    await download({ issue: 'PROJ-1', id: '10' });
    const { meta } = await download({ issue: 'PROJ-1', id: '10' });

    expect(prompts).toHaveLength(1);
    expect(meta).toMatchObject({ saved: true, path: join(folder, 'a (10).pdf') });
    expect(readdirSync(folder).sort()).toEqual(['a (10).pdf', 'a.pdf']);
  });

  it('strips control characters from the filename it shows the user', async () => {
    serve([{ id: '10', filename: 'evil\u001b[2J.bin', mimeType: 'application/octet-stream', content: 'x' }]);
    const { prompts } = await connect(() => ({ action: 'decline' }));
    await download({ issue: 'PROJ-1', id: '10' });
    expect(prompts[0]).not.toContain('\u001b');
  });

  it('is an error for an id the issue does not have', async () => {
    serve([{ id: '10', filename: 'a.txt', mimeType: 'text/plain', content: 'hi' }]);
    await connect();
    const result = (await client!.callTool({
      name: 'jira_issue_attachment_download',
      arguments: { issue: 'PROJ-1', id: '99' },
    })) as Result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No attachment 99 on PROJ-1.');
  });
});
