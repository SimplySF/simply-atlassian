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

import { ConfigError } from '../core/errors.js';

const BARE_PAGE_ID = /^\d+$/;

/** `/pages/123456`, with or without a trailing slug, on Cloud (`/wiki/spaces/...`) or Server. */
const PAGE_ID_IN_PATH = /\/pages\/(?:viewpage\.action\?pageId=)?(\d+)/;

/** `?pageId=123456`, the Server/DC viewpage form. */
const PAGE_ID_IN_QUERY = /[?&]pageId=(\d+)/;

function baseUrlWithoutTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Builds the browser URL for a Jira issue. */
export function issueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrlWithoutTrailingSlash(baseUrl)}/browse/${encodeURIComponent(issueKey)}`;
}

/** Builds the browser URL for a Jira project, using the path shared by Cloud and Server/DC. */
export function projectUrl(baseUrl: string, projectKey: string): string {
  return `${baseUrlWithoutTrailingSlash(baseUrl)}/browse/${encodeURIComponent(projectKey)}`;
}

/** Builds the browser URL for a Confluence page on Cloud or Server/DC. */
export function pageUrl(baseUrl: string, pageId: string): string {
  return `${baseUrlWithoutTrailingSlash(baseUrl)}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/**
 * Accepts either a bare page id or a page URL, because people copy URLs out of a browser rather
 * than digging out ids — and an agent relaying what a person pasted has the same thing.
 *
 * The **path wins over the query string**, and a disagreement between them is refused outright.
 * That ordering is not cosmetic. `/pages/123456/Quarterly-plan?pageId=999999` renders to a person,
 * and reads to an agent, as page 123456 — so resolving it to 999999 means a destructive command
 * acts on a page nobody named. Anyone who can put a link in a page, a comment, or a ticket
 * controls that, and the printed title is no defence because it is the title of the *wrong* page.
 */
export function pageIdFromInput(value: string): string {
  const trimmed = value.trim();
  if (BARE_PAGE_ID.test(trimmed)) return trimmed;

  const fromPath = PAGE_ID_IN_PATH.exec(trimmed)?.[1];
  const fromQuery = PAGE_ID_IN_QUERY.exec(trimmed)?.[1];

  // Both present and disagreeing is either a mistake or an attempt to mislead. Either way the
  // caller's intent is genuinely unknown, so neither answer is safe to pick.
  if (fromPath !== undefined && fromQuery !== undefined && fromPath !== fromQuery) {
    throw new ConfigError(
      `"${value}" names two different pages: ${fromPath} in the path and ${fromQuery} in the ` +
        'query string. Pass the id you mean.',
    );
  }
  if (fromPath !== undefined) return fromPath;
  if (fromQuery !== undefined) return fromQuery;

  throw new ConfigError(
    `Cannot read a page id from "${value}". Pass a numeric id, or a page URL such as ` +
      'https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title.',
  );
}

/**
 * Resolves a page reference, additionally refusing a URL that points at a different instance.
 *
 * A bare id is unambiguous. A URL is not: the id in a link to some other tenant — or to a
 * lookalike host — is still a valid id *here*, so acting on it silently targets whatever happens
 * to carry that number on the configured instance. An agent handed a link by a page or a ticket
 * is exactly the case this guards.
 */
export function pageIdForInstance(value: string, instanceUrl: string): string {
  const id = pageIdFromInput(value);
  const trimmed = value.trim();
  if (BARE_PAGE_ID.test(trimmed)) return id;

  let host: string | undefined;
  try {
    host = new URL(trimmed).host;
  } catch {
    // Not an absolute URL — a relative path such as `/wiki/spaces/X/pages/1/T`, which carries no
    // host to disagree with.
    return id;
  }

  let expected: string;
  try {
    expected = new URL(instanceUrl).host;
  } catch {
    // A configured URL this cannot parse is a separate problem, reported where it is configured.
    return id;
  }

  if (host.toLowerCase() !== expected.toLowerCase()) {
    throw new ConfigError(
      `That URL points at ${host}, but this command is configured for ${expected}. ` +
        `Pass the page id (${id}) if you meant a page on ${expected}.`,
    );
  }
  return id;
}
