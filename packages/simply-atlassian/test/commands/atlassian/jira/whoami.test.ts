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

import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import JiraWhoami from '../../../../src/commands/atlassian/jira/whoami.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

describe('jira whoami', () => {
  it('returns the raw /myself payload', async () => {
    server.route('/rest/api/2/myself', (_req, res) => {
      respondJson(res, 200, { displayName: 'Ada Lovelace', name: 'ada', active: true });
    });

    const user = (await JiraWhoami.run(argv())) as { displayName: string; active: boolean };

    expect(user.displayName).toBe('Ada Lovelace');
    expect(user.active).toBe(true);
  });

  it('sends the personal access token as a bearer credential', async () => {
    let authorization: string | undefined;
    server.route('/rest/api/2/myself', (req, res) => {
      authorization = req.headers.authorization;
      respondJson(res, 200, { displayName: 'Ada', name: 'ada' });
    });

    await JiraWhoami.run(argv());

    expect(authorization).toBe('Bearer pat');
  });

  it('exits 3 when the instance rejects the credentials', async () => {
    server.route('/rest/api/2/myself', (_req, res) => {
      respondJson(res, 401, { message: 'bad token' });
    });

    const error = (await JiraWhoami.run(argv()).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(3);
    expect(error.message).toContain('Authentication failed');
  });

  it('exits 2 when no credentials are configured at all', async () => {
    const error = (await JiraWhoami.run(['--jira-url', server.baseUrl]).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('SIMPLY_JIRA_PERSONAL_TOKEN');
  });

  it('emits a machine-readable error on stderr under --json', async () => {
    server.route('/rest/api/2/myself', (_req, res) => {
      respondJson(res, 403, { message: 'forbidden' });
    });

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
      written.push(String(chunk));
      return true;
    });

    try {
      await JiraWhoami.run(argv('--json')).catch(() => undefined);
    } finally {
      stderr.mockRestore();
    }

    // Node's own warnings share this stream, so take the line that is actually our payload.
    const line = written
      .join('')
      .split('\n')
      .find((candidate) => candidate.startsWith('{"error"'));
    const payload = JSON.parse(line ?? '') as { error: { name: string; exitCode: number; status: number } };

    expect(payload.error.name).toBe('AuthError');
    expect(payload.error.exitCode).toBe(3);
    expect(payload.error.status).toBe(403);
  });

  it('refuses to report success when the response carries no account', async () => {
    // A login page or captive proxy can answer 200 with no user; claiming success there would
    // tell a caller it is authenticated when it is not.
    server.route('/rest/api/2/myself', (_req, res) => {
      res.writeHead(200);
      res.end();
    });

    const error = (await JiraWhoami.run(argv()).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(1);
    expect(error.message).toContain('no account details');
  });

  it('still connects with the deprecated unprefixed names, warning on stderr', async () => {
    server.route('/rest/api/2/myself', (_req, res) => {
      respondJson(res, 200, { displayName: 'Ada', name: 'ada' });
    });
    process.env.JIRA_URL = server.baseUrl;
    process.env.JIRA_PERSONAL_TOKEN = 'pat';

    // oclif writes warnings to stderr through console.error, which the test runner intercepts.
    const written: string[] = [];
    const stderr = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      written.push(parts.map(String).join(' '));
    });

    try {
      const user = (await JiraWhoami.run([])) as { displayName: string };
      expect(user.displayName).toBe('Ada');
    } finally {
      stderr.mockRestore();
      delete process.env.JIRA_URL;
      delete process.env.JIRA_PERSONAL_TOKEN;
    }

    // oclif wraps a warning to the terminal width, may colour it, and marks each line with a
    // platform-specific arrow: `›` on Linux and macOS, `»` on Windows.
    const output = stripVTControlCharacters(written.join('')).replaceAll(/[›»]/g, ' ').replaceAll(/\s+/g, ' ');
    expect(output).toContain('JIRA_URL → SIMPLY_JIRA_URL');
    expect(output).toContain('JIRA_PERSONAL_TOKEN → SIMPLY_JIRA_PERSONAL_TOKEN');
  });

  it('does not warn about a deprecated name shadowed by its prefixed one', async () => {
    server.route('/rest/api/2/myself', (_req, res) => {
      respondJson(res, 200, { displayName: 'Ada', name: 'ada' });
    });
    // Left behind for another tool: ignored, so not this CLI's business to report.
    process.env.JIRA_URL = 'https://other-tool.example.gov';
    process.env.SIMPLY_JIRA_URL = server.baseUrl;
    process.env.SIMPLY_JIRA_PERSONAL_TOKEN = 'pat';

    const written: string[] = [];
    const stderr = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      written.push(parts.map(String).join(' '));
    });

    try {
      const user = (await JiraWhoami.run([])) as { displayName: string };
      expect(user.displayName).toBe('Ada');
    } finally {
      stderr.mockRestore();
      delete process.env.JIRA_URL;
      delete process.env.SIMPLY_JIRA_URL;
      delete process.env.SIMPLY_JIRA_PERSONAL_TOKEN;
    }

    expect(written.join('')).not.toContain('Deprecated');
  });

  it('exits 2 when --env-file points at a file that is not there', async () => {
    const error = (await JiraWhoami.run(argv('--env-file', '/nonexistent/.env')).catch(
      (caught: unknown) => caught,
    )) as { oclif?: { exit?: number }; message: string };

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('not found');
  });
});
