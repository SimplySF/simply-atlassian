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
import { ConfigError } from '../../src/core/errors.js';
import { JiraClient } from '../../src/core/jira-client.js';
import { appendMentions, resolveMentions } from '../../src/shared/mentions.js';
import { respondJson, startTestServer, type TestServer } from '../core/support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function client(deployment: 'cloud' | 'server'): JiraClient {
  return new JiraClient({
    url: server.baseUrl,
    deployment,
    auth:
      deployment === 'cloud'
        ? { kind: 'basic', username: 'u@e.com', apiToken: 't' }
        : { kind: 'bearer', personalToken: 'p' },
  });
}

const ACCOUNT = '70121:8d8e579e-980f-49ed-93ec-0a0d519f60e4';

function routeUsers(users: unknown[]): void {
  server.route('/rest/api/3/user/search', (_req, res) => {
    respondJson(res, 200, users);
  });
  server.route('/rest/api/2/user/search', (_req, res) => {
    respondJson(res, 200, users);
  });
}

describe('resolveMentions', () => {
  it('passes an account id through without a lookup', async () => {
    const resolved = await resolveMentions(client('cloud'), [ACCOUNT]);

    expect(resolved).toEqual([{ account: ACCOUNT }]);
    // No request at all: an id needs no resolving, and a needless call could fail.
    expect(server.requests).toHaveLength(0);
  });

  it('recognises every account-id shape, so a valid id is never searched as a name', async () => {
    // Found in review: only the `digits:uuid` form was recognised, so the colon-less 24-hex id
    // — which is what user search prints on some tenants — was searched and reported missing.
    for (const id of [ACCOUNT, '5b10a2844c20165700ede21g', 'qm:8b1e4b2b-1111-2222-3333-444455556666']) {
      // eslint-disable-next-line no-await-in-loop -- each id must be observed on its own
      const resolved = await resolveMentions(client('cloud'), [id]);
      expect(resolved).toEqual([{ account: id }]);
    }
    expect(server.requests).toHaveLength(0);
  });

  it('passes an account through unsearched when given the explicit prefix', async () => {
    const resolved = await resolveMentions(client('cloud'), ['account:whatever-shape-this-is']);

    expect(resolved).toEqual([{ account: 'whatever-shape-this-is' }]);
    expect(server.requests).toHaveLength(0);
  });

  it('excludes deactivated accounts before judging ambiguity', async () => {
    // Found in review: a person's own old duplicate account made their email ambiguous.
    routeUsers([
      { accountId: 'live', displayName: 'Ada', emailAddress: 'ada@example.com', active: true },
      { accountId: 'dead', displayName: 'Ada', emailAddress: 'ada@example.com', active: false },
    ]);

    const resolved = await resolveMentions(client('cloud'), ['ada@example.com']);

    expect(resolved).toEqual([{ account: 'live', display: 'Ada' }]);
  });

  it('refuses when the only matches are deactivated, rather than mentioning a dead account', async () => {
    routeUsers([{ accountId: 'dead', displayName: 'Ada', active: false }]);

    await expect(resolveMentions(client('cloud'), ['ada'])).rejects.toThrow(/deactivated/);
  });

  it('does not quote email addresses in an ambiguity error', async () => {
    // The account id is the whole remediation; the operator asked to comment, not for a staff list.
    routeUsers([
      { accountId: 'a1', displayName: 'Ada One', emailAddress: 'one@example.com', active: true },
      { accountId: 'a2', displayName: 'Ada Two', emailAddress: 'two@example.com', active: true },
    ]);

    const error = (await resolveMentions(client('cloud'), ['ada']).catch((caught: unknown) => caught)) as ConfigError;

    expect(error.message).toContain('a1');
    expect(error.message).toContain('a2');
    expect(error.message).not.toContain('one@example.com');
    expect(error.message).not.toContain('two@example.com');
  });

  it('resolves a single match to its account and display name', async () => {
    routeUsers([{ accountId: ACCOUNT, displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }]);

    const resolved = await resolveMentions(client('cloud'), ['ada@example.com']);

    expect(resolved).toEqual([{ account: ACCOUNT, display: 'Ada Lovelace' }]);
  });

  it('refuses an ambiguous term and lists the candidates by id', async () => {
    // The dangerous case: picking the first match silently notifies the wrong person.
    routeUsers([
      { accountId: 'acct-1', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
      { accountId: 'acct-2', displayName: 'Ada Byron', emailAddress: 'ada.b@example.com' },
    ]);

    const error = (await resolveMentions(client('cloud'), ['ada']).catch((caught: unknown) => caught)) as ConfigError;

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('matches more than one user');
    expect(error.message).toContain('acct-1');
    expect(error.message).toContain('acct-2');
  });

  it('names the query when nothing matches', async () => {
    routeUsers([]);

    await expect(resolveMentions(client('cloud'), ['nobody'])).rejects.toThrow(/No user matches "nobody"/);
  });

  it('refuses an empty term', async () => {
    await expect(resolveMentions(client('cloud'), ['  '])).rejects.toThrow(ConfigError);
  });

  it('reads a values-wrapped response as well as a bare array', async () => {
    server.route('/rest/api/3/user/search', (_req, res) => {
      respondJson(res, 200, { values: [{ accountId: ACCOUNT, displayName: 'Ada' }] });
    });

    const resolved = await resolveMentions(client('cloud'), ['ada']);

    expect(resolved[0]?.account).toBe(ACCOUNT);
  });

  it('resolves by username on Server/DC, where there is no account id', async () => {
    routeUsers([{ name: 'ada', displayName: 'Ada Lovelace' }]);

    const resolved = await resolveMentions(client('server'), ['ada']);

    expect(resolved).toEqual([{ account: 'ada', display: 'Ada Lovelace' }]);
  });

  it('refuses a matched user the instance gave no id for', async () => {
    routeUsers([{ displayName: 'Nameless' }]);

    await expect(resolveMentions(client('cloud'), ['nameless'])).rejects.toThrow(/No user matches/);
  });
});

describe('appendMentions', () => {
  it('adds an ADF mention paragraph on Cloud, keeping the caller text intact', () => {
    const c = client('cloud');
    const body = { body: c.descriptionValue('please review') };

    const result = appendMentions(c, body, [{ account: ACCOUNT, display: 'Ada' }]) as {
      body: { content: Array<{ content: Array<{ type: string; attrs?: { id: string } }> }> };
    };

    expect(result.body.content).toHaveLength(2);
    expect(result.body.content[0]?.content[0]).toEqual({ type: 'text', text: 'please review' });
    expect(result.body.content[1]?.content[0]).toEqual({
      type: 'mention',
      attrs: { id: ACCOUNT, text: '@Ada' },
    });
  });

  it('separates several Cloud mentions with a space', () => {
    const c = client('cloud');
    const result = appendMentions(c, { body: c.descriptionValue('x') }, [
      { account: 'a1', display: 'One' },
      { account: 'a2', display: 'Two' },
    ]) as { body: { content: Array<{ content: unknown[] }> } };

    expect(result.body.content[1]?.content).toHaveLength(3);
  });

  it('keeps a string body AND the mention on Cloud, rather than dropping one', () => {
    // Found in review twice over: a string body took the Server branch, whose ADF shapes have
    // no `text`, so the mention was silently dropped and nobody was notified.
    const c = client('cloud');

    const result = appendMentions(c, { body: 'plain string comment' }, [{ account: ACCOUNT, display: 'Ada' }]) as {
      body: { content: Array<{ content: Array<{ type: string }> }> };
    };

    expect(result.body.content).toHaveLength(2);
    expect(result.body.content[0]?.content[0]).toEqual({ type: 'text', text: 'plain string comment' });
    expect(result.body.content[1]?.content[0]?.type).toBe('mention');
  });

  it('refuses a non-text body on Server/DC instead of discarding it', () => {
    // Found in review: an ADF body on Server was replaced wholesale by the mention token.
    const c = client('server');

    expect(() => appendMentions(c, { body: { type: 'doc', content: [] } }, [{ account: 'ada' }])).toThrow(
      /expects a plain-text comment body/,
    );
  });

  it('preserves a document version the caller supplied', () => {
    const c = client('cloud');

    const result = appendMentions(c, { body: { type: 'doc', version: 3, content: [] } }, [{ account: 'a1' }]) as {
      body: { version: number };
    };

    expect(result.body.version).toBe(3);
  });

  it('omits the fallback text when no display name was looked up', () => {
    // A raw account id in `attrs.text` renders as a uuid wherever Jira uses the fallback.
    const c = client('cloud');

    const result = appendMentions(c, {}, [{ account: ACCOUNT }]) as {
      body: { content: Array<{ content: Array<{ attrs: Record<string, unknown> }> }> };
    };

    expect(result.body.content[0]?.content[0]?.attrs).toEqual({ id: ACCOUNT });
  });

  it('appends wiki-markup tokens on Server/DC', () => {
    const c = client('server');

    const result = appendMentions(c, { body: 'please review' }, [{ account: 'ada', display: 'Ada' }]) as {
      body: string;
    };

    expect(result.body).toBe('please review\n\n[~ada]');
  });

  it('returns the body untouched when there are no mentions', () => {
    const body = { body: 'unchanged' };

    expect(appendMentions(client('server'), body, [])).toBe(body);
  });
});
