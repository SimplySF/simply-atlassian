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

/**
 * Accepts either a bare page id or a page URL, because people copy URLs out of a browser
 * rather than digging out ids — and an agent relaying what a person pasted has the same thing.
 */
export function pageIdFromInput(value: string): string {
  const trimmed = value.trim();
  if (BARE_PAGE_ID.test(trimmed)) return trimmed;

  const fromQuery = PAGE_ID_IN_QUERY.exec(trimmed)?.[1];
  if (fromQuery !== undefined) return fromQuery;

  const fromPath = PAGE_ID_IN_PATH.exec(trimmed)?.[1];
  if (fromPath !== undefined) return fromPath;

  throw new ConfigError(
    `Cannot read a page id from "${value}". Pass a numeric id, or a page URL such as ` +
      'https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Title.',
  );
}
