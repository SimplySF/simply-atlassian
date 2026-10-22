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

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlassianConfig } from '../src/config.js';
import { CliError, HttpError } from '../src/errors.js';
import {
  describeAttachment,
  formatBytes,
  inlineAttachment,
  planAttachmentDownloads,
  safeAttachmentFilename,
  saveAttachment,
  saveAttachmentToFolder,
  type JiraAttachment,
} from '../src/jira-attachments.js';
import { JiraClient } from '../src/jira-client.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;
let directory: string;

beforeEach(async () => {
  server = await startTestServer();
  directory = mkdtempSync(path.join(tmpdir(), 'attachments-'));
});

afterEach(async () => {
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});

function client(deployment: AtlassianConfig['deployment'], url = server.baseUrl): JiraClient {
  return new JiraClient({
    url,
    deployment,
    auth:
      deployment === 'cloud'
        ? { kind: 'basic', username: 'user@example.com', apiToken: 'token' }
        : { kind: 'bearer', personalToken: 'pat' },
  });
}

function attachment(id: string, filename: string, extra: Partial<JiraAttachment> = {}): JiraAttachment {
  return { id, filename, ...extra };
}

/** Serves `content` for a Cloud attachment id. */
function serveCloud(id: string, content: string | Buffer, type = 'application/octet-stream'): void {
  server.route(`/rest/api/3/attachment/content/${id}`, (_req, res) => {
    res.writeHead(200, { 'content-type': type });
    res.end(content);
  });
}

describe('JiraClient attachments', () => {
  it('lists attachments from the issue attachment field alone', async () => {
    server.route('/rest/api/3/issue/PROJ-1', (_req, res) => {
      respondJson(res, 200, { fields: { attachment: [{ id: '1', filename: 'a.txt' }] } });
    });

    const list = await client('cloud').getAttachments('PROJ-1');

    expect(list).toEqual([{ id: '1', filename: 'a.txt' }]);
    expect(server.requests[0]?.url).toBe('/rest/api/3/issue/PROJ-1?fields=attachment');
  });

  it('returns an empty list when the issue has no attachment field', async () => {
    server.route('/rest/api/2/issue/PROJ-1', (_req, res) => respondJson(res, 200, { fields: {} }));
    expect(await client('server').getAttachments('PROJ-1')).toEqual([]);
  });

  it('asks Cloud for content without a redirect', async () => {
    serveCloud('10', 'bytes');
    const response = await client('cloud').openAttachment(attachment('10', 'a.txt'));
    for await (const chunk of response.body) expect(Buffer.from(chunk).toString()).toBe('bytes');
    expect(server.requests[0]?.url).toBe('/rest/api/3/attachment/content/10?redirect=false');
  });

  it('asks Server/DC for the web path with the filename encoded', async () => {
    server.route('/secure/attachment/10/my%20log%23.txt', (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const response = await client('server').openAttachment(attachment('10', 'my log#.txt'));
    for await (const chunk of response.body) expect(Buffer.from(chunk).toString()).toBe('ok');
  });

  it('builds browser links on the configured base URL, never with redirect=false', () => {
    expect(client('cloud', 'https://site.atlassian.net').attachmentBrowserUrl(attachment('10', 'a.txt'))).toBe(
      'https://site.atlassian.net/rest/api/3/attachment/content/10',
    );
    expect(client('server', 'https://jira.example.test/jira/').attachmentBrowserUrl(attachment('10', 'a b.txt'))).toBe(
      'https://jira.example.test/jira/secure/attachment/10/a%20b.txt',
    );
  });
});

describe('describeAttachment', () => {
  it('normalizes the author across deployments', () => {
    expect(describeAttachment({ id: '1', filename: 'a', author: { accountId: 'abc' } }).author).toBe('abc');
    expect(describeAttachment({ id: 2, filename: 'a', author: { name: 'ada', displayName: 'Ada' } })).toEqual({
      id: '2',
      filename: 'a',
      author: 'Ada',
      size: undefined,
      mimeType: undefined,
      created: undefined,
    });
  });
});

describe('formatBytes', () => {
  it('uses binary units to one decimal place', () => {
    expect(formatBytes(undefined)).toBeUndefined();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(84 * 1024)).toBe('84 KiB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MiB');
  });
});

describe('safeAttachmentFilename', () => {
  it.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['..\\windows\\system.ini', '_windows_system.ini'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['line\nbreak\u0007.txt', 'line_break_.txt'],
    ['name. ', 'name'],
    ['...', 'attachment-7'],
    ['', 'attachment-7'],
    ['CON.txt', '_CON.txt'],
    ['nul', '_nul'],
    ['.env', 'env'],
    ['report.pdf', 'report.pdf'],
  ])('%j becomes %j', (input, expected) => {
    expect(safeAttachmentFilename(input, '7')).toBe(expected);
  });

  it('shortens a long name but keeps its extension', () => {
    const safe = safeAttachmentFilename(`${'a'.repeat(300)}.log`, '7');
    expect(safe.length).toBe(180);
    expect(safe.endsWith('.log')).toBe(true);
  });
});

describe('planAttachmentDownloads', () => {
  const list = [attachment('1', 'log.txt'), attachment('2', 'LOG.txt'), attachment('3', 'shot.png')];

  it('selects everything by default, and tells duplicate names apart by id', () => {
    const plan = planAttachmentDownloads(list, { issueKey: 'PROJ-1', directory });
    expect(plan.map((download) => path.basename(download.path))).toEqual(['log (1).txt', 'LOG (2).txt', 'shot.png']);
  });

  it('keeps list order for a selection', () => {
    const plan = planAttachmentDownloads(list, { issueKey: 'PROJ-1', ids: ['3', '1'], directory });
    expect(plan.map((download) => download.attachment.id)).toEqual(['1', '3']);
    expect(path.basename(plan[0]?.path ?? '')).toBe('log.txt');
  });

  it('names an unknown id instead of skipping it', () => {
    expect(() => planAttachmentDownloads(list, { issueKey: 'PROJ-1', ids: ['1', '9'], directory })).toThrow(
      'No attachment 9 on PROJ-1.',
    );
  });

  it('lists every existing file before anything is downloaded', () => {
    writeFileSync(path.join(directory, 'shot.png'), '');
    writeFileSync(path.join(directory, 'log (1).txt'), '');
    const error = (() => {
      try {
        planAttachmentDownloads(list, { issueKey: 'PROJ-1', directory });
        return undefined;
      } catch (caught) {
        return caught as CliError;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error?.message).toContain('shot.png');
    expect(error?.message).toContain('log (1).txt');
    expect(() => planAttachmentDownloads(list, { issueKey: 'PROJ-1', directory, overwrite: true })).not.toThrow();
  });

  it('always resolves directly inside the directory', () => {
    const plan = planAttachmentDownloads([attachment('1', '../../escape'), attachment('2', '/abs/path')], {
      issueKey: 'PROJ-1',
      directory,
    });
    for (const download of plan) expect(path.dirname(download.path)).toBe(path.resolve(directory));
  });
});

describe('saveAttachment', () => {
  it('writes the file and leaves no temporary file behind', async () => {
    serveCloud('1', 'hello');
    const file = path.join(directory, 'a.txt');

    expect(await saveAttachment(client('cloud'), attachment('1', 'a.txt', { size: 5 }), file)).toBe(5);
    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(readdirSync(directory)).toEqual(['a.txt']);
  });

  it('restarts a body that drops part-way', async () => {
    let calls = 0;
    server.route('/rest/api/3/attachment/content/1', (_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-length': '5' });
      if (calls === 1) {
        res.write('he');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end('hello');
    });
    const file = path.join(directory, 'a.txt');

    await saveAttachment(client('cloud'), attachment('1', 'a.txt', { size: 5 }), file);

    expect(calls).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(readdirSync(directory)).toEqual(['a.txt']);
  });

  it('gives up after three failed bodies and leaves nothing', async () => {
    server.route('/rest/api/3/attachment/content/1', (_req, res) => {
      res.writeHead(200);
      res.write('partial');
    });

    await expect(
      saveAttachment(client('cloud'), attachment('1', 'a.txt'), path.join(directory, 'a.txt'), { idleTimeoutMs: 50 }),
    ).rejects.toThrow('sent no data');
    expect(server.requests).toHaveLength(3);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('refuses a byte count that disagrees with the listing', async () => {
    serveCloud('1', 'short');
    await expect(
      saveAttachment(client('cloud'), attachment('1', 'a.txt', { size: 99 }), path.join(directory, 'a.txt')),
    ).rejects.toThrow('arrived as 5 bytes, but Jira lists it as 99');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not retry an HTTP error', async () => {
    server.route('/rest/api/3/attachment/content/1', (_req, res) => respondJson(res, 404, {}));
    await expect(
      saveAttachment(client('cloud'), attachment('1', 'a.txt'), path.join(directory, 'a.txt')),
    ).rejects.toBeInstanceOf(HttpError);
    expect(server.requests).toHaveLength(1);
  });
});

describe('saveAttachmentToFolder', () => {
  it('saves under the sanitized name, then by id, and never overwrites', async () => {
    serveCloud('1', 'new');
    const item = attachment('1', 'a.txt', { size: 3 });

    const first = await saveAttachmentToFolder(client('cloud'), item, directory);
    const second = await saveAttachmentToFolder(client('cloud'), item, directory);
    const third = await saveAttachmentToFolder(client('cloud'), item, directory);

    expect(first).toEqual({ saved: true, path: path.join(directory, 'a.txt'), size: 3 });
    expect(second).toEqual({ saved: true, path: path.join(directory, 'a (1).txt'), size: 3 });
    expect(third.saved).toBe(false);
  });

  it('refuses a relative path or a missing folder without a request', async () => {
    expect(await saveAttachmentToFolder(client('cloud'), attachment('1', 'a'), 'relative/dir')).toMatchObject({
      saved: false,
      reason: expect.stringContaining('not an absolute path') as unknown,
    });
    expect(
      await saveAttachmentToFolder(client('cloud'), attachment('1', 'a'), path.join(directory, 'missing')),
    ).toMatchObject({ saved: false, reason: expect.stringContaining('not an existing folder') as unknown });
    expect(server.requests).toHaveLength(0);
  });
});

describe('inlineAttachment', () => {
  it('returns UTF-8 text', async () => {
    serveCloud('1', 'line one\nline two');
    expect(
      await inlineAttachment(client('cloud'), attachment('1', 'a.log', { mimeType: 'text/plain; charset=UTF-8' })),
    ).toEqual({
      kind: 'text',
      text: 'line one\nline two',
    });
  });

  it('returns an image as base64 with its type', async () => {
    serveCloud('1', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await inlineAttachment(client('cloud'), attachment('1', 'a.png', { mimeType: 'image/png' }))).toEqual({
      kind: 'image',
      data: 'iVBORw==',
      mimeType: 'image/png',
    });
  });

  it('refuses text that is not UTF-8', async () => {
    serveCloud('1', Buffer.from([0xff, 0xfe, 0x00]));
    const result = await inlineAttachment(client('cloud'), attachment('1', 'a.txt', { mimeType: 'text/plain' }));
    expect(result).toMatchObject({ kind: 'none', reason: expect.stringContaining('not valid UTF-8') as unknown });
  });

  it('refuses an unsupported type or a listed oversize without a request', async () => {
    expect(
      (await inlineAttachment(client('cloud'), attachment('1', 'a.pdf', { mimeType: 'application/pdf' }))).kind,
    ).toBe('none');
    expect(
      (await inlineAttachment(client('cloud'), attachment('1', 'a.txt', { mimeType: 'text/plain', size: 2_000_000 })))
        .kind,
    ).toBe('none');
    expect(server.requests).toHaveLength(0);
  });

  it('stops reading a body that runs past the cap even when the listing understated it', async () => {
    serveCloud('1', Buffer.alloc(1024 * 1024 + 10, 'a'));
    const result = await inlineAttachment(
      client('cloud'),
      attachment('1', 'a.txt', { mimeType: 'text/plain', size: 10 }),
    );
    expect(result).toMatchObject({ kind: 'none', reason: expect.stringContaining('larger than 1 MiB') as unknown });
  });
});
