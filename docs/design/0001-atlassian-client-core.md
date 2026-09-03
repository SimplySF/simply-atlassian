# 0001 — Atlassian client core (config, auth, HTTP)

**Status:** Draft
**Package:** `packages/simply-atlassian`
**Date:** 2026-09-03

## Problem

The repo is framework-only: oclif is wired up, but there is no way to talk to an Atlassian
instance. Every future command (`jira issue view`, `confluence page get`, ...) needs the same
three things before it can do anything useful:

1. **Configuration resolution** — where is the instance, and which credentials apply.
2. **Authentication** — Atlassian Cloud and Server/Data Center authenticate differently
   (Basic auth with email + API token vs. Bearer with a personal access token), and the two
   deployment types also expose different REST API versions.
3. **An HTTP layer** — JSON requests with timeouts, retry on transient failures, and errors that
   map cleanly onto oclif's error handling instead of raw stack traces.

Without a shared core, each command would reinvent these inconsistently. This doc designs the
shared module; individual commands get their own docs (0002+).

## Decision

Add a dependency-free client core at `packages/simply-atlassian/src/core/`, built on Node's
native `fetch`. No Atlassian SDK. Commands construct a `JiraClient` or `ConfluenceClient` from a
resolved config; each client owns an `HttpTransport` bound to its instance and knows which API
base (`/rest/api/3` vs `/rest/api/2`) and auth scheme the target deployment needs.

## Behavior

### Configuration resolution

Configuration comes from environment variables, overridable per-invocation by global flags
(flags win). Same contract as the widely used `mcp-atlassian` tooling, so credentials are
portable between the two:

| Env var                     | Applies to | Meaning                                             |
| --------------------------- | ---------- | --------------------------------------------------- |
| `JIRA_URL`                  | Jira       | Base URL of the instance                            |
| `JIRA_USERNAME`             | Jira Cloud | Email for Basic auth                                |
| `JIRA_API_TOKEN`            | Jira Cloud | API token for Basic auth                            |
| `JIRA_PERSONAL_TOKEN`       | Server/DC  | PAT for Bearer auth                                 |
| `JIRA_SSL_VERIFY`           | Jira       | Rejected if set to a false value (see below)        |
| `CONFLUENCE_URL`            | Confluence | Base URL (`/wiki` appended automatically for Cloud) |
| `CONFLUENCE_USERNAME`       | Cloud      | Email for Basic auth                                |
| `CONFLUENCE_API_TOKEN`      | Cloud      | API token for Basic auth                            |
| `CONFLUENCE_PERSONAL_TOKEN` | Server/DC  | PAT for Bearer auth                                 |
| `CONFLUENCE_SSL_VERIFY`     | Confluence | Rejected if set to a false value (see below)        |

Resolution rules:

- **Deployment detection:** a hostname ending in `.atlassian.net` is Cloud; anything else is
  Server/DC. Cloud requires username + API token; Server/DC requires a PAT. A mismatch (e.g.
  Cloud URL with only a PAT) is a configuration error naming the missing variable.
- **Cloud Confluence URL canonicalization:** `https://x.atlassian.net` →
  `https://x.atlassian.net/wiki` (the Cloud REST API lives under `/wiki`).
- **API version selection:** Jira Cloud uses `/rest/api/3` (search via `POST /search/jql` with
  `nextPageToken` pagination); Jira Server/DC uses `/rest/api/2` (search via `GET /search` with
  `startAt`/`maxResults`). Agile endpoints are `/rest/agile/1.0` on both. Confluence uses
  `/rest/api` on both. The client owns this mapping; commands never build API paths from
  deployment type.

### HTTP contract

- JSON in/out via Node's native `fetch`; `Accept`/`Content-Type` headers set automatically.
- 30 s default timeout per attempt, covering the **entire exchange including the response
  body** — a server that sends headers and then stalls mid-body still trips the deadline.
- Retry policy (3 attempts total, 500 ms exponential backoff base), decided in one place:
  - 429 and 5xx retry; a `Retry-After` header (delay-seconds or HTTP date, capped at 60 s)
    takes precedence over the computed backoff. Error bodies are drained before retrying so
    connections return to the pool.
  - Transient transport failures (connection reset/refused) retry.
  - Permanent failures never retry: 4xx other than 429, DNS misses (`ENOTFOUND`), untrusted
    certificates, and timeouts all fail immediately with a typed, explanatory error.
- **Certificate verification is always on, and there is no opt-out.** An instance behind an
  internal or agency CA is supported by trusting that CA — `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`
  — which keeps verification intact instead of removing it. A `*_SSL_VERIFY` set to a false
  value (carried over from other Atlassian tooling) raises a `ConfigError` naming that fix
  rather than being silently ignored, and a certificate failure at request time carries the
  same hint.

### Errors

A small typed hierarchy, mapped to oclif exit codes when a command surfaces them:

| Error          | Meaning                                                       | Exit code |
| -------------- | ------------------------------------------------------------- | --------- |
| `ConfigError`  | Missing/contradictory configuration                           | 2         |
| `AuthError`    | 401/403 from the instance                                     | 3         |
| `HttpError`    | Any other non-2xx (carries status + body)                     | 1         |
| `NetworkError` | The instance never answered: timeout, DNS, TLS trust, refused | 1         |

Commands catch these and re-throw through `this.error(message, { exit })` so users get oclif's
formatted error output, never a stack trace, for expected failure modes.

## Alternatives considered

- **`jira.js` / `confluence.js` SDKs** — typed and complete, but each is a large dependency
  surface for the handful of endpoints commands actually use, they lag behind Server/DC
  differences, and they'd own our auth behavior. Rejected: native `fetch` on Node ≥22 covers
  our needs with zero dependencies.
- **`axios` or `got`** — solve problems (interceptors, streams) we don't have. Rejected for the
  same reason.
- **Porting the client layer from `kaichen/atlassian-cli` (MIT)** — a working Bun+Commander CLI
  with the same env-var contract exists and its `src/core` + `src/services` layers are
  framework-agnostic. MIT→Apache-2.0 is license-compatible but requires retaining Kai Chen's
  copyright notice (a THIRD-PARTY/NOTICE entry). This repo was deliberately scaffolded without
  porting anything; whether to stay clean-room is an open question below. This design is
  written to be implementable either way — the _behavioral contract_ (env vars, deployment
  detection, API-version mapping) matches regardless.
- **Supporting `SSL_VERIFY=false` at all** — inherited from `mcp-atlassian` by way of
  `kaichen/atlassian-cli`, and dropped after review. Implemented process-wide (via
  `NODE_TLS_REJECT_UNAUTHORIZED=0`) it is a security defect: configuring it for a self-signed
  Jira DC silently disables certificate validation for every other host in the process,
  Confluence Cloud included. Implemented safely (a per-transport `undici` `Agent`) it costs a
  runtime dependency for a feature whose only real use case — an instance behind an internal CA
  — is better served by `NODE_EXTRA_CA_CERTS`, which keeps verification on. So the feature is
  gone, the dependency with it, and users who set the variable get an error naming the CA
  bundle fix.
- **A separate `packages/atlassian-core` package** — premature while there is one consumer.
  The module boundary inside `src/core/` keeps extraction cheap later.

## Implementation plan

All under `packages/simply-atlassian/src/core/`, in write order:

1. `errors.ts` — `ConfigError`, `AuthError`, `HttpError`.
2. `config.ts` — `resolveJiraConfig()` / `resolveConfluenceConfig()`: env + flag merging,
   deployment detection, URL canonicalization, validation.
3. `auth.ts` — `buildAuthHeaders(config)`: Basic vs. Bearer.
4. `http.ts` — `HttpTransport`, a class bound to one instance (base URL, auth headers, TLS
   policy, timing): `json<T>(call)` with full-exchange timeout, single-site retry policy, error
   triage, and the scoped insecure `Agent`.
5. `jira-client.ts` / `confluence-client.ts` — thin classes, each owning an `HttpTransport`,
   API-base selection, and pagination (including honouring the server's effective `maxResults`
   cap rather than the requested page size).

Notes for the implementer:

- Every file carries the repo's Apache-2.0 header (enforced by `header/header`).
- Pagination and retry loops will trip `no-await-in-loop`; sequential awaiting is the point
  there, so scoped `eslint-disable-next-line` with a reason is expected.
- `pnpm run build` in the package regenerates `command-snapshot.json` (no change expected —
  this doc adds no commands) and README regeneration is not needed for the same reason.

## Testing

Vitest, in `packages/simply-atlassian/test/core/`:

- **config**: Cloud vs. Server detection by hostname; missing-credential errors name the
  variable; flag-over-env precedence; Confluence `/wiki` canonicalization pins
  `https://x.atlassian.net` → `https://x.atlassian.net/wiki`.
- **auth**: Basic header is `base64(email:token)`; PAT produces `Bearer <token>`.
- **http**: against a local `node:http` server — success JSON round-trip; 401 → `AuthError`;
  404 → `HttpError` carrying status and body; `Retry-After` beats the computed backoff (timed);
  retry then success on a transient 503; timeout fires for both never-responds and
  stalls-mid-body; DNS misses fail fast as `NetworkError`; connection-refused retries then
  reports; a certificate failure names `NODE_EXTRA_CA_CERTS` in its message.
- **clients**: Jira Cloud client hits `/rest/api/3` and paginates with `nextPageToken`; Server
  client hits `/rest/api/2` with `startAt`; Confluence paths unaffected by deployment type.

## Open questions

- **Clean-room vs. port with attribution** — implement from this spec only, or adapt
  `kaichen/atlassian-cli`'s MIT client layer with a NOTICE entry? Clay decides; given the
  federal-client provenance story, clean-room is the safer default and this doc assumes it.
- **`.env` file support** (`--env-file` flag) — useful for local multi-instance work, but not
  needed by the core. Defer to a later doc if wanted.
- **Which commands land first** — proposed as 0002 (`jira issue view` / `jira issue search`),
  where output formatting (`--json` vs. human tables) gets designed.
