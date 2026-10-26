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
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError, HttpError } from '@simplysf/simply-atlassian-core';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import JiraIssueAttachmentDownload from '../../../../../src/commands/atlassian/jira/issue/attachment/download.js';
import JiraIssueAttachmentList from '../../../../../src/commands/atlassian/jira/issue/attachment/list.js';

let server: TestServer;
let directory: string;

beforeEach(async () => {
  server = await startTestServer();
  directory = mkdtempSync(path.join(tmpdir(), 'attachment-cli-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});

const config = { runHook: async () => ({ successes: [], failures: [] }) } as never;

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

/** Serves PROJ-1's attachment list and each file's bytes on the Server/DC paths. */
function serveIssue(files: Array<{ id: string; filename: string; content: string; mimeType?: string }>): void {
  server.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
    respondJson(res, 200, {
      fields: {
        attachment: files.map((file) => ({
          id: file.id,
          filename: file.filename,
          size: Buffer.byteLength(file.content),
          mimeType: file.mimeType ?? 'text/plain',
          author: { name: 'ada', displayName: 'Ada\u001b[31m' },
          created: '2026-10-18T09:00:00.000+0000',
        })),
      },
    });
  });
  for (const file of files) {
    server.route(`/secure/attachment/${file.id}/${encodeURIComponent(file.filename)}`, (_req, res) => {
      res.writeHead(200);
      res.end(file.content);
    });
  }
}

async function run<C extends JiraIssueAttachmentList | JiraIssueAttachmentDownload>(
  command: C,
): Promise<{ output: string; result: unknown }> {
  const logged: string[] = [];
  command.log = (message?: string): void => {
    logged.push(String(message));
  };
  await command.init();
  const result = await command.run();
  return { output: logged.join('\n'), result };
}

/** A download command whose --stdout lands in a buffer, and which can pretend to be a terminal. */
function capturing(args: string[], tty = false): { command: JiraIssueAttachmentDownload; bytes: () => string } {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  Object.assign(sink, { isTTY: tty });
  class Captured extends JiraIssueAttachmentDownload {
    protected override output = sink as unknown as NodeJS.WriteStream;
  }
  return { command: new Captured(argv(...args), config), bytes: () => Buffer.concat(chunks).toString('utf8') };
}

describe('jira issue attachment list', () => {
  it('renders a table with sizes and dates, stripping control characters', async () => {
    serveIssue([
      { id: '10', filename: 'server.log', content: 'x'.repeat(2048) },
      { id: '11', filename: 'shot\u0007.png', content: 'png', mimeType: 'image/png' },
    ]);

    const { output } = await run(new JiraIssueAttachmentList(argv('PROJ-1'), config));

    expect(output).toMatch(/10\s+server\.log\s+2 KiB\s+text\/plain\s+Ada\S*\s+2026-10-18/);
    expect(output).toContain('2 attachment(s).');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });

  it('says so when there are none', async () => {
    serveIssue([]);
    const { output, result } = await run(new JiraIssueAttachmentList(argv('PROJ-1'), config));
    expect(output).toBe('No attachments on PROJ-1.');
    expect(result).toEqual([]);
  });

  it('returns the raw attachment array under --json', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'hi' }]);
    const { result } = await run(new JiraIssueAttachmentList(argv('PROJ-1', '--json'), config));
    expect(result).toEqual([expect.objectContaining({ id: '10', filename: 'a.txt', size: 2 })]);
  });
});

describe('jira issue attachment download', () => {
  it('downloads every attachment, telling duplicate names apart', async () => {
    serveIssue([
      { id: '10', filename: 'log.txt', content: 'first' },
      { id: '11', filename: 'log.txt', content: 'second' },
    ]);

    const { output, result } = await run(
      new JiraIssueAttachmentDownload(argv('PROJ-1', '--output-dir', directory), config),
    );

    expect(readFileSync(path.join(directory, 'log (10).txt'), 'utf8')).toBe('first');
    expect(readFileSync(path.join(directory, 'log (11).txt'), 'utf8')).toBe('second');
    expect(output).toBe(`Downloaded 2 attachment(s) to ${directory}.`);
    expect(result).toEqual({
      directory,
      files: [
        { id: '10', filename: 'log.txt', path: path.join(directory, 'log (10).txt'), size: 5, mimeType: 'text/plain' },
        { id: '11', filename: 'log.txt', path: path.join(directory, 'log (11).txt'), size: 6, mimeType: 'text/plain' },
      ],
    });
  });

  it('downloads only the ids named, and creates the directory', async () => {
    serveIssue([
      { id: '10', filename: 'a.txt', content: 'a' },
      { id: '11', filename: 'b.txt', content: 'b' },
    ]);
    const target = path.join(directory, 'nested', 'out');

    await run(new JiraIssueAttachmentDownload(argv('PROJ-1', '--id', '11', '--output-dir', target), config));

    expect(readdirSync(target)).toEqual(['b.txt']);
  });

  it('refuses an unknown id before downloading anything', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'a' }]);
    await expect(
      run(new JiraIssueAttachmentDownload(argv('PROJ-1', '--id', '10,99', '--output-dir', directory), config)),
    ).rejects.toThrow('No attachment 99 on PROJ-1.');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('refuses existing files unless --overwrite is passed', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'new' }]);
    writeFileSync(path.join(directory, 'a.txt'), 'old');

    await expect(
      run(new JiraIssueAttachmentDownload(argv('PROJ-1', '--output-dir', directory), config)),
    ).rejects.toThrow('--overwrite');
    expect(readFileSync(path.join(directory, 'a.txt'), 'utf8')).toBe('old');

    await run(new JiraIssueAttachmentDownload(argv('PROJ-1', '--output-dir', directory, '--overwrite'), config));
    expect(readFileSync(path.join(directory, 'a.txt'), 'utf8')).toBe('new');
  });

  it('says how many files were written when one fails part-way', async () => {
    serveIssue([
      { id: '10', filename: 'a.txt', content: 'a' },
      { id: '11', filename: 'b.txt', content: 'b' },
    ]);
    server.route('/secure/attachment/11/b.txt', (_req, res) => respondJson(res, 404, {}));

    const error = await run(new JiraIssueAttachmentDownload(argv('PROJ-1', '--output-dir', directory), config)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(HttpError);
    expect((error as Error).message).toContain('1 of 2 attachment(s) were written before this failure.');
    expect(readdirSync(directory)).toEqual(['a.txt']);
  });

  it('streams one attachment to stdout', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'raw\u001b[2Jbytes' }]);
    const { command, bytes } = capturing(['PROJ-1', '--id', '10', '--stdout']);

    await run(command);

    expect(bytes()).toBe('raw\u001b[2Jbytes');
  });

  it.each([
    ['none', [] as string[], 'and 0 are selected'],
    ['several', ['--id', '10,11'], 'and 2 are selected'],
  ])('refuses --stdout with %s selected', async (_label, ids, message) => {
    serveIssue(
      _label === 'none'
        ? []
        : [
            { id: '10', filename: 'a.txt', content: 'a' },
            { id: '11', filename: 'b.txt', content: 'b' },
          ],
    );
    const error = await run(capturing(['PROJ-1', ...ids, '--stdout']).command).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect((error as CliError).message).toContain(message);
  });

  it('refuses --stdout to a terminal', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'a' }]);
    await expect(run(capturing(['PROJ-1', '--stdout'], true).command)).rejects.toThrow(
      'refuses to write to a terminal',
    );
    expect(server.requests.some((request) => request.url.startsWith('/secure/'))).toBe(false);
  });

  it('refuses --stdout with --json', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'a' }]);
    await expect(run(capturing(['PROJ-1', '--stdout', '--json']).command)).rejects.toThrow('cannot be combined');
  });

  it('says the stdout output is incomplete when the body fails', async () => {
    serveIssue([{ id: '10', filename: 'a.txt', content: 'abcdef' }]);
    server.route('/secure/attachment/10/a.txt', (_req, res) => {
      res.writeHead(200, { 'content-length': '6' });
      res.write('abc');
      setTimeout(() => res.destroy(), 20);
    });

    const { command, bytes } = capturing(['PROJ-1', '--stdout']);
    await expect(run(command)).rejects.toThrow('stopped after 3 bytes; the output is incomplete');
    expect(bytes()).toBe('abc');
  });
});
