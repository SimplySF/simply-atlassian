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
resolved config; the client exposes typed request helpers and knows which API base
(`/rest/api/3` vs `/rest/api/2`) and auth scheme the target deployment needs.

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
| `JIRA_SSL_VERIFY`           | Jira       | `false` disables TLS certificate validation         |
| `CONFLUENCE_URL`            | Confluence | Base URL (`/wiki` appended automatically for Cloud) |
| `CONFLUENCE_USERNAME`       | Cloud      | Email for Basic auth                                |
| `CONFLUENCE_API_TOKEN`      | Cloud      | API token for Basic auth                            |
| `CONFLUENCE_PERSONAL_TOKEN` | Server/DC  | PAT for Bearer auth                                 |
| `CONFLUENCE_SSL_VERIFY`     | Confluence | `false` disables TLS certificate validation         |

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

- JSON in/out via native `fetch`; `Accept`/`Content-Type` headers set automatically.
- 30 s default timeout per request via `AbortController`.
- Transient failures (network errors, 429, 5xx) retry with exponential backoff (2 retries,
  500 ms base). A `Retry-After` header, when present on a 429, takes precedence over the
  computed backoff. 4xx responses other than 429 never retry.
- `SSL_VERIFY=false` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide. Node's `fetch` has no
  per-request TLS option (Bun-style `tls` init keys are silently ignored), and a CLI invocation
  talks to exactly one configured host, so the process-wide switch is acceptable. The helper
  is idempotent and lives in one place so the trade-off is documented once.

### Errors

A small typed hierarchy, mapped to oclif exit codes when a command surfaces them:

| Error         | Meaning                                   | Exit code |
| ------------- | ----------------------------------------- | --------- |
| `ConfigError` | Missing/contradictory configuration       | 2         |
| `AuthError`   | 401/403 from the instance                 | 3         |
| `HttpError`   | Any other non-2xx (carries status + body) | 1         |

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
- **Per-request TLS control via an `undici` `Agent` dispatcher** — more surgical than the
  process-wide env var, but adds `undici` as a runtime dependency solely for the escape hatch,
  and the global dispatcher still leaks process-wide. Rejected; revisit if the CLI ever talks
  to multiple hosts in one invocation.
- **A separate `packages/atlassian-core` package** — premature while there is one consumer.
  The module boundary inside `src/core/` keeps extraction cheap later.

## Implementation plan

All under `packages/simply-atlassian/src/core/`, in write order:

1. `errors.ts` — `ConfigError`, `AuthError`, `HttpError`.
2. `config.ts` — `resolveJiraConfig()` / `resolveConfluenceConfig()`: env + flag merging,
   deployment detection, URL canonicalization, validation.
3. `auth.ts` — `buildAuthHeaders(config)`: Basic vs. Bearer.
4. `http.ts` — `requestJson<T>()` with timeout/retry/`Retry-After`, plus the idempotent
   `disableTlsVerification()` helper.
5. `jira-client.ts` / `confluence-client.ts` — thin classes binding a resolved config to
   `requestJson`, owning API-base selection and pagination helpers.

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
  404 → `HttpError` carrying status and body; 429 with `Retry-After` respected; retry then
  success on a transient 503; timeout aborts.
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
