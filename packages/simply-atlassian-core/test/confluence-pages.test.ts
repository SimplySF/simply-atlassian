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
import { ConfluenceClient } from '../src/confluence-client.js';
import {
  buildPageCommentBody,
  buildPageCreateBody,
  deletePage,
  pageExpand,
  preparePageUpdate,
  renderPageBody,
  updatePage,
  webUrl,
} from '../src/confluence-pages.js';
import { CliError, ConfigError } from '../src/errors.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function confluence(): ConfluenceClient {
  return new ConfluenceClient({
    url: server.baseUrl,
    deployment: 'server',
    auth: { kind: 'bearer', personalToken: 'pat' },
  });
}

describe('page helpers', () => {
  it('joins the split browser URL and skips the body expansion for "none"', () => {
    expect(webUrl({ _links: { base: 'https://x/wiki', webui: '/spaces/D/pages/1' } })).toBe(
      'https://x/wiki/spaces/D/pages/1',
    );
    expect(webUrl({ _links: { base: 'https://x/wiki' } })).toBeUndefined();
    expect(pageExpand('none')).toEqual(['version', 'space']);
    expect(pageExpand('markdown')).toEqual(['body.storage', 'version', 'space']);
    expect(pageExpand('markdown', ['history'])).toEqual(['history']);
  });

  it('renders the body in the requested representation, or nothing', () => {
    expect(renderPageBody('<p>hi</p>', 'storage')).toBe('<p>hi</p>');
    expect(renderPageBody('<p>hi</p>', 'markdown')).toContain('hi');
    expect(renderPageBody('<p>hi</p>', 'none')).toBeUndefined();
    expect(renderPageBody('   ', 'markdown')).toBeUndefined();
  });
});

describe('page bodies', () => {
  it('builds a create request, defaulting an absent body to an empty one and resolving the parent', () => {
    expect(buildPageCreateBody({ space: 'D', title: 'T' }, 'https://x.example')).toEqual({
      type: 'page',
      title: 'T',
      space: { key: 'D' },
      body: { storage: { value: '', representation: 'storage' } },
    });
    expect(
      buildPageCreateBody(
        { space: 'D', title: 'T', text: 'hi', parent: 'https://x.example/pages/9/T' },
        'https://x.example',
      ),
    ).toMatchObject({ body: { storage: { value: '<p>hi</p>' } }, ancestors: [{ id: '9' }] });
    expect(() =>
      buildPageCreateBody({ space: 'D', title: 'T', parent: 'https://other.example/pages/9/T' }, 'https://x.example'),
    ).toThrow(ConfigError);
  });

  it('builds a comment request, refusing an empty one', () => {
    expect(buildPageCommentBody('1', { text: 'ok' })).toEqual({
      type: 'comment',
      container: { id: '1', type: 'page' },
      body: { storage: { value: '<p>ok</p>', representation: 'storage' } },
    });
    expect(() => buildPageCommentBody('1', {})).toThrow(/Nothing to post/);
  });
});

describe('page updates', () => {
  it('reads the current version and title and prepares the next version', async () => {
    server.route('/rest/api/content/1', (_req, res) =>
      respondJson(res, 200, { type: 'page', title: 'Old', version: { number: 3 } }),
    );
    const plan = await preparePageUpdate(confluence(), '1', { text: 'new' });
    expect(plan).toEqual({
      pageId: '1',
      version: 3,
      payload: {
        type: 'page',
        title: 'Old',
        version: { number: 4 },
        body: { storage: { value: '<p>new</p>', representation: 'storage' } },
      },
    });
  });

  it('refuses an empty update, a non-page, and a page with no version', async () => {
    await expect(preparePageUpdate(confluence(), '1', {})).rejects.toThrow(/Nothing to update/);
    server.route('/rest/api/content/1', (_req, res) =>
      respondJson(res, 200, { type: 'comment', version: { number: 1 } }),
    );
    await expect(preparePageUpdate(confluence(), '1', { title: 'x' })).rejects.toThrow(/is a comment, not a page/);
    server.route('/rest/api/content/1', (_req, res) => respondJson(res, 200, { type: 'page' }));
    await expect(preparePageUpdate(confluence(), '1', { title: 'x' })).rejects.toThrow(/reported no version/);
  });

  it('names a version conflict and carries any other 409 through', async () => {
    let message = 'Version mismatch';
    server.route('/rest/api/content/1', (_req, res) => respondJson(res, 409, { message }));
    const plan = { pageId: '1', version: 3, payload: {} };
    await expect(updatePage(confluence(), plan)).rejects.toThrow(/changed by someone else/);
    message = 'A page with this title already exists';
    await expect(updatePage(confluence(), plan)).rejects.toThrow(/already exists/);
  });
});

describe('deletePage', () => {
  function routePage(status: string, deleteQueries: string[] = []): void {
    server.route('/rest/api/content/1', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '1', title: 'Plan "A"', status });
        return;
      }
      deleteQueries.push(new URL(req.url ?? '/', 'http://127.0.0.1').search);
      res.writeHead(204);
      res.end();
    });
  }

  it('reads the page first so the dry run and the refusal can name it', async () => {
    routePage('current');
    await expect(deletePage(confluence(), '1', { dryRun: true })).resolves.toEqual({
      pageId: '1',
      title: '"Plan \\"A\\""',
      purge: false,
      deleted: false,
    });
    await expect(deletePage(confluence(), '1', { purge: true })).rejects.toThrow(/without --confirm/);
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('trashes a current page, reports an already-trashed one, and purges in two steps', async () => {
    const queries: string[] = [];
    routePage('current', queries);
    await expect(deletePage(confluence(), '1')).resolves.toMatchObject({ purge: false, deleted: true });
    expect(queries).toEqual(['']);

    routePage('trashed', queries);
    await expect(deletePage(confluence(), '1')).resolves.toMatchObject({ purge: false, deleted: false });

    queries.length = 0;
    routePage('current', queries);
    await expect(deletePage(confluence(), '1', { purge: true, confirm: true })).resolves.toMatchObject({
      purge: true,
      deleted: true,
    });
    expect(queries).toEqual(['', '?status=trashed']);
  });

  it('says so when the trash step succeeded but the purge did not', async () => {
    server.route('/rest/api/content/1', (req, res) => {
      if (req.method === 'GET') return respondJson(res, 200, { id: '1', title: 'Plan', status: 'current' });
      const purging = (req.url ?? '').includes('status=trashed');
      if (purging) return respondJson(res, 500, { message: 'purge failed' });
      res.writeHead(204);
      res.end();
    });
    await expect(deletePage(confluence(), '1', { purge: true, confirm: true })).rejects.toThrow(CliError);
    await expect(deletePage(confluence(), '1', { purge: true, confirm: true })).rejects.toThrow(/still recoverable/);
  });
});
