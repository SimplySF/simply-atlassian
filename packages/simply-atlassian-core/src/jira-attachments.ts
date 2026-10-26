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

import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CliError, NetworkError } from './errors.js';
import type { JiraClient } from './jira-client.js';
import { stripControlOneLine } from './text.js';

/** One attachment, normalized across deployments: Cloud names its author by account, Server/DC by username. */
export interface JiraAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size?: number;
  readonly mimeType?: string;
  readonly author?: string;
  readonly created?: string;
}

/** Where one selected attachment will be written. */
export interface AttachmentDownload {
  readonly attachment: JiraAttachment;
  readonly path: string;
}

export interface AttachmentPlanOptions {
  readonly issueKey: string;
  /** Attachment ids to select. Empty or absent selects every attachment. */
  readonly ids?: readonly string[];
  readonly directory: string;
  readonly overwrite?: boolean;
}

/** What saving into a folder the user chose came to. Never an error: the user's choice is not a failure. */
export type FolderSaveOutcome =
  | { readonly saved: true; readonly path: string; readonly size: number }
  | { readonly saved: false; readonly reason: string };

/** An attachment's content in a form an agent can read, or why it cannot be. */
export type InlineAttachment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly kind: 'none'; readonly reason: string };

export const INLINE_TEXT_MAX_BYTES = 1024 * 1024;
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** How long a download may go without a byte. Progress, however slow, keeps it alive. */
const IDLE_TIMEOUT_MS = 30_000;
const SAVE_ATTEMPTS = 3;

/** Leaves room under the common 255-byte limit for the ` (<id>)` a duplicate gets and the temporary suffix. */
const MAX_FILENAME_LENGTH = 180;

/** Windows refuses these as file names whatever the extension, and older tools treat them as devices. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-ndjson']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function describeAttachment(raw: unknown): JiraAttachment {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const author = (typeof value.author === 'object' && value.author !== null ? value.author : {}) as Record<
    string,
    unknown
  >;
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : '';
  return {
    id,
    filename: typeof value.filename === 'string' ? value.filename : '',
    size: typeof value.size === 'number' && Number.isSafeInteger(value.size) ? value.size : undefined,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    author: firstString(author.displayName, author.accountId, author.name),
    created: typeof value.created === 'string' ? value.created : undefined,
  };
}

/** Binary units to one decimal place, so a listing reads at a glance; `--json` keeps the exact count. */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

/**
 * Makes an uploader-chosen name safe to use as a single file name on Windows and POSIX. This is
 * the main guard against a name that climbs out of the output directory; the path check in
 * planning is the second.
 */
export function safeAttachmentFilename(name: string, id: string): string {
  let safe = name
    .replaceAll(/[/\\]/g, '_')
    .replaceAll(/[\p{Cc}<>:"|?*]/gu, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (RESERVED_NAME.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_FILENAME_LENGTH) {
    const extension = path.extname(safe).slice(0, 20);
    safe = `${safe.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`;
  }
  return safe === '' ? `attachment-${id}` : safe;
}

/**
 * The attachments `ids` names, in the issue's order; every attachment when `ids` is empty. An id
 * the issue does not have is an error, not a skip, because a typo would otherwise look like
 * success.
 */
export function selectAttachments(
  attachments: readonly JiraAttachment[],
  issueKey: string,
  ids: readonly string[] = [],
): JiraAttachment[] {
  const wanted = new Set(ids);
  const known = new Set(attachments.map((attachment) => attachment.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new CliError(`No attachment ${unknown.join(', ')} on ${issueKey}.`);
  return wanted.size === 0 ? [...attachments] : attachments.filter((attachment) => wanted.has(attachment.id));
}

/**
 * Selects attachments and decides where each goes, refusing before anything is downloaded: an
 * unknown id, a path outside the directory, and (without `overwrite`) every file that already
 * exists. Duplicate names — Jira allows them on one issue — are told apart by id.
 */
export function planAttachmentDownloads(
  attachments: readonly JiraAttachment[],
  options: AttachmentPlanOptions,
): AttachmentDownload[] {
  const selected = selectAttachments(attachments, options.issueKey, options.ids);

  // Case-insensitively, because the file systems people run this on on Windows and macOS are.
  const names = selected.map((attachment) => safeAttachmentFilename(attachment.filename, attachment.id));
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);

  const directory = path.resolve(options.directory);
  const plan = selected.map((attachment, index) => {
    const name = names[index] ?? '';
    const unique = (counts.get(name.toLowerCase()) ?? 0) > 1 ? withId(name, attachment.id) : name;
    const target = path.join(directory, unique);
    if (path.dirname(target) !== directory) {
      throw new CliError(`Refusing to write attachment ${attachment.id} outside ${directory}.`);
    }
    return { attachment, path: target };
  });

  if (options.overwrite !== true) {
    const existing = plan.filter((download) => existsSync(download.path)).map((download) => download.path);
    if (existing.length > 0) {
      throw new CliError(
        `These files already exist; pass --overwrite to replace them:\n${existing.map((file) => `  ${file}`).join('\n')}`,
      );
    }
  }
  return plan;
}

/**
 * Streams one attachment to `file` through a temporary file beside it, so the real name only ever
 * holds a complete download. A body that drops or stalls restarts from the beginning — safe,
 * because this only reads — and a byte count that disagrees with Jira's listing is refused.
 * Returns the number of bytes written.
 */
export async function saveAttachment(
  client: JiraClient,
  attachment: JiraAttachment,
  file: string,
  options: { readonly overwrite?: boolean; readonly idleTimeoutMs?: number } = {},
): Promise<number> {
  const label = stripControlOneLine(attachment.filename) || attachment.id;
  /* A restart must follow the failed attempt, never overlap it. */
  /* eslint-disable no-await-in-loop */
  for (let attempt = 1; ; attempt += 1) {
    // Opened outside the write's try: the transport has already retried what fails before headers.
    const response = await client.openAttachment(attachment, {
      idleTimeoutMs: options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
    });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      let written = 0;
      await pipeline(
        response.body,
        async function* count(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          for await (const chunk of source) {
            written += chunk.byteLength;
            yield chunk;
          }
        },
        createWriteStream(temporary, { flags: 'wx' }),
      );
      if (attachment.size !== undefined && written !== attachment.size) {
        throw new CliError(`${label} arrived as ${written} bytes, but Jira lists it as ${attachment.size}.`);
      }
      if (options.overwrite !== true && existsSync(file)) {
        throw new CliError(`${file} appeared while ${label} was downloading; it was left as it is.`);
      }
      renameSync(temporary, file);
      return written;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!(error instanceof NetworkError) || attempt >= SAVE_ATTEMPTS) throw error;
    }
  }
  /* eslint-enable no-await-in-loop */
}

/**
 * Saves an attachment into a folder a person typed in, for the MCP server. The folder must be
 * absolute and already exist, so a typo never creates a directory somewhere unexpected, and an
 * existing file is never replaced.
 */
export async function saveAttachmentToFolder(
  client: JiraClient,
  attachment: JiraAttachment,
  directory: string,
): Promise<FolderSaveOutcome> {
  if (!path.isAbsolute(directory)) {
    return { saved: false, reason: `"${stripControlOneLine(directory)}" is not an absolute path.` };
  }
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return { saved: false, reason: `"${stripControlOneLine(directory)}" is not an existing folder.` };
  }

  const name = safeAttachmentFilename(attachment.filename, attachment.id);
  const target = [name, withId(name, attachment.id)]
    .map((candidate) => path.join(directory, candidate))
    .find((candidate) => !existsSync(candidate));
  if (target === undefined) {
    return {
      saved: false,
      reason: `${name} already exists in that folder, and so does ${withId(name, attachment.id)}.`,
    };
  }
  const size = await saveAttachment(client, attachment, target);
  return { saved: true, path: target, size };
}

/**
 * Reads at most `maxBytes` of an attachment into memory. Returns `undefined` once the body runs
 * past the cap, which also cancels the request, so a listing that understated the size cannot
 * make this read a large file.
 */
export async function readAttachment(
  client: JiraClient,
  attachment: JiraAttachment,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const response = await client.openAttachment(attachment, { idleTimeoutMs: IDLE_TIMEOUT_MS });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches an attachment in a form an agent can read: UTF-8 text up to 1 MiB, or a common image
 * type up to 5 MiB. The listed type is the uploader's browser's guess, so it is only a first
 * filter; decoding is the real test for text. Sizes are checked before the request when Jira
 * lists one, and again while reading.
 */
export async function inlineAttachment(client: JiraClient, attachment: JiraAttachment): Promise<InlineAttachment> {
  const type = (attachment.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const kind = type.startsWith('text/') || TEXT_TYPES.has(type) ? 'text' : IMAGE_TYPES.has(type) ? 'image' : undefined;
  if (kind === undefined) {
    return { kind: 'none', reason: `${type === '' ? 'A file of unknown type' : type} cannot be returned inline.` };
  }

  const cap = kind === 'text' ? INLINE_TEXT_MAX_BYTES : INLINE_IMAGE_MAX_BYTES;
  const tooLarge = {
    kind: 'none',
    reason: `It is larger than ${formatBytes(cap) ?? `${cap} B`}, the inline limit for ${kind}.`,
  } as const;
  if (attachment.size !== undefined && attachment.size > cap) return tooLarge;
  const data = await readAttachment(client, attachment, cap);
  if (data === undefined) return tooLarge;

  if (kind === 'image') return { kind, data: Buffer.from(data).toString('base64'), mimeType: type };
  try {
    return { kind, text: new TextDecoder('utf-8', { fatal: true }).decode(data) };
  } catch {
    return { kind: 'none', reason: `It is listed as ${type} but is not valid UTF-8 text.` };
  }
}

/** `report.pdf` → `report (10234).pdf`. */
function withId(name: string, id: string): string {
  const extension = path.extname(name);
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  return `${stem} (${id})${extension}`;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '');
}
