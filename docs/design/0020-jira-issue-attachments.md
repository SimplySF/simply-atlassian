# 0020 — Reading Jira issue attachments

**Status:** In progress
**Package:** `packages/simply-atlassian-core`, `packages/simply-atlassian`, `packages/simply-atlassian-mcp`
**Date:** 2026-10-22

## Problem

Nothing reads a file attached to an issue. `issue view --json --fields attachment` returns Jira's
attachment metadata, including a `content` URL, but a person then has to download that URL with
their own authenticated request, and an agent using the MCP server cannot do so at all. Attachments
are often the substance of a ticket: the log that shows the failure, the screenshot of the bug, the
spreadsheet of affected records. An agent asked to triage an issue sees only its text.

The transport cannot help as it stands. `HttpTransport.json` sends `Accept: application/json`,
buffers and parses every 2xx body as JSON, treats an empty body as `{}`, and applies one deadline
to the whole exchange, so it cannot return a file, let alone a large one.

## Decision

Add an `issue attachment` subtopic with two read-only commands:

- `atlassian jira issue attachment list <issue>` lists an issue's attachments.
- `atlassian jira issue attachment download <issue>` streams some or all of them to a local
  directory, or one of them to stdout. There is no size limit.

Core gains `JiraClient.getAttachments(issueKey)` and `JiraClient.openAttachment(attachment)`, and
the transport gains `HttpTransport.stream`, which shares `json`'s retry and error handling up to the
response headers and then hands back the body unread. File naming, the streamed write to disk, and
the bounded in-memory read the MCP server needs live in core in a new `jira-attachments.ts`, as the
Xray field record's atomic write already does in `xray-fields.ts`. Nothing in core touches a
terminal.

The MCP server exposes both commands as `jira_issue_attachment_list` and
`jira_issue_attachment_download`. The download tool never takes a path from the agent. It does one
of three things:

1. Returns a small text or image file's content in the result, so the agent can read it.
2. Asks **the user**, through MCP elicitation, for a folder to save the file in. It does this when
   the file cannot be returned inline, or when the agent asks to save it. The file is then streamed
   there, with the CLI's naming and no-overwrite rules.
3. Otherwise, returns a browser link the user can open to download the file themselves.

Every result carries the browser link. Returning content blocks other than the server's single JSON
`text` block, and asking the user a question mid-call, are both new to the server (see [MCP](#mcp)).

All of this is reads of the instance. Uploading and deleting attachments are writes and are left for
a later document (see open questions).

### Endpoints

| Step                  | Cloud                                                    | Server/DC                                                            |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| List an issue's files | `GET /rest/api/3/issue/{key}?fields=attachment`          | `GET /rest/api/2/issue/{key}?fields=attachment`                      |
| Download one file     | `GET /rest/api/3/attachment/content/{id}?redirect=false` | `GET /secure/attachment/{id}/{filename}`, on the configured base URL |
| Browser link          | `{base}/rest/api/3/attachment/content/{id}`              | `{base}/secure/attachment/{id}/{filename}`                           |

Why each one:

- **Listing through the issue.** Neither deployment has a "list attachments of an issue"
  endpoint; the `attachment` field of the issue is the list. Asking for that field alone keeps
  the response small. It also confirms the issue is readable before any download starts, and lets
  `download` check that a requested attachment id belongs to the named issue.
- **Cloud `redirect=false`.** By default the content endpoint answers `303` to a media host
  outside the configured site. `redirect=false` makes Jira return the bytes itself, so every
  request stays on the configured base URL and goes through the same transport. This follows the
  same rule as 0019's refusal to follow `_links.next` as a URL.
- **Server/DC `/secure/attachment`.** Server/DC has no REST endpoint for attachment content in
  any REST reference from 8.x to 10.x; the attachment's own `content` field points here. The
  client builds the path from the attachment's id and filename rather than using the
  server-supplied `content` URL, for the same reason as above.
- **The browser link** is the same path without `redirect=false`, built on the configured base URL.
  Opened in a browser where the user is signed in to Jira, it downloads the file under that
  session. On its own it grants nothing, so it is safe to put in an agent's context.

The content call sends `Accept: */*`, because Cloud refuses `application/json` for a binary
response with `406`. It sets fetch's `redirect: 'manual'`, and any `3xx` becomes an `HttpError`.
On Cloud a redirect is unexpected once `redirect=false` is set. On Server/DC a `302` to the login
page means the credential was not accepted for this path, and the message says so.

### Streaming

`HttpTransport.stream(call, { idleTimeoutMs })` resolves once response headers arrive, returning
`{ body, contentType?, contentLength? }`. Up to that point it behaves as `json` does: the same
401/403 mapping, the same retries for 429, 5xx and transient connection failures, and the transport
timeout as the deadline for the headers. After that, a single whole-exchange deadline would cut off
any large file on a slow link, so the body is governed by an idle timeout instead: no bytes for
30 seconds aborts it. A download that keeps making progress can take as long as it needs.

Core's `saveAttachment(client, attachment, file, { overwrite? })` streams the body to a temporary
file beside `file`, opened with `wx` so it can never replace anything, checks the byte count
against the size Jira listed, and renames the file into place. If the body fails part-way, or the
count does not match, the temporary file is deleted. A body that drops or stalls (a `NetworkError`
while reading) restarts that file from the beginning, up to three attempts in all. A failure before
the headers is not restarted here, because the transport has already retried it, and an
`HttpError` or a size mismatch is not restarted at all. A restart is safe because the request only
reads. No partial file is ever left under the real name. Without `overwrite`, the file is checked
again just before the rename, so a file that appeared during the download is left alone.

`readAttachment(client, attachment, maxBytes)` is the bounded read the MCP server uses for inline
content. It reads into memory and stops reading, which cancels the request, once `maxBytes` is
exceeded. That covers the case where Jira's listed size is wrong.

## Behavior

```
atlassian jira issue attachment list PROJ-123
atlassian jira issue attachment download PROJ-123
atlassian jira issue attachment download PROJ-123 --id 10234,10235 --output-dir ./evidence
atlassian jira issue attachment download PROJ-123 --id 10234 --stdout | less
```

### `attachment list`

| Input     | Meaning               |
| --------- | --------------------- |
| `<issue>` | Issue key, `PROJ-123` |

**Human output** is a table in the order Jira returns, which is upload order:

```
ID     FILENAME          SIZE     TYPE        AUTHOR        CREATED
─────  ────────────────  ───────  ──────────  ────────────  ──────────
10234  server.log        1.2 MiB  text/plain  Ada Lovelace  2026-10-18
10235  screenshot.png    84 KiB   image/png   Grace Hopper  2026-10-19

2 attachment(s).
```

`SIZE` uses binary units (`B`, `KiB`, `MiB`, `GiB`) to one decimal place, and `--json` carries the
exact byte count. `CREATED` is the date, as in `comment list`. Empty cells show `—`. The filename,
type and author go through the table's control-character stripping. An issue with no attachments
prints `No attachments on PROJ-123.` and exits 0, as `remotelink list` does.

**`--json`** returns the instance's own `attachment` array, unsanitized, as `issue view --json`
would. Its shape differs between deployments: Cloud identifies the author by `accountId` and
Server/DC by `name`.

### `attachment download`

| Input              | Meaning                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `<issue>`          | Issue key, `PROJ-123`                                                                           |
| `--id`             | Attachment ids to download, comma-separated or repeated. Default: every attachment on the issue |
| `--output-dir, -o` | Directory to write into. Default: the current directory. Created if missing                     |
| `--overwrite`      | Replace files that already exist. Without it, an existing file is an error                      |
| `--stdout`         | Stream the one selected attachment's bytes to stdout instead of a file                          |

The command resolves everything before downloading anything:

1. Read the issue's attachment list.
2. Check that each `--id` belongs to the issue. An unknown id exits 1 and names the id. It is not
   skipped, because a typo would otherwise look like success.
3. Work out every target filename (see below) and check none exists unless `--overwrite` is set.
   A collision exits 1, lists every colliding path, and downloads nothing.
4. Stream each file to disk in list order, as described under [Streaming](#streaming).

Progress goes to stderr, one line per file (`downloaded server.log (1.2 MiB)`), and a summary
follows: `Downloaded 2 attachment(s) to ./evidence.` A failure part-way through exits with that
error's code. Files already written stay on disk, and the error names how many were written first.

**File names.** An attachment's filename is chosen by whoever uploaded it, so it is never used as a
path as-is:

| Input                                                                          | Handling                                                   |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `/`, `\`, and a leading `.` or `..`                                            | Path separators become `_`; leading dots are removed       |
| Control characters, and `< > : " \| ? *`                                       | Replaced with `_`, so a name is valid on Windows and POSIX |
| Trailing dots or spaces                                                        | Removed (Windows silently drops them)                      |
| Windows reserved names (`CON`, `NUL`, `COM1`, …), with or without an extension | Prefixed with `_`                                          |
| Longer than 180 characters                                                     | Shortened, keeping the extension                           |
| Empty after the above                                                          | `attachment-<id>`                                          |
| Two selected attachments with the same resulting name, ignoring case           | Each becomes `<stem> (<id>)<ext>`                          |

Jira allows several attachments with the same name on one issue, which is why duplicates are
renamed rather than treated as errors. Names are compared ignoring case because the default file
systems on Windows and macOS do. The 180-character limit leaves room under the usual 255-byte limit
for the `(<id>)` suffix and the temporary file's suffix. After sanitizing, the resolved path is checked to be
directly inside `--output-dir`, and the command refuses to write anywhere else. This is a second
guard, not the main one.

**`--stdout`** requires exactly one selected attachment. Selecting none or several exits 2. It
streams the raw bytes and nothing else to stdout, and the progress line still goes to stderr. A
transient failure cannot be retried once bytes have reached stdout, so here a failed body exits 1
and says the output is incomplete. When stdout is a terminal, the command refuses and exits 2: an
attachment's bytes can contain escape sequences, and every other path in this CLI strips control
characters before they reach a terminal. Pipe or redirect it instead. `--stdout` with
`--output-dir` or `--overwrite` exits 2.

**`--json`** returns `{ directory, files: [{ id, filename, path, size, mimeType }] }`. `filename`
is Jira's name and `path` is where it was written. Under `--stdout`, `--json` exits 2, because
stdout cannot carry both the file and the envelope.

**`ATLASSIAN_READ_ONLY`** does not affect either command. They read from the instance, and the only
thing they change is a local file the caller named.

**Errors** use the existing mapping. An unknown or unreadable issue is the instance's 404, which
exits 1. An attachment deleted between the list and the download is a 404 for that file, and the command
stops there. Cloud reports `403` when attachments are disabled on the site, which surfaces as the
usual `AuthError` (exit 3) with Jira's message.

### MCP

| Tool                             | Input                                     | Result                                                    |
| -------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `jira_issue_attachment_list`     | `{ issue }`                               | One `text` block: the `--json` array of `attachment list` |
| `jira_issue_attachment_download` | `{ issue, id, save? }`: one attachment id | Content blocks, below                                     |

Both are `read` kind, so both are registered without `--allow-writes`: neither changes anything in
Jira. `jira_issue_attachment_download` can write a local file, but only to a folder the user typed
in, so it carries `readOnlyHint: false` and `idempotentHint: false` rather than the read kind's
usual annotations. That needs a per-tool `annotations` override on `ToolSpec`, which no tool has
had before.

The download tool checks that `id` belongs to `issue`, as the CLI does. Its first block is always a
`text` block of metadata:

```ts
{ id, filename, mimeType, size, browserUrl, returned: boolean, saved: boolean, path?, reason? }
```

What follows depends on the file and on `save`:

| Case                                                                        | What the tool does                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `save` not set, and the file is readable text of 1 MiB or less              | A second `text` block holding the contents; `returned: true`         |
| `save` not set, and the file is a PNG, JPEG, GIF or WebP of 5 MiB or less   | A second `image` block, base64, with its MIME type; `returned: true` |
| Anything else, or `save: true`, and the client supports elicitation         | Asks the user for a folder (below)                                   |
| Anything else, or `save: true`, and the client does not support elicitation | Metadata only, with a `reason` pointing at `browserUrl` and the CLI  |

"Readable text" means a `text/*`, `application/json`, `application/xml`, `application/yaml` or
`application/x-ndjson` type whose bytes decode as UTF-8. Jira's `mimeType` is the uploader's
browser's guess, so the type check is a first filter and decoding is the real test. The size caps
are checked against Jira's listed size before any request, and again while reading.

**Asking for a folder.** The server checks the client's declared `elicitation` capability on each
call, because capabilities arrive in the handshake after the tools are registered. Form elicitation
counts as supported when the capability names `form`, or names no mode at all, which is how clients
from before modes existed declared it. If it is supported, the server sends an
`elicitation/create` request with:

- a message naming the file, its size and the issue, such as
  `Save "server.log" (1.2 MiB) from PROJ-123?`. The filename is control-stripped and shortened to
  120 characters, because it is uploader-chosen text shown in the client's own UI.
- a form with `directory`, a required string described as "Absolute path of an existing folder to
  save the file in", and `rememberForSession`, an optional boolean titled "Save later attachments
  here without asking".

The request waits up to 10 minutes for an answer instead of the SDK's default of one, since a
person has to find and type a folder.

| User response                                 | Result                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Accepts with a valid folder                   | The file is streamed there; `saved: true`, `path` set                                      |
| Accepts with a relative path, or not a folder | Nothing is saved; `saved: false`, and the `reason` says why. The server does not ask again |
| Accepts with an empty folder                  | Treated as a cancel                                                                        |
| Declines or cancels                           | `saved: false`, `reason: "The user declined to save the file."`                            |

The folder must already exist. A typo should not create a directory somewhere unexpected. The file
gets the CLI's sanitized name and is never overwritten: if the name is taken, it becomes
`<stem> (<id>)<ext>`, and if that is taken too, nothing is saved and the `reason` says so. With
`rememberForSession`, later saves in the same server process go to that folder without asking. The
folder is remembered only after a save to it succeeds, so a mistyped folder is never reused. It is
held in memory only and is forgotten when the server exits.

When the file could not be returned inline, the `reason` starts with why, then gives the save
outcome, so an agent can tell the user both.

None of these outcomes is an `isError` result. The tool worked; the user chose. The `browserUrl` in
the metadata is still there for the user to fall back on.

**Why the agent never supplies a path.** The file's contents come from whoever uploaded it, and the
ticket's text can steer the agent. A path input would let a ticket choose where on the user's
machine an uploader's file lands, such as over a shell startup file. A folder the user typed into
the client's own prompt is a decision the agent cannot make for them.

**Untrusted content.** Inline text is returned unaltered, as `jira_issue_view` returns a
description unaltered. The tool's description says the content is written by whoever attached the
file and is data, not instructions, for the same reason
[0004](0004-write-safety-and-jira-issue-writes.md) and the write-safety guide give about ticket text.

**Server changes.**

- `ToolSpec.run` may now resolve to a `ToolContent` value, a small class in `tools.ts` holding an
  array of MCP content blocks. `invokeTool` passes a `ToolContent`'s blocks through and serializes
  everything else as before, so no other tool changes. 0007's "Results" table gains a row for it.
- `ToolContext` gains an optional `askForFolder(message)`, bound per call in `server.ts` only when
  the client supports form elicitation, and a `session` object shared by every call that holds the
  remembered folder. Tools that do not use them see no change.

## Alternatives considered

- **A transport option on `json` instead of a `stream` method.** One method would then return two
  unrelated types depending on a flag, and every existing caller's type would widen. A second
  public method over a shared private attempt loop keeps `json` exactly as it is.
- **Buffering downloads in memory under a size cap.** Simpler, but it puts a ceiling on what the
  CLI can fetch, and the whole-exchange deadline would cut off a large file on a slow link
  regardless of the cap. Streaming with an idle timeout has neither limit.
- **Resuming a failed download with a `Range` request.** It saves re-sending the start of a large
  file, but neither deployment documents `Range` support on these paths. Restarting the file is
  always correct, and is the safe choice until a live instance shows `Range` works.
- **Following the attachment's `content` URL.** It is server-supplied. On Cloud it redirects to
  another host, and fetch strips the `Authorization` header on a cross-origin redirect, so it works
  only because the redirect target carries a token. Building the path from the id keeps every
  request on the configured base URL, under the same rule as 0019.
- **Returning Cloud's redirect target from MCP as the download link.** It downloads without a
  sign-in, which would let the agent fetch the file. That is the problem: the token in it is a
  credential, and it would sit in the agent's context and the client's logs. The browser link needs
  the user's own session.
- **A `directory` input on the MCP tool.** The agent would choose where files land, which is the
  risk described under "Why the agent never supplies a path".
- **A `--download-dir` server flag.** Safe, because the user sets it in their client config, but
  it must be set up before it is needed and applies to every session. Elicitation asks at the
  moment it matters. A flag can be added later for clients without elicitation, if that proves
  common.
- **`attachment get <id>` without an issue.** Both deployments can fetch an attachment by id
  alone. Anchoring on the issue makes `download` with no `--id` mean "everything on this ticket",
  lets a wrong id fail with a clear message, and matches `remotelink` and `comment`, which also
  hang off an issue.
- **Skipping existing files instead of failing.** It is quieter, but a re-run would report success
  while leaving stale copies in place. Failing before any download, with every collision listed,
  makes `--overwrite` a deliberate choice.
- **Returning every file type from MCP as an `embedded resource` blob.** The protocol allows it, but
  most clients do not show blobs to the model, so the agent would see a large base64 string or
  nothing. Saving the file where the user chose is more useful: an agent with its own file tools can
  then open it.
- **Extracting text from PDFs and Office documents.** It would answer "what does the attachment
  say" for the most common business files. It needs a parsing dependency per format, each a new
  supply-chain and license review, and the output would be lossy. Saving the file covers much of
  the need for agents that can read those formats themselves (see open questions).

## Implementation plan

1. `simply-atlassian-core/src/http.ts`: factor the request and status handling out of `attempt`,
   and add `stream(call, { idleTimeoutMs })` returning `{ body, contentType?, contentLength? }`, with
   `Accept: */*` and `redirect: 'manual'`. `json` keeps its behavior.
2. `simply-atlassian-core/src/jira-client.ts`: `getAttachments(issueKey)`,
   `openAttachment(attachment)`, and `attachmentBrowserUrl(attachment)`, branching on `deployment`
   for the content path.
3. `simply-atlassian-core/src/jira-attachments.ts`: `JiraAttachment` and `describeAttachment`,
   `formatBytes`, `safeAttachmentFilename`, `selectAttachments` (id checks, shared by the CLI's
   `--stdout` path and the MCP tool), `planAttachmentDownloads` (naming, collisions),
   `saveAttachment` (streamed write, byte check, restart, rename), `saveAttachmentToFolder` (the
   MCP save, with its folder checks and no-overwrite naming), `readAttachment` (bounded read), and
   `inlineAttachment` (the MCP text/image/other decision). Exported from `index.ts`.
4. `simply-atlassian/src/commands/atlassian/jira/issue/attachment/list.ts` and `download.ts`.
5. `simply-atlassian-mcp/src/tools.ts`: `ToolContent`, the per-tool `annotations` override, and the
   two tools. `simply-atlassian-mcp/src/context.ts`: the optional `askForFolder` and the `session`.
   `simply-atlassian-mcp/src/server.ts`: `invokeTool` passes `ToolContent` through, the kind's
   annotations are merged with the tool's, and each call binds `askForFolder` when the client
   supports form elicitation.
6. Docs: this file's status and the index row; 0007's tool table, counts, and "Results" table; the
   MCP guide, including which clients support elicitation; the `scripting` guide's note on stdout;
   an `AGENTS.md` map entry.
7. `pnpm run build` (command snapshot) and `pnpm run readme` in `simply-atlassian`; commit both.

## Testing

- Core, transport: `stream` resolves at headers and returns the body unread; sends `Accept: */*`;
  turns a `3xx` into an `HttpError`; retries a `5xx` before headers as a read; maps 401/403 to
  `AuthError` as `json` does; aborts a body that stalls past the idle timeout but not one that keeps
  sending.
- Core, client: Cloud requests `/rest/api/3/attachment/content/{id}` with `redirect=false`;
  Server/DC requests `/secure/attachment/{id}/{filename}` with the filename percent-encoded; browser
  links use the configured base URL and never `redirect=false`; an issue without an `attachment`
  field yields an empty list.
- Core, naming: each row of the file-name table, including `../../etc/passwd`, `CON.txt`,
  `name. `, a name of only dots, and two attachments called `log.txt`; the resolved path always
  lies directly inside the output directory.
- Core, planning: an unknown `--id` fails and names it; collisions fail before any download and
  list every path; `--overwrite` permits them.
- Core, saving: a body that fails part-way leaves no file under the final name and is restarted;
  a byte count that does not match the listed size fails and leaves nothing behind; three failures
  give up.
- Core, bounded read: a body larger than `maxBytes` is aborted even when the listed size was
  smaller.
- CLI: `list` table, sizes and the empty case; `list --json` is the raw array; `download` with and
  without `--id`; collision refusal; `--stdout` with one, none and several selections, under a TTY,
  with `--json`, and with a body that fails after bytes were written; the `--json` envelope; a 404
  part-way through reports how many files were written.
- MCP, through a real in-memory client: both tools are registered without `--allow-writes`, the
  download tool carries `readOnlyHint: false` and has no path input, and it is the only tool with
  that override; text and images within their caps come back inline; with a client that answers
  elicitation, an unsupported file and `save: true` on a small one each prompt once; accept saves
  with a sanitized, non-overwriting name; a relative path, a missing folder, decline and cancel
  each return `saved: false` with a reason and no second prompt; `rememberForSession` skips the
  prompt on the next call; a client without elicitation gets metadata and `browserUrl` and no
  content request; the prompt strips control characters from the filename; an id the issue does
  not have is an `isError` result; the catalogue-parity test covers both new commands.

## Verification boundary

The mocks pin the documented shapes. Some things only a live instance or client settles:

- Whether `/secure/attachment/{id}/{filename}` accepts a personal access token on every Server/DC
  version the team runs. It is a web path rather than REST, and some deployments put such paths
  behind SSO.
- What Server/DC does when the filename in the path does not match the stored one. That affects
  whether the client may percent-encode, or must pass Jira's name through as-is.
- Whether Cloud's `redirect=false` responses carry the attachment's real `Content-Type` and
  `Content-Length`. The CLI does not depend on either, but the MCP tool would prefer the real type
  to the listed `mimeType`.
- Which MCP clients the team uses support form elicitation, and how each shows the prompt. Clients
  without it get the browser link, so the tool works everywhere, but saving does not.

## Open questions

- **Uploading and deleting attachments.** `POST /issue/{key}/attachments` needs a multipart body,
  which the transport cannot send, and the `X-Atlassian-Token: no-check` header. Delete is a
  `destructive` command under 0004. They belong in their own document.
- **Text from PDFs and Office files for MCP.** Decided against for now, for the dependency reasons
  above. The maintainers revisit it if agents without file tools routinely cannot read those types.
- **A `--download-dir` server flag** for clients without elicitation. Added only if those clients
  turn out to matter.
- **Archive listing.** Both deployments can list a zip's contents (`/attachment/{id}/expand/human`).
  Cheap to add as `attachment list --expand` if anyone asks.
- **Confluence page attachments.** A similar feature with different endpoints. Its own document.
- **Showing an attachment count in `issue view`.** A small change to the curated table, left out
  to keep this document to one subtopic.
