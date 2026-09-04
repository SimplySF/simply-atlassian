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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ConfluencePageGet from '../../../../../src/commands/atlassian/confluence/page/get.js';
import { respondJson, startTestServer, type TestServer } from '../../../../core/support.js';

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

const STORAGE = '<h2>Overview</h2><p>Deploy <strong>now</strong>.</p>';

function routePage(onQuery?: (expand: string | null) => void): void {
  server.route('/rest/api/content/123456', (req, res) => {
    onQuery?.(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('expand'));
    respondJson(res, 200, {
      id: '123456',
      title: 'Runbook',
      type: 'page',
      space: { key: 'DOCS', name: 'Documentation' },
      version: { number: 4, when: '2026-09-01T10:00:00.000Z', by: { displayName: 'Ada' } },
      body: { storage: { value: STORAGE } },
    });
  });
}

describe('confluence page get', () => {
  it('returns the raw page payload', async () => {
    routePage();

    const page = (await ConfluencePageGet.run(argv('123456'))) as { id: string; title: string };

    expect(page.id).toBe('123456');
    expect(page.title).toBe('Runbook');
  });

  it('accepts a page URL in place of an id', async () => {
    routePage();

    await expect(
      ConfluencePageGet.run(argv('https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Runbook')),
    ).resolves.toBeDefined();
  });

  it('requests the body by default', async () => {
    let expand: string | null = null;
    routePage((value) => {
      expand = value;
    });

    await ConfluencePageGet.run(argv('123456'));

    expect(expand).toContain('body.storage');
  });

  it('does not request the body when --body-format none', async () => {
    let expand: string | null = null;
    routePage((value) => {
      expand = value;
    });

    await ConfluencePageGet.run(argv('123456', '--body-format', 'none'));

    // Not fetching it is the point: page bodies are the expensive part of the payload.
    expect(expand).not.toContain('body.storage');
  });

  it('honours an explicit --expand list over the default', async () => {
    let expand: string | null = null;
    routePage((value) => {
      expand = value;
    });

    await ConfluencePageGet.run(argv('123456', '--expand', 'version'));

    expect(expand).toBe('version');
  });

  it('rejects an unusable page argument with exit 2', async () => {
    const error = (await ConfluencePageGet.run(argv('not-a-page')).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('page id');
  });

  it('exits 1 with the API message for a missing page', async () => {
    server.route('/rest/api/content/999', (_req, res) => {
      respondJson(res, 404, { message: 'No content found with id 999' });
    });

    const error = (await ConfluencePageGet.run(argv('999')).catch((caught: unknown) => caught)) as {
      oclif?: { exit?: number };
      message: string;
    };

    expect(error.oclif?.exit).toBe(1);
    expect(error.message).toContain('No content found');
  });

  it('exits 2 when only Jira credentials are configured', async () => {
    const error = (await ConfluencePageGet.run(['--confluence-url', server.baseUrl, '123456']).catch(
      (caught: unknown) => caught,
    )) as { oclif?: { exit?: number }; message: string };

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('CONFLUENCE_PERSONAL_TOKEN');
  });
});
