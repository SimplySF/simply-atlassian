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
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import ConfluencePageHistory from '../../../../../src/commands/atlassian/confluence/page/history.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function argv(...extra: string[]): string[] {
  return ['--confluence-url', server.baseUrl, '--confluence-personal-token', 'pat', ...extra];
}

/** Runs the command capturing what it printed, so column wiring is asserted rather than the mock. */
async function output(args: string[]): Promise<string> {
  const lines: string[] = [];
  const command = new ConfluencePageHistory(args, { runHook: async () => ({ successes: [], failures: [] }) } as never);
  command.log = (message?: string): void => {
    lines.push(String(message));
  };
  await command.init();
  await command.run();
  return lines.join('\n');
}

function version(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    by: { displayName: `Author ${number}` },
    when: `2026-10-0${number}T09:00:00.000Z`,
    message: `edit ${number}`,
    minorEdit: false,
    ...extra,
  };
}

function versions(results: unknown[], next?: string): void {
  server.route('/rest/experimental/content/123456/version', (_req, res) => {
    respondJson(res, 200, { results, start: 0, _links: next === undefined ? {} : { next } });
  });
}

describe('confluence page history', () => {
  it('renders versions newest first with a complete footer', async () => {
    versions([version(1), version(2, { minorEdit: true, message: '' })]);

    const text = await output(argv('123456'));
    const rows = text.split('\n');

    expect(rows[0]).toMatch(/^VERSION\s+WHEN\s+AUTHOR\s+MINOR\s+MESSAGE/);
    expect(rows[2]).toMatch(/^2\s+2026-10-02\s+Author 2\s+yes/);
    expect(rows[3]).toMatch(/^1\s+2026-10-01\s+Author 1\s+—\s+edit 1/);
    expect(text).toContain('Showing 2 version(s).');
  });

  it('says when --limit cut the history short', async () => {
    versions([version(3), version(2)], '/rest/experimental/content/123456/version?start=2');

    const text = await output(argv('123456', '--limit', '2'));

    expect(text).toContain('Showing the 2 most recent version(s); pass --limit for more.');
  });

  it('accepts a page URL and returns raw entries under --json', async () => {
    versions([version(1, { hidden: false })]);

    // A URL has to name the configured instance; one from another host is refused.
    const result = await ConfluencePageHistory.run(argv(`${server.baseUrl}/spaces/DOCS/pages/123456/Title`, '--json'));

    expect(result).toEqual({ rawEntries: [version(1, { hidden: false })], complete: true });
  });

  it('strips control characters from author-controlled values', async () => {
    versions([version(1, { by: { displayName: 'Mallory\u001b[2J' }, message: 'fine\rhidden' })]);

    const text = await output(argv('123456'));

    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\r');
    expect(text).toContain('Mallory');
  });

  it('reports a page with no versions', async () => {
    versions([]);

    expect(await output(argv('123456'))).toBe('No versions found for page 123456.');
  });

  it('exits 1 with the instance message for an unknown page', async () => {
    server.route('/rest/api/content/123456', (_req, res) => respondJson(res, 404, { message: 'No content found' }));

    await expect(output(argv('123456'))).rejects.toMatchObject({ message: expect.stringContaining('404') });
  });
});
