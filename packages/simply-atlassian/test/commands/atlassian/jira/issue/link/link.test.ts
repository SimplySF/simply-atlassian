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
import JiraIssueCreate from '../../../../../../src/commands/atlassian/jira/issue/create.js';
import JiraIssueLinkCreate from '../../../../../../src/commands/atlassian/jira/issue/link/create.js';
import JiraIssueLinkDelete from '../../../../../../src/commands/atlassian/jira/issue/link/delete.js';
import JiraIssueLinkList from '../../../../../../src/commands/atlassian/jira/issue/link/list.js';
import JiraIssueLinkTypes from '../../../../../../src/commands/atlassian/jira/issue/link/types.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.ATLASSIAN_READ_ONLY;
});

function argv(...extra: string[]): string[] {
  return ['--jira-url', server.baseUrl, '--jira-personal-token', 'pat', ...extra];
}

type Failure = { oclif?: { exit?: number }; message: string };

/** The slice of a command instance this helper drives. */
interface Runnable {
  log: (message?: string) => void;
  init(): Promise<void>;
  run(): Promise<unknown>;
}

type CommandClass = new (argv: string[], config: never) => Runnable;

/**
 * Runs a command capturing what it printed. Asserting only on the returned payload — which is the
 * raw response — checks the mock against itself and would pass through a typo in any column.
 */
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

const LINK_TYPES = {
  issueLinkTypes: [
    { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' },
  ],
};

function routeTypes(): void {
  server.route('/rest/api/2/issueLinkType', (_req, res) => {
    respondJson(res, 200, LINK_TYPES);
  });
}

describe('issue link types', () => {
  it('shows both phrases, which is what link create accepts', async () => {
    routeTypes();
    const printed = await output(JiraIssueLinkTypes, argv());
    expect(printed).toContain('Blocks');
    expect(printed).toContain('blocks');
    expect(printed).toContain('is blocked by');
  });

  it('caps the render and says how many there were', async () => {
    server.route('/rest/api/2/issueLinkType', (_req, res) => {
      respondJson(res, 200, {
        issueLinkTypes: Array.from({ length: 40 }, (_, index) => ({
          id: String(index),
          name: `T${index}`,
          outward: `o${index}`,
          inward: `i${index}`,
        })),
      });
    });

    const printed = await output(JiraIssueLinkTypes, argv('--limit', '3'));

    expect(printed).toContain('Showing 3 of 40');
    expect(printed).not.toContain('T20');
  });

  it('does not treat an empty list as an error', async () => {
    server.route('/rest/api/2/issueLinkType', (_req, res) => {
      respondJson(res, 200, { issueLinkTypes: [] });
    });
    await expect(JiraIssueLinkTypes.run(argv())).resolves.toBeDefined();
  });
});

describe('issue link create', () => {
  /*
   * The assertion that matters most in this file. "A blocks B" must put A in `inwardIssue`,
   * per Atlassian's labeling rule and confirmed against a live instance. Reversing these two
   * lines produces a link that states the opposite and errors nowhere.
   */
  it('puts the subject of the phrase in inwardIssue', async () => {
    let sent: unknown;
    routeTypes();
    server.route('/rest/api/2/issueLink', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, {});
    });

    await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2'));

    expect(sent).toEqual({
      // By id, not name: a name is re-resolved server-side from a mutable string.
      type: { id: '10000' },
      inwardIssue: { key: 'P-1' },
      outwardIssue: { key: 'P-2' },
    });
  });

  it('sends the identical payload for the same fact said the other way round', async () => {
    const bodies: unknown[] = [];
    routeTypes();
    server.route('/rest/api/2/issueLink', (_req, res, body) => {
      bodies.push(JSON.parse(body));
      respondJson(res, 201, {});
    });

    await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2'));
    await JiraIssueLinkCreate.run(argv('P-2', 'is blocked by', 'P-1'));

    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('attaches a comment when asked', async () => {
    let sent: { comment?: { body?: unknown } } | undefined;
    routeTypes();
    server.route('/rest/api/2/issueLink', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, {});
    });

    await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2', '--comment', 'same root cause'));

    expect(sent?.comment?.body).toBe('same root cause');
  });

  it('sends nothing under --dry-run', async () => {
    routeTypes();
    await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2', '--dry-run'));
    // The type lookup happens and nothing else does. Asserting the exact request list is what
    // makes this bite: an earlier version checked a URL substring that could never match.
    expect(server.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /rest/api/2/issueLinkType',
    ]);
  });

  it('lists the available types when the phrase does not match', async () => {
    routeTypes();
    const error = (await JiraIssueLinkCreate.run(argv('P-1', 'obsoletes', 'P-2')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('is blocked by');
  });

  it('is refused by the read-only guard before any request', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const error = (await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it('falls back to the type name when the instance reports no id', async () => {
    let sent: { type?: unknown } | undefined;
    server.route('/rest/api/2/issueLinkType', (_req, res) => {
      respondJson(res, 200, { issueLinkTypes: [{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] });
    });
    server.route('/rest/api/2/issueLink', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, {});
    });

    await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2'));

    // Never `type: {}`, which is what serialising an absent name produced.
    expect(sent?.type).toEqual({ name: 'Blocks' });
  });

  it('echoes the canonical phrase, not the raw argument', async () => {
    routeTypes();
    server.route('/rest/api/2/issueLink', (_req, res) => {
      respondJson(res, 201, {});
    });

    const printed = await output(JiraIssueLinkCreate, argv('P-1', 'BLOCKS', 'P-2'));

    expect(printed).toContain('P-1 blocks P-2');
  });

  it("refuses when a name and another type's phrase collide", async () => {
    // Phrases are instance-configurable, so this is reachable: "Blocks" is one type's name and
    // another's outward phrase. Picking either silently is the failure this module prevents.
    server.route('/rest/api/2/issueLinkType', (_req, res) => {
      respondJson(res, 200, {
        issueLinkTypes: [
          // "blocks" is this one's NAME (normalised) and the next one's outward phrase.
          { id: '1', name: 'Blocks', inward: 'is prevented by', outward: 'prevents' },
          { id: '2', name: 'Gates', inward: 'is gated by', outward: 'blocks' },
        ],
      });
    });

    const error = (await JiraIssueLinkCreate.run(argv('P-1', 'blocks', 'P-2')).catch(
      (caught: unknown) => caught,
    )) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('name of one link type and a phrase of another');
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);
  });
});

describe('issue link list', () => {
  function routeIssue(issuelinks: unknown[]): void {
    server.route('/rest/api/2/issue/P-1', (_req, res) => {
      respondJson(res, 200, { key: 'P-1', fields: { issuelinks } });
    });
  }

  it('phrases each link from the perspective of the issue asked about', async () => {
    routeIssue([
      {
        id: '10201',
        type: LINK_TYPES.issueLinkTypes[0],
        // P-1 occupied inwardIssue, so the other end comes back as outwardIssue: "P-1 blocks P-2".
        outwardIssue: { key: 'P-2', fields: { summary: 'ship it', status: { name: 'To Do' } } },
      },
      {
        id: '10202',
        type: LINK_TYPES.issueLinkTypes[0],
        inwardIssue: { key: 'P-3', fields: { summary: 'migrate', status: { name: 'In Progress' } } },
      },
    ]);

    const printed = await output(JiraIssueLinkList, argv('P-1'));

    // Every column, phrased from P-1's side: it blocks P-2 and is blocked by P-3.
    expect(printed).toMatch(/10201\s+blocks\s+P-2\s+To Do\s+ship it/);
    expect(printed).toMatch(/10202\s+is blocked by\s+P-3\s+In Progress\s+migrate/);
  });

  it('says so plainly when an issue has no links', async () => {
    routeIssue([]);
    expect(await output(JiraIssueLinkList, argv('P-1'))).toContain('No links on P-1');
  });

  it('does not crash on a link missing its type or counterpart', async () => {
    routeIssue([{ id: '10203' }]);
    expect(await output(JiraIssueLinkList, argv('P-1'))).toContain('10203');
  });

  it('states no direction rather than a wrong one when the phrase is missing', async () => {
    // The inward end used to fall back to the type name, which resolveLinkDirection reads as the
    // OUTWARD phrase — so a reader saw "P-1 Blocks P-3" for a link that means the opposite.
    routeIssue([{ id: '10204', type: { name: 'Blocks', outward: 'blocks' }, inwardIssue: { key: 'P-3' } }]);

    const printed = await output(JiraIssueLinkList, argv('P-1'));

    expect(printed).toContain('is linked to');
    expect(printed).not.toMatch(/10204\s+Blocks/);
  });

  it('caps the render and says how many there were', async () => {
    routeIssue(
      Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        type: LINK_TYPES.issueLinkTypes[0],
        outwardIssue: { key: `P-${index}` },
      })),
    );

    expect(await output(JiraIssueLinkList, argv('P-1', '--limit', '5'))).toContain('Showing 5 of 30');
  });
});

describe('issue link delete', () => {
  function routeLink(): void {
    server.route('/rest/api/2/issueLink/10201', (req, res) => {
      if (req.method === 'GET') {
        respondJson(res, 200, {
          id: '10201',
          type: LINK_TYPES.issueLinkTypes[0],
          inwardIssue: { key: 'P-1' },
          outwardIssue: { key: 'P-2' },
        });
        return;
      }
      res.writeHead(204).end();
    });
  }

  it('puts the id in the URL', async () => {
    routeLink();

    await JiraIssueLinkDelete.run(argv('10201'));

    expect(server.requests.at(-1)?.method).toBe('DELETE');
    expect(server.requests.at(-1)?.url).toContain('/issueLink/10201');
  });

  /*
   * The --confirm exemption is justified by the claim that the output is enough to re-create the
   * link. That claim was false while the command printed only the id — after deletion the link is
   * gone from both issues, so this line is the only surviving record of what it was.
   */
  it('names the relationship it removed, not just the id', async () => {
    routeLink();

    const printed = await output(JiraIssueLinkDelete, argv('10201'));

    expect(printed).toContain('P-1 blocks P-2');
  });

  it('names the relationship under --dry-run too, without deleting', async () => {
    routeLink();

    const printed = await output(JiraIssueLinkDelete, argv('10201', '--dry-run'));

    expect(printed).toContain('P-1 blocks P-2');
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('needs no --confirm, since a link is re-creatable', async () => {
    routeLink();
    await expect(JiraIssueLinkDelete.run(argv('10201'))).resolves.toBeDefined();
  });

  it('rejects an issue key passed where a link id belongs', async () => {
    const error = (await JiraIssueLinkDelete.run(argv('PROJ-123')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(error.message).toContain('not a link id');
    // Nothing is sent: a 404 here would read as though the link were already gone.
    expect(server.requests).toHaveLength(0);
  });

  it('is refused by the read-only guard before any request', async () => {
    process.env.ATLASSIAN_READ_ONLY = 'true';
    const error = (await JiraIssueLinkDelete.run(argv('10201')).catch((caught: unknown) => caught)) as Failure;

    expect(error.oclif?.exit).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe('issue create --parent', () => {
  it('reaches fields.parent.key', async () => {
    let sent: { fields: { parent?: unknown } } | undefined;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-9' });
    });

    await JiraIssueCreate.run(argv('--project', 'P', '--type', 'Subtask', '--parent', 'P-1', '--summary', 's'));

    expect(sent?.fields.parent).toEqual({ key: 'P-1' });
  });

  it('overrides a parent supplied through --body, like every other typed flag', async () => {
    let sent: { fields: { parent?: unknown } } | undefined;
    server.route('/rest/api/2/issue', (_req, res, body) => {
      sent = JSON.parse(body);
      respondJson(res, 201, { key: 'P-9' });
    });

    await JiraIssueCreate.run(argv('--body', '{"fields":{"parent":{"key":"P-OLD"}}}', '--parent', 'P-NEW'));

    expect(sent?.fields.parent).toEqual({ key: 'P-NEW' });
  });
});
