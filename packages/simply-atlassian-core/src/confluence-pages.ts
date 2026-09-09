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

import { pageIdForInstance } from './atlassian-url.js';
import { resolveStorageBody, type StorageBody } from './confluence-body.js';
import type { ConfluenceClient } from './confluence-client.js';
import { CliError, ConfigError, HttpError } from './errors.js';
import { storageToMarkdown } from './storage-markdown.js';
import { stripControlOneLine } from './text.js';

/** The fields of a page these operations read; the raw payload carries far more. */
export interface ConfluencePageSummary {
  readonly id?: string;
  readonly title?: string;
  readonly type?: string;
  readonly status?: string;
  readonly version?: { readonly number?: number };
  readonly body?: { readonly storage?: { readonly value?: string } };
  readonly _links?: { readonly base?: string; readonly webui?: string };
}

/** The three ways a page or comment body can be supplied; exactly one is allowed. */
export interface PageBodyInput {
  /** Plain text; becomes paragraphs with its markup escaped. */
  readonly text?: string;
  /** Raw storage-format XHTML. */
  readonly body?: string;
  /** Path to a file holding storage-format XHTML. */
  readonly 'body-file'?: string;
}

export interface CreatePageInput extends PageBodyInput {
  readonly space: string;
  readonly title: string;
  /** Parent page id or URL; without it the page lands at the space root. */
  readonly parent?: string;
}

export interface UpdatePageInput extends PageBodyInput {
  /** New title; defaults to the page's current title. */
  readonly title?: string;
}

/** An update, fully prepared: the version it was read at is what the request is conditioned on. */
export interface PageUpdatePlan {
  readonly pageId: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
}

export interface DeletePageInput {
  /** Destroy the page permanently instead of trashing it. Requires `confirm`. */
  readonly purge?: boolean;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
}

/**
 * What a delete reports. `deleted: false` without a dry run means the page was already in the
 * trash and nothing was done; `purge` says which of the two senses of "delete" applied.
 */
export interface DeletePageResult {
  readonly pageId: string;
  /** JSON-quoted, control-stripped title, so it can be interpolated into a line safely. */
  readonly title: string;
  readonly purge: boolean;
  readonly deleted: boolean;
}

export const BODY_FORMATS = ['markdown', 'storage', 'none'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** Confluence returns the browser URL split across two fields. */
export function webUrl(page: ConfluencePageSummary): string | undefined {
  /* eslint-disable-next-line no-underscore-dangle -- Atlassian's field name */
  const links = page._links;
  if (links?.base === undefined || links.webui === undefined) return undefined;
  return `${links.base}${links.webui}`;
}

/** The expansions a page read needs; 'none' skips the body entirely rather than fetching and discarding it. */
export function pageExpand(format: BodyFormat, expand?: readonly string[]): string[] {
  if (expand !== undefined) return [...expand];
  return format === 'none' ? ['version', 'space'] : ['body.storage', 'version', 'space'];
}

/** The page body in the requested representation, or nothing when there is nothing to show. */
export function renderPageBody(storage: string | undefined, format: BodyFormat): string | undefined {
  if (format === 'none' || storage === undefined || storage.trim() === '') return undefined;
  return format === 'storage' ? storage : storageToMarkdown(storage);
}

/**
 * The request for a new page. A page with no body is legitimate — a placeholder someone fills
 * in later — so an absent body is an empty one rather than an error.
 */
export function buildPageCreateBody(input: CreatePageInput, instanceUrl: string): Record<string, unknown> {
  const body: StorageBody | undefined = resolveStorageBody(input);
  const payload: Record<string, unknown> = {
    type: 'page',
    title: input.title,
    space: { key: input.space },
    body: body ?? { storage: { value: '', representation: 'storage' } },
  };
  if (input.parent !== undefined) {
    payload.ancestors = [{ id: pageIdForInstance(input.parent, instanceUrl) }];
  }
  return payload;
}

/**
 * Reads the page and prepares its next version. Confluence requires both the next version
 * number and the title on every update, even when the title is unchanged, so the current state
 * has to be read either way. Only pages are updated: the instance decides what an id is, and
 * echoing its answer back would quietly make this a comment editor.
 */
export async function preparePageUpdate(
  client: ConfluenceClient,
  pageId: string,
  input: UpdatePageInput,
): Promise<PageUpdatePlan> {
  const body = resolveStorageBody(input);
  if (body === undefined && input.title === undefined) {
    throw new ConfigError('Nothing to update. Pass --title, or a body with --text, --body, or --body-file.');
  }

  const current = (await client.getPage(pageId, { expand: ['version'] })) as ConfluencePageSummary;
  const version = current.version?.number;
  if (typeof version !== 'number') {
    throw new CliError(`The instance reported no version for page ${pageId}, so it cannot be updated safely.`);
  }
  if (current.type !== undefined && current.type !== 'page') {
    throw new ConfigError(`${pageId} is a ${current.type}, not a page. This command only updates pages.`);
  }

  const payload: Record<string, unknown> = {
    type: 'page',
    title: input.title ?? current.title,
    version: { number: version + 1 },
  };
  if (body !== undefined) payload.body = body;
  return { pageId, version, payload };
}

/**
 * Sends a prepared update. A version conflict is the one failure worth naming: it means the page
 * moved under us, which has a different fix from a bad request — read it again and re-apply.
 * Confluence answers 409 for other reasons too (a duplicate title, for one) where re-running
 * reproduces the same failure forever, which for an agent is an infinite loop, so the instance's
 * own reason is always carried through.
 */
export async function updatePage(client: ConfluenceClient, plan: PageUpdatePlan): Promise<unknown> {
  try {
    return await client.updateContent(plan.pageId, plan.payload);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && /version/i.test(error.message)) {
      throw new CliError(
        `Page ${plan.pageId} was changed by someone else while this ran (it is no longer at version ` +
          `${plan.version}). Nothing was written. Re-run to apply your change on top of theirs.`,
      );
    }
    throw error;
  }
}

/**
 * Trashes a page, or destroys it.
 *
 * The page is read first so both the confirmation and the result can name it: a page id
 * identifies nothing to a person, and after a purge this is the only remaining record of what
 * went. `status: 'any'` is load-bearing — the default filter hides trashed pages, and without it
 * `purge` on an already-trashed page fails at the read rather than finishing the job.
 */
export async function deletePage(
  client: ConfluenceClient,
  pageId: string,
  input: DeletePageInput = {},
): Promise<DeletePageResult> {
  const purge = input.purge === true;
  const page = (await client.getPage(pageId, { expand: [], status: 'any' })) as ConfluencePageSummary;
  // Rendered as a JSON string rather than dropped between bare quotes: control characters are
  // already stripped, but a title containing a quote could otherwise close ours and narrate a
  // false outcome on the same line.
  const title = JSON.stringify(stripControlOneLine(page.title ?? '(untitled)'));
  const alreadyTrashed = page.status === 'trashed';

  if (purge && input.confirm !== true) {
    throw new ConfigError(
      `Refusing to permanently destroy page ${pageId} (${title}) without --confirm. ` +
        'Omit --purge to move it to the trash instead, which is reversible.',
    );
  }
  if (input.dryRun === true) return { pageId, title, purge, deleted: false };

  if (purge) {
    await purgePage(client, pageId, title, alreadyTrashed);
    return { pageId, title, purge: true, deleted: true };
  }
  if (alreadyTrashed) return { pageId, title, purge: false, deleted: false };

  await client.deleteContent(pageId);
  return { pageId, title, purge: false, deleted: true };
}

/**
 * Confluence only purges content that is already trashed, so an untrashed page needs both
 * steps. Doing them together is the point: "purge" is one intent, and leaving a caller
 * half-done would let them believe a page was destroyed when it is sitting in the trash.
 */
async function purgePage(
  client: ConfluenceClient,
  pageId: string,
  title: string,
  alreadyTrashed: boolean,
): Promise<void> {
  if (!alreadyTrashed) await client.deleteContent(pageId);
  try {
    await client.deleteContent(pageId, { purge: true });
  } catch (error) {
    // The page has already left the space at this point. Surfacing only the purge failure
    // would read as "the operation did not happen" while every link to the page is broken,
    // so the partial outcome is stated first and the underlying reason carried through.
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Page ${pageId} (${title}) was moved to the trash but could NOT be permanently ` +
        `deleted, so it is still recoverable from there. Reason: ${reason}`,
    );
  }
}

/** The request for a comment on a page; the container is what makes it a comment *on* the page. */
export function buildPageCommentBody(pageId: string, input: PageBodyInput): Record<string, unknown> {
  const body = resolveStorageBody(input);
  if (body === undefined) {
    throw new ConfigError('Nothing to post. Pass --text, --body, or --body-file.');
  }
  return { type: 'comment', container: { id: pageId, type: 'page' }, body };
}
