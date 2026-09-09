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
import ConfluencePageCommentAdd from '../../../../../src/commands/atlassian/confluence/page/comment/add.js';
import ConfluencePageCommentList from '../../../../../src/commands/atlassian/confluence/page/comment/list.js';
import ConfluencePageCreate from '../../../../../src/commands/atlassian/confluence/page/create.js';
import ConfluencePageDelete from '../../../../../src/commands/atlassian/confluence/page/delete.js';
import ConfluencePageUpdate from '../../../../../src/commands/atlassian/confluence/page/update.js';
import { respondJson, startTestServer, type TestServer } from '../../../../core/support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.ATLASSIAN_READ_ONLY;
});

function argv(...extra: string[]): string[] {
  return ['--confluence-url', server.baseUrl, '--confluence-personal-token', 'pat', ...extra];
}

type Failure = { oclif?: { exit?: number }; message: string };

/** The slice of a command instance the output helper drives. */
interface Runnable {
  log: (message?: string) => void;
  init(): Promise<void>;
  run(): Promise<unknown>;
}

type CommandClass = new (argv: string[], config: never) => Runnable;

/** Runs a command capturing what it printed, so column wiring is asserted rather than the mock. */
async function output(Command: CommandClass, args: string[]): Promise<string> {
  const lines: string[] = [];
  const command = new Command(args, { runHook: async () => ({ successes: [], failures: [] }) } as never);
  command.log = (message?: string): void => {
    lines.push(String(message));
  };
  await command.init();
  await command.run();
  return lines.join('\n');
}

describe('page create', () => {
  it('builds the payload from typed flags', async () => {
    let sent: unknown;
    server.route('/rest/api/content', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '99', title: 'Release notes', version: { number: 1 } });
    });

    await ConfluencePageCreate.run(argv('--space', 'DOCS', '--title', 'Release notes', '--text', 'Shipped.'));

    expect(sent).toEqual({
      type: 'page',
      title: 'Release notes',
      space: { key: 'DOCS' },
      body: { storage: { value: '<p>Shipped.</p>', representation: 'storage' } },
    });
  });

  it('maps --parent to ancestors, which is what places the page in the tree', async () => {
    let sent: { ancestors?: unknown } | undefined;
    server.route('/rest/api/content', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '99' });
    });

    await ConfluencePageCreate.run(argv('--space', 'DOCS', '--title', 'Child', '--text', 'x', '--parent', '123456'));

    expect(sent?.ancestors).toEqual([{ id: '123456' }]);
  });

  it('accepts a page URL as the parent, not only a bare id', async () => {
    let sent: { ancestors?: Array<{ id?: string }> } | undefined;
    server.route('/rest/api/content', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '99' });
    });

    await ConfluencePageCreate.run(
      argv(
        '--space',
        'DOCS',
        '--title',
        'Child',
        '--text',
        'x',
        '--parent',
        `${server.baseUrl}/wiki/spaces/DOCS/pages/123456/Title`,
      ),
    );

    expect(sent?.ancestors?.[0]?.id).toBe('123456');
  });

  it('sends an empty body rather than refusing, since a placeholder page is legitimate', async () => {
    let sent: { body?: { storage?: { value?: string } } } | undefined;
    server.route('/rest/api/content', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '99' });
    });

    await ConfluencePageCreate.run(argv('--space', 'DOCS', '--title', 'Placeholder'));

    expect(sent?.body?.storage?.value).toBe('');
  });

  it('sends nothing under --dry-run', async () => {
    await ConfluencePageCreate.run(argv('--space', 'DOCS', '--title', 'T', '--text', 'x', '--dry-run'));

    expect(server.requests).toHaveLength(0);
  });

  it('is refused by the read-only guard before any request', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const error = (await ConfluencePageCreate.run(argv('--space', 'DOCS', '--title', 'T', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe('page update', () => {
  function routeCurrent(version: number, title = 'Current title'): void {
    server.route('/rest/api/content/123', (req, res, body) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title, version: { number: version } });
        return;
      }
      respondJson(res, 200, { id: '123', title, version: { number: version + 1 }, sent: JSON.parse(body) });
    });
  }

  /*
   * The assertion the whole command rests on: Confluence requires the NEXT version, and it
   * refuses anything else with a 409 rather than overwriting. Sending `version` unchanged, or
   * omitting it, would fail every update.
   */
  it('sends exactly the current version plus one', async () => {
    let sent: { version?: { number?: number } } | undefined;
    server.route('/rest/api/content/123', (req, res, body) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title: 'T', version: { number: 7 } });
        return;
      }
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '123', version: { number: 8 } });
    });

    await ConfluencePageUpdate.run(argv('123', '--text', 'new body'));

    expect(sent?.version?.number).toBe(8);
  });

  it("carries the page's existing title when --title is not given", async () => {
    let sent: { title?: string } | undefined;
    server.route('/rest/api/content/123', (req, res, body) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title: 'Keep me', version: { number: 1 } });
        return;
      }
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '123' });
    });

    await ConfluencePageUpdate.run(argv('123', '--text', 'body only'));

    // Confluence requires the title on every update; omitting it would blank the page's name.
    expect(sent?.title).toBe('Keep me');
  });

  it('lets --title override without requiring a body', async () => {
    let sent: { title?: string; body?: unknown } | undefined;
    server.route('/rest/api/content/123', (req, res, body) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title: 'Old', version: { number: 1 } });
        return;
      }
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '123' });
    });

    await ConfluencePageUpdate.run(argv('123', '--title', 'New name'));

    expect(sent?.title).toBe('New name');
    expect(sent?.body).toBeUndefined();
  });

  /*
   * The failure this command exists to handle well. A 409 means the page moved under us and
   * nothing was written — a different situation from a malformed request, with a different fix.
   */
  it('turns a 409 into a conflict that says nothing was written', async () => {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title: 'T', version: { number: 2 } });
        return;
      }
      respondJson(res, 409, { statusCode: 409, message: 'Version must be incremented on update.' });
    });

    const error = (await ConfluencePageUpdate.run(argv('123', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.message).toContain('changed by someone else');
    expect(error.message).toContain('Nothing was written');
  });

  it('refuses an update with nothing to change', async () => {
    const error = (await ConfluencePageUpdate.run(argv('123')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Nothing to update');
    expect(server.requests).toHaveLength(0);
  });

  it('reads but does not write under --dry-run', async () => {
    routeCurrent(3);

    await ConfluencePageUpdate.run(argv('123', '--text', 'x', '--dry-run'));

    expect(server.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('is refused by the read-only guard before any request', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const error = (await ConfluencePageUpdate.run(argv('123', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe('page delete', () => {
  function routePage(status = 'current', options: { purgeFails?: boolean } = {}): void {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        // A real instance only returns a trashed page under `?status=any`; the mock asserts the
        // command actually asks for it rather than quietly relying on a permissive fake.
        if (status === 'trashed' && !(req.url ?? '').includes('status=any')) {
          respondJson(res, 404, { statusCode: 404, message: 'No content found with id : 123' });
          return;
        }
        respondJson(res, 200, { id: '123', title: 'Doomed page', status });
        return;
      }
      if (options.purgeFails === true && (req.url ?? '').includes('status=trashed')) {
        respondJson(res, 403, { statusCode: 403, message: 'purge not permitted for this user' });
        return;
      }
      res.writeHead(204).end();
    });
  }

  /*
   * Delete and purge are the same verb on the same path in Confluence, separated only by a query
   * parameter — and one is reversible while the other is not. These two tests are what keep the
   * distinction honest.
   */
  it('trashes without --confirm, because trashing is reversible', async () => {
    routePage();

    const printed = await output(ConfluencePageDelete, argv('123'));

    const writes = server.requests.filter((r) => r.method === 'DELETE');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).not.toContain('status=trashed');
    expect(printed).toContain('trash');
    expect(printed).toContain('restored');
  });

  it('refuses --purge without --confirm, naming the page', async () => {
    routePage();

    const error = (await ConfluencePageDelete.run(argv('123', '--purge')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Doomed page');
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('trashes then purges a live page, so --purge always means gone', async () => {
    routePage('current');

    await ConfluencePageDelete.run(argv('123', '--purge', '--confirm'));

    const writes = server.requests.filter((r) => r.method === 'DELETE');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.url).not.toContain('status=trashed');
    expect(writes[1]?.url).toContain('status=trashed');
  });

  it('purges an already-trashed page in one step', async () => {
    routePage('trashed');

    await ConfluencePageDelete.run(argv('123', '--purge', '--confirm'));

    const writes = server.requests.filter((r) => r.method === 'DELETE');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain('status=trashed');
  });

  it('says so rather than erroring when trashing something already trashed', async () => {
    routePage('trashed');

    const printed = await output(ConfluencePageDelete, argv('123'));

    expect(printed).toContain('already in the trash');
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('names the page and its fate under --dry-run, without deleting', async () => {
    routePage();

    const printed = await output(ConfluencePageDelete, argv('123', '--purge', '--confirm', '--dry-run'));

    expect(printed).toContain('Doomed page');
    expect(printed).toContain('permanently destroy');
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('is refused by the read-only guard before any request', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const error = (await ConfluencePageDelete.run(argv('123')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe('page comment add', () => {
  it('points the container at the page, which is what makes it a comment', async () => {
    let sent: unknown;
    server.route('/rest/api/content', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 200, { id: '555', type: 'comment' });
    });

    await ConfluencePageCommentAdd.run(argv('123', '--text', 'Looks right.'));

    expect(sent).toEqual({
      type: 'comment',
      container: { id: '123', type: 'page' },
      body: { storage: { value: '<p>Looks right.</p>', representation: 'storage' } },
    });
  });

  it('refuses an empty comment', async () => {
    const error = (await ConfluencePageCommentAdd.run(argv('123')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('Nothing to post');
    expect(server.requests).toHaveLength(0);
  });

  it('is refused by the read-only guard before any request', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const error = (await ConfluencePageCommentAdd.run(argv('123', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe('page comment list', () => {
  it('renders every column from the flattened storage body', async () => {
    server.route('/rest/api/content/123/child/comment', (_req, res) => {
      respondJson(res, 200, {
        results: [
          {
            id: '555',
            body: { storage: { value: '<p>First <strong>comment</strong></p>' } },
            history: { createdDate: '2026-09-08T12:00:00.000Z', createdBy: { displayName: 'Ada L' } },
          },
        ],
        size: 1,
      });
    });

    const printed = await output(ConfluencePageCommentList, argv('123'));

    expect(printed).toMatch(/555\s+Ada L\s+2026-09-08/);
    expect(printed).toContain('First');
  });

  it('prefers the comment author over whoever last edited it', async () => {
    server.route('/rest/api/content/123/child/comment', (_req, res) => {
      respondJson(res, 200, {
        results: [
          {
            id: '555',
            body: { storage: { value: '<p>x</p>' } },
            history: { createdBy: { displayName: 'Author' } },
            version: { by: { displayName: 'Editor' } },
          },
        ],
      });
    });

    const printed = await output(ConfluencePageCommentList, argv('123'));

    expect(printed).toContain('Author');
    expect(printed).not.toContain('Editor');
  });

  it('says so plainly when a page has no comments', async () => {
    server.route('/rest/api/content/123/child/comment', (_req, res) => {
      respondJson(res, 200, { results: [], size: 0 });
    });

    expect(await output(ConfluencePageCommentList, argv('123'))).toContain('No comments on page 123');
  });

  it('does not crash on a comment with no body or author', async () => {
    server.route('/rest/api/content/123/child/comment', (_req, res) => {
      respondJson(res, 200, { results: [{ id: '555' }] });
    });

    expect(await output(ConfluencePageCommentList, argv('123'))).toContain('555');
  });
});

/*
 * Every case below was found by security review and reproduced against the real binary before
 * being fixed. They are the regressions that matter most in this file: each one is a destructive
 * command doing something other than what its command line says.
 */
describe('destructive-command guards', () => {
  /*
   * oclif sets a boolean flag true for `--confirm=x` and pushes the value into the next
   * positional slot. So `--confirm=123456`, a command line with NO page argument, armed the guard
   * and supplied 123456 as the page to destroy. A value-shape check cannot catch it here, because
   * every Confluence page id is bare digits — so the inline form is refused outright.
   */
  it('refuses --confirm=<value>, which armed the guard and became the target', async () => {
    const original = process.argv;
    process.argv = [...original, '--confirm=123456'];
    try {
      const error = (await ConfluencePageDelete.run(argv('--purge', '--confirm=123456')).catch(
        (caught: unknown) => caught,
      )) as Failure;

      expect(error.oclif?.exit).toBe(2);
      expect(error.message).toContain('takes no value');
      expect(server.requests).toHaveLength(0);
    } finally {
      process.argv = original;
    }
  });

  it('refuses --confirm=false, which silently meant true', async () => {
    const original = process.argv;
    process.argv = [...original, '--confirm=false'];
    try {
      const error = (await ConfluencePageDelete.run(argv('123', '--purge', '--confirm=false')).catch(
        (caught: unknown) => caught,
      )) as Failure;

      expect(error.message).toContain('takes no value');
      expect(server.requests).toHaveLength(0);
    } finally {
      process.argv = original;
    }
  });

  /*
   * The read has to ask for `status=any` or a trashed page 404s, which made the already-trashed
   * branch unreachable and left `--purge` unable to finish a job it had half done.
   */
  it('can read a trashed page, so purging one works', async () => {
    routePageWithStatusCheck('trashed');

    await ConfluencePageDelete.run(argv('123', '--purge', '--confirm'));

    const reads = server.requests.filter((r) => r.method === 'GET');
    expect(reads[0]?.url).toContain('status=any');
    const writes = server.requests.filter((r) => r.method === 'DELETE');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain('status=trashed');
  });

  /*
   * Trash succeeded, purge failed. Reporting only the purge's error read as "nothing happened"
   * while the page had already left the space and every link to it was broken.
   */
  it('says the page is trashed-but-not-purged when the purge fails', async () => {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', title: 'Doomed page', status: 'current' });
        return;
      }
      if ((req.url ?? '').includes('status=trashed')) {
        respondJson(res, 403, { statusCode: 403, message: 'purge not permitted' });
        return;
      }
      res.writeHead(204).end();
    });

    const error = (await ConfluencePageDelete.run(argv('123', '--purge', '--confirm')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.message).toContain('moved to the trash');
    expect(error.message).toContain('could NOT be permanently');
    expect(error.message).toContain('recoverable');
  });

  it('renders a hostile title so it cannot narrate a false outcome', async () => {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, {
          id: '123',
          status: 'current',
          title: '"). Nothing was deleted; the page is intact. ("',
        });
        return;
      }
      res.writeHead(204).end();
    });

    const printed = await output(ConfluencePageDelete, argv('123'));

    // JSON-quoted, so an embedded quote shows as an escape rather than closing ours.
    expect(printed).toContain('\\"');
    expect(printed).toContain('to the trash');
  });

  function routePageWithStatusCheck(status: string): void {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        if (status === 'trashed' && !(req.url ?? '').includes('status=any')) {
          respondJson(res, 404, { statusCode: 404, message: 'No content found with id : 123' });
          return;
        }
        respondJson(res, 200, { id: '123', title: 'Doomed page', status });
        return;
      }
      res.writeHead(204).end();
    });
  }
});

describe('page update, hardened', () => {
  it('refuses an id the instance says is not a page', async () => {
    server.route('/rest/api/content/555', (_req, res) => {
      respondJson(res, 200, { id: '555', type: 'comment', title: 'a comment', version: { number: 1 } });
    });

    const error = (await ConfluencePageUpdate.run(argv('555', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.message).toContain('is a comment, not a page');
    expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  /*
   * A duplicate-title 409 was diagnosed as "someone else edited this" and prescribed re-running,
   * which for an agent is an infinite loop: re-running reproduces the same 409 forever.
   */
  it('does not call a non-version 409 a concurrent edit', async () => {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title: 'T', version: { number: 4 } });
        return;
      }
      respondJson(res, 409, { statusCode: 409, message: 'A page with this title already exists' });
    });

    const error = (await ConfluencePageUpdate.run(argv('123', '--text', 'x')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.message).not.toContain('changed by someone else');
    expect(error.message).toContain('already exists');
  });

  it('reports the id it wrote to, not the one the response claims', async () => {
    server.route('/rest/api/content/123', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, { id: '123', type: 'page', title: 'T', version: { number: 1 } });
        return;
      }
      respondJson(res, 200, { id: '999999', title: 'Not the page you asked for', version: { number: 2 } });
    });

    const printed = await output(ConfluencePageUpdate, argv('123', '--text', 'x'));

    expect(printed).toContain('123');
    expect(printed).not.toContain('999999');
  });
});
