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

import { AuthError, CliError, HttpError, NetworkError } from './errors.js';

export type QueryValue = string | number | boolean | undefined;

/** One REST call, relative to the transport's base URL. */
export interface JsonCall {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
}

/** Where and how a transport talks: fixed per client instance. */
export interface TransportTarget {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const RETRY_AFTER_CAP_MS = 60_000;

/** Certificate problems: the trust store is wrong, so retrying changes nothing. */
const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Transport failures another attempt cannot fix: the host or the trust decision is wrong. */
const PERMANENT_TRANSPORT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', ...CERT_CODES]);

/** What one attempt concluded: a parsed value, or a retryable failure that knows its own delay. */
type AttemptOutcome<T> = { done: true; value: T } | { done: false; delayMs?: number; exhausted: () => HttpError };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Digs the syscall-level error code out of however deeply the runtime wrapped it. */
function transportCode(error: unknown): string | undefined {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause as Error) {
    const code = (cursor as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isAbort(error: unknown): boolean {
  // Deliberately not `instanceof Error`: fetch aborts reject with a DOMException, which isn't one.
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * JSON-over-HTTPS transport bound to one Atlassian instance. Each client owns one; everything
 * that would otherwise be an argument (base URL, auth headers, timing) is fixed at construction
 * so call sites stay small.
 *
 * Certificate verification is always on. An instance behind an internal or agency CA is
 * supported by pointing Node at that CA — `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` — which keeps
 * verification intact rather than turning it off.
 */
export class HttpTransport {
  private readonly target: TransportTarget;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  public constructor(target: TransportTarget) {
    this.target = target;
    this.timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = target.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Executes a call and parses the JSON response. 401/403 become `AuthError` immediately;
   * 429/5xx retry with exponential backoff, deferring to a (capped) `Retry-After` when one is
   * sent; other non-2xx become `HttpError`. Timeouts, DNS misses, and certificate failures
   * become `NetworkError` without pointless retries; transient socket failures retry. The
   * timeout covers the whole exchange, response body included.
   */
  public async json<T>(call: JsonCall): Promise<T> {
    const url = this.resolve(call);

    /* Each attempt must observe the previous one's outcome before starting — sequential awaiting
       is the mechanism, not an accident. */
    /* eslint-disable no-await-in-loop */
    for (let attempt = 1; ; attempt += 1) {
      let outcome: AttemptOutcome<T>;
      try {
        outcome = await this.attempt<T>(url, call);
      } catch (error) {
        const verdict = this.triage(error, call, url, attempt);
        if (verdict !== TRANSIENT) throw verdict;
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (outcome.done) return outcome.value;
      if (attempt >= this.maxAttempts) throw outcome.exhausted();
      await delay(outcome.delayMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    /* eslint-enable no-await-in-loop */
  }

  /** Runs one attempt under a deadline that spans connection, headers, AND body. */
  private async attempt<T>(url: URL, call: JsonCall): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...this.target.headers };
      if (call.body !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetch(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new AuthError(
          `Authentication failed: ${call.method} ${call.path} returned ${response.status}.${await describeBody(response)}`,
          response.status,
        );
      }

      if (response.ok) {
        const text = await response.text();
        if (text.trim() === '') return { done: true, value: {} as T };
        try {
          return { done: true, value: JSON.parse(text) as T };
        } catch {
          throw new HttpError(`${call.method} ${call.path} returned malformed JSON.`, response.status, text);
        }
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = readRetryAfter(response.headers.get('retry-after'));
        const status = response.status;
        const detail = await describeBody(response);
        return {
          done: false,
          delayMs: retryAfter,
          exhausted: () => new HttpError(`${call.method} ${call.path} failed (${status}).${detail}`, status),
        };
      }

      const body = await bodyAsJsonOrText(response);
      throw new HttpError(
        `${call.method} ${call.path} failed (${response.status}).${formatSnippet(body)}`,
        response.status,
        body,
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Wraps raw transport failures in typed, user-explainable errors; rethrows deliberate ones. */
  private triage(error: unknown, call: JsonCall, url: URL, attempt: number): CliError | typeof TRANSIENT {
    if (error instanceof CliError) return error;

    if (isAbort(error)) {
      return new NetworkError(
        `${call.method} ${call.path} did not complete within ${this.timeoutMs} ms (${url.host}).`,
      );
    }

    const code = transportCode(error);
    if (code !== undefined && PERMANENT_TRANSPORT_CODES.has(code)) {
      const hint = CERT_CODES.has(code)
        ? ` The certificate could not be verified. If ${url.host} is behind an internal or agency CA, point Node at that CA bundle with NODE_EXTRA_CA_CERTS=/path/to/ca.pem.`
        : '';
      return new NetworkError(`Cannot reach ${url.host}: ${code}.${hint}`);
    }

    if (attempt < this.maxAttempts) {
      // Transient transport failure (connection reset, refused, mid-flight drop): try again.
      return TRANSIENT;
    }

    const description = code ?? (error instanceof Error ? error.message : String(error));
    return new NetworkError(`${call.method} ${call.path} failed after ${attempt} attempts: ${description}.`);
  }

  private resolve(call: JsonCall): URL {
    const url = new URL(this.target.baseUrl);
    const root = url.pathname.replace(/\/+$/, '');
    url.pathname = call.path.startsWith('/') ? `${root}${call.path}` : `${root}/${call.path}`;
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url;
  }
}

/** Sentinel: the triage step decided this attempt's failure is worth another try. */
const TRANSIENT = Symbol('transient-transport-failure');

/** `Retry-After` arrives as delay-seconds or an HTTP date; both are capped so a hostile value can't park the CLI. */
function readRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
}

/** Drains an error response and renders a short human-readable suffix, never throwing. */
async function describeBody(response: Response): Promise<string> {
  return formatSnippet(await bodyAsJsonOrText(response));
}

async function bodyAsJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatSnippet(body: unknown): string {
  if (body === undefined) return '';
  const rendered = typeof body === 'string' ? body : JSON.stringify(body);
  return rendered === '' ? '' : ` ${rendered}`;
}
