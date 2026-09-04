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
import { AuthError, HttpError, NetworkError } from '../../src/core/errors.js';
import { HttpTransport, type TransportTarget } from '../../src/core/http.js';
import { respondJson, startTestServer, type TestServer } from './support.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function transport(overrides: Partial<TransportTarget> = {}): HttpTransport {
  return new HttpTransport({ baseUrl: server.baseUrl, headers: {}, ...overrides });
}

describe('HttpTransport', () => {
  it('round-trips JSON and sends Accept/Content-Type headers', async () => {
    server.route('/echo', (req, res, body) => {
      respondJson(res, 200, {
        accept: req.headers.accept,
        contentType: req.headers['content-type'],
        received: body ? (JSON.parse(body) as unknown) : undefined,
      });
    });

    const result = await transport().json<{ accept: string; contentType: string; received: unknown }>({
      method: 'POST',
      path: '/echo',
      body: { hello: 'world' },
    });

    expect(result.accept).toBe('application/json');
    expect(result.contentType).toBe('application/json');
    expect(result.received).toEqual({ hello: 'world' });
  });

  it('serializes query params and drops undefined values', async () => {
    server.route('/query', (req, res) => {
      respondJson(res, 200, { url: req.url });
    });

    const result = await transport().json<{ url: string }>({
      method: 'GET',
      path: '/query',
      query: { jql: 'project = X', startAt: 0, skipped: undefined },
    });

    expect(result.url).toBe('/query?jql=project+%3D+X&startAt=0');
  });

  it('preserves the base URL path segment (the Confluence /wiki case)', async () => {
    server.route('/wiki/rest/api/content/1', (_req, res) => {
      respondJson(res, 200, { ok: true });
    });

    const wiki = new HttpTransport({ baseUrl: `${server.baseUrl}/wiki`, headers: {} });
    await expect(wiki.json({ method: 'GET', path: '/rest/api/content/1' })).resolves.toEqual({ ok: true });
  });

  it('maps 401 to AuthError without retrying', async () => {
    server.route('/secure', (_req, res) => {
      respondJson(res, 401, { message: 'nope' });
    });

    await expect(transport().json({ method: 'GET', path: '/secure' })).rejects.toBeInstanceOf(AuthError);
    expect(server.requests).toHaveLength(1);
  });

  it('mentions write scope on a 403 only when the call declares itself mutating', async () => {
    // Found in review: gating on the HTTP verb fired this on Jira Cloud's issue search, which
    // is a POST. An agent reading "use a credential with write scope" after an ordinary search
    // failure would swap in the write credential and escalate its own privileges.
    server.route('/forbidden', (_req, res) => {
      respondJson(res, 403, { message: 'no permission' });
    });

    const readByPost = await transport()
      .json({ method: 'POST', path: '/forbidden' })
      .catch((caught: unknown) => caught);
    const write = await transport()
      .json({ method: 'POST', path: '/forbidden', mutating: true })
      .catch((caught: unknown) => caught);

    expect((readByPost as AuthError).message).not.toContain('write scope');
    expect((write as AuthError).message).toContain('write scope');
  });

  it('maps a non-retryable 4xx to HttpError with status and body, without retrying', async () => {
    server.route('/missing', (_req, res) => {
      respondJson(res, 404, { message: 'not found' });
    });

    const error = await transport()
      .json({ method: 'GET', path: '/missing' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).body).toEqual({ message: 'not found' });
    expect(server.requests).toHaveLength(1);
  });

  it('retries a transient 503 and succeeds', async () => {
    let calls = 0;
    server.route('/flaky', (_req, res) => {
      calls += 1;
      if (calls === 1) {
        respondJson(res, 503, { message: 'warming up' }, { 'retry-after': '0' });
      } else {
        respondJson(res, 200, { ok: true });
      }
    });

    await expect(transport().json({ method: 'GET', path: '/flaky' })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('prefers Retry-After over the computed backoff on 429', async () => {
    let calls = 0;
    server.route('/limited', (_req, res) => {
      calls += 1;
      if (calls === 1) {
        respondJson(res, 429, { message: 'slow down' }, { 'retry-after': '0' });
      } else {
        respondJson(res, 200, { ok: true });
      }
    });

    const startedAt = Date.now();
    await expect(transport().json({ method: 'GET', path: '/limited' })).resolves.toEqual({ ok: true });
    const elapsed = Date.now() - startedAt;

    expect(calls).toBe(2);
    // The computed backoff for the first retry is 500 ms; a Retry-After of 0 must beat it.
    expect(elapsed).toBeLessThan(450);
  });

  it('gives up after exhausting attempts on persistent 5xx', async () => {
    server.route('/down', (_req, res) => {
      respondJson(res, 500, { message: 'boom' }, { 'retry-after': '0' });
    });

    const error = await transport({ maxAttempts: 2 })
      .json({ method: 'GET', path: '/down' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(500);
    expect(server.requests).toHaveLength(2);
  });

  it('times out when the server never sends headers, as a NetworkError naming the duration', async () => {
    server.route('/slow', () => {
      // Never respond; the deadline has to fire.
    });

    const error = await transport({ timeoutMs: 100, maxAttempts: 1 })
      .json({ method: 'GET', path: '/slow' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toContain('100 ms');
  });

  it('times out when the server stalls mid-body — the deadline covers the body read', async () => {
    server.route('/drip', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      // Never finish the body; only a body-spanning deadline can save the caller.
    });

    const error = await transport({ timeoutMs: 150, maxAttempts: 1 })
      .json({ method: 'GET', path: '/drip' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkError);
  });

  it('fails fast on an unresolvable host instead of walking the retry ladder', async () => {
    const unreachable = new HttpTransport({ baseUrl: 'http://nonexistent-host.invalid', headers: {} });

    const error = await unreachable.json({ method: 'GET', path: '/anything' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toContain('ENOTFOUND');
  });

  it('retries transient connection failures and reports a NetworkError when they persist', async () => {
    const closedBase = server.baseUrl;
    await server.close();
    server = await startTestServer(); // keep afterEach happy

    const refused = new HttpTransport({ baseUrl: closedBase, headers: {}, maxAttempts: 2 });
    const error = await refused.json({ method: 'GET', path: '/gone' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toContain('2 attempts');
  });

  it('treats an empty body as an empty object', async () => {
    server.route('/empty', (_req, res) => {
      res.writeHead(204);
      res.end();
    });

    await expect(transport().json({ method: 'GET', path: '/empty' })).resolves.toEqual({});
  });

  it('raises HttpError for malformed JSON instead of retrying forever', async () => {
    server.route('/garbled', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    });

    const error = await transport()
      .json({ method: 'GET', path: '/garbled' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(server.requests).toHaveLength(1);
  });
});
