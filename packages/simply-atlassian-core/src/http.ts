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

import { AuthError, CliError, HttpError, NetworkError } from './errors.js';
import { stripControlOneLine } from './text.js';

/** An array repeats the parameter once per value, as `?accountId=a&accountId=b`. */
export type QueryValue = string | number | boolean | readonly string[] | undefined;

/** One REST call, relative to the transport's base URL. */
export interface JsonCall {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  /**
   * Whether this call changes data. Declared by the caller rather than guessed from the verb,
   * because the verb is not a reliable signal: Jira Cloud's issue search is a POST. Guessing
   * wrong here is worse than not guessing — see the 403 handling below.
   */
  readonly mutating?: boolean;
}

/**
 * A read whose body is handed back unread, for files. Never `mutating`: a stream is restarted
 * from the beginning when it fails, which is only safe for a read.
 */
export type StreamCall = Pick<JsonCall, 'method' | 'path' | 'query'>;

export interface StreamOptions {
  /**
   * How long the body may go without sending a byte before it is abandoned. The transport's
   * timeout covers only the wait for headers here: a whole-exchange deadline would cut off any
   * large file on a slow link, however steadily it was arriving.
   */
  readonly idleTimeoutMs?: number;
}

/** A response whose headers have arrived and whose body has not been read. */
export interface StreamResponse {
  /** Iterate once. Stopping early, or a failure, cancels the request. */
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType?: string;
  readonly contentLength?: number;
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

/**
 * Transport failures that prove the request never reached the instance, so a write may retry
 * them. Every other mid-flight failure — a reset, a dropped socket — can land after the
 * instance has acted.
 */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED']);

/** Appended when a write fails in a way that does not say whether the instance applied it. */
const MAY_HAVE_APPLIED = ' The change may have been applied; check before retrying.';

/**
 * What one attempt concluded: a parsed value, or a failure that knows its own delay and whether
 * another attempt is safe.
 */
type AttemptOutcome<T> =
  { done: true; value: T } | { done: false; delayMs?: number; retryable: boolean; exhausted: () => HttpError };

/** How one kind of call reads a successful response; everything before that is shared. */
interface Exchange<T> {
  readonly accept: string;
  readonly redirect: NonNullable<RequestInit['redirect']>;
  readonly read: (response: Response, controller: AbortController) => Promise<T>;
}

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
   *
   * A `mutating` call retries only what proves the instance did not act — a 429, or a connection
   * that was refused outright. A 5xx or a dropped connection can follow a write the instance
   * already applied (a gateway giving up on a slow backend), and repeating it would create a
   * second issue or comment, so those fail at once and say the change may have landed.
   */
  public async json<T>(call: JsonCall): Promise<T> {
    return this.execute(call, {
      accept: 'application/json',
      redirect: 'follow',
      read: async (response): Promise<T> => {
        const text = await response.text();
        if (text.trim() === '') return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(`${call.method} ${call.path} returned malformed JSON.`, response.status, text);
        }
      },
    });
  }

  /**
   * Executes a read and resolves as soon as the response headers arrive, with the body unread.
   * Everything up to the headers — auth mapping, retries, the timeout — is what `json` does.
   * Redirects are not followed: a file is fetched from the configured instance or not at all,
   * so a `3xx` is an `HttpError`. A body that stalls past `idleTimeoutMs`, or drops mid-way,
   * fails with a `NetworkError` while being iterated; restarting it is the caller's decision.
   */
  public async stream(call: StreamCall, options: StreamOptions = {}): Promise<StreamResponse> {
    const idleTimeoutMs = options.idleTimeoutMs ?? this.timeoutMs;
    return this.execute(call, {
      accept: '*/*',
      redirect: 'manual',
      read: (response, controller): Promise<StreamResponse> => {
        const length = Number(response.headers.get('content-length') ?? Number.NaN);
        return Promise.resolve({
          body: guardBody(response.body, controller, idleTimeoutMs, call),
          contentType: response.headers.get('content-type') ?? undefined,
          contentLength: Number.isSafeInteger(length) && length >= 0 ? length : undefined,
        });
      },
    });
  }

  private async execute<T>(call: JsonCall, exchange: Exchange<T>): Promise<T> {
    const url = this.resolve(call);

    /* Each attempt must observe the previous one's outcome before starting — sequential awaiting
       is the mechanism, not an accident. */
    /* eslint-disable no-await-in-loop */
    for (let attempt = 1; ; attempt += 1) {
      let outcome: AttemptOutcome<T>;
      try {
        outcome = await this.attempt(url, call, exchange);
      } catch (error) {
        const verdict = this.triage(error, call, url, attempt);
        if (verdict !== TRANSIENT) throw verdict;
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (outcome.done) return outcome.value;
      if (!outcome.retryable || attempt >= this.maxAttempts) throw outcome.exhausted();
      await delay(outcome.delayMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    /* eslint-enable no-await-in-loop */
  }

  /**
   * Runs one attempt under a deadline. For `json` it spans connection, headers, AND body; for
   * `stream` it ends at the headers, and the body's idle timer takes over.
   */
  private async attempt<T>(url: URL, call: JsonCall, exchange: Exchange<T>): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: exchange.accept, ...this.target.headers };
      if (call.body !== undefined) headers['Content-Type'] = 'application/json';

      const response = await fetch(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        redirect: exchange.redirect,
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        const detail = await describeBody(response);
        // A 403 on a call that really does change data is often a credential that can read but
        // not write, so naming that possibility saves a confusing hunt. It is phrased as an
        // observation rather than an instruction, and gated on the caller's declared intent:
        // an agent reading "use a credential with write scope" after an ordinary search
        // failure would escalate its own privileges, defeating the one boundary that binds.
        const hint = response.status === 403 && call.mutating === true ? ' This credential may lack write scope.' : '';
        throw new AuthError(
          `Authentication failed: ${call.method} ${call.path} returned ${response.status}.${detail}${hint}`,
          response.status,
        );
      }

      if (response.ok) return { done: true, value: await exchange.read(response, controller) };

      if (response.status >= 300 && response.status < 400) {
        // Only a call that declined to follow redirects sees one. The Location is not quoted:
        // it is server-controlled, and where it pointed is not something to act on.
        await response.body?.cancel();
        throw new HttpError(
          `${call.method} ${call.path} was redirected (${response.status}) instead of answering. ` +
            'On Server/DC this usually means the credential was not accepted for this path.',
          response.status,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = readRetryAfter(response.headers.get('retry-after'));
        const status = response.status;
        const detail = await describeBody(response);
        // A 429 is refused before any work is done; a 5xx may follow a write that landed.
        const retryable = call.mutating !== true || status === 429;
        const hint = retryable ? '' : MAY_HAVE_APPLIED;
        return {
          done: false,
          delayMs: retryAfter,
          retryable,
          exhausted: () => new HttpError(`${call.method} ${call.path} failed (${status}).${detail}${hint}`, status),
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

    const unsure = call.mutating === true ? MAY_HAVE_APPLIED : '';

    if (isAbort(error)) {
      return new NetworkError(
        `${call.method} ${call.path} did not complete within ${this.timeoutMs} ms (${url.host}).${unsure}`,
      );
    }

    const code = transportCode(error);
    if (code !== undefined && PERMANENT_TRANSPORT_CODES.has(code)) {
      const hint = CERT_CODES.has(code)
        ? ` The certificate could not be verified. If ${url.host} is behind an internal or agency CA, point Node at that CA bundle with NODE_EXTRA_CA_CERTS=/path/to/ca.pem.`
        : '';
      return new NetworkError(`Cannot reach ${url.host}: ${code}.${hint}`);
    }

    const description = code ?? (error instanceof Error ? error.message : String(error));

    if (call.mutating === true && (code === undefined || !NEVER_SENT_CODES.has(code))) {
      // The request may have reached the instance before the connection dropped: never repeat it.
      return new NetworkError(`${call.method} ${call.path} failed: ${description}.${unsure}`);
    }

    if (attempt < this.maxAttempts) {
      // Transient transport failure (connection reset, refused, mid-flight drop): try again.
      return TRANSIENT;
    }

    return new NetworkError(`${call.method} ${call.path} failed after ${attempt} attempts: ${description}.`);
  }

  private resolve(call: JsonCall): URL {
    const url = new URL(this.target.baseUrl);
    const root = url.pathname.replace(/\/+$/, '');
    url.pathname = call.path.startsWith('/') ? `${root}${call.path}` : `${root}/${call.path}`;
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value as readonly string[]) url.searchParams.append(name, item);
      } else if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    return url;
  }
}

/** Sentinel: the triage step decided this attempt's failure is worth another try. */
const TRANSIENT = Symbol('transient-transport-failure');

/**
 * Yields a response body chunk by chunk, abandoning it after `idleMs` without a byte. Every way
 * out — the end, a failure, or the caller stopping early — aborts the request, so an unfinished
 * body never holds a socket open.
 */
async function* guardBody(
  body: ReadableStream<Uint8Array> | null,
  controller: AbortController,
  idleMs: number,
  call: StreamCall,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  let idle: NodeJS.Timeout | undefined;
  try {
    /* Chunks arrive in order; each read has to wait for the one before it. */
    /* eslint-disable no-await-in-loop */
    for (;;) {
      clearTimeout(idle);
      idle = setTimeout(() => {
        controller.abort();
      }, idleMs);
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAbort(error)) {
          throw new NetworkError(`${call.method} ${call.path} sent no data for ${idleMs} ms and was abandoned.`);
        }
        const description = transportCode(error) ?? (error instanceof Error ? error.message : String(error));
        throw new NetworkError(`${call.method} ${call.path} failed while reading the response: ${description}.`);
      }
      if (chunk.done) return;
      yield chunk.value;
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    clearTimeout(idle);
    controller.abort();
  }
}

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

/**
 * Renders a response body into an error message, on one line.
 *
 * This is the only point where wholly server-controlled text joins an error message, so it is
 * where the newline has to go — not at the assembled message, which also carries this CLI's own
 * deliberate line structure. A multi-line body would otherwise forge extra stderr lines,
 * including one shaped like this CLI's JSON error object, which a caller parsing stderr
 * line-by-line could not tell from the real thing.
 */
function formatSnippet(body: unknown): string {
  if (body === undefined) return '';
  const rendered = stripControlOneLine(typeof body === 'string' ? body : JSON.stringify(body));
  return rendered === '' ? '' : ` ${rendered}`;
}
