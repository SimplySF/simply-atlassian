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

import { readFileSync } from 'node:fs';
import { ConfigError } from '../core/errors.js';

/**
 * Reads a raw JSON request body from a flag or a file. The field surface of a Jira issue is
 * large, instance-specific, and changes without our involvement, so an escape hatch means an
 * unusual custom field never blocks anyone — while the typed flags keep the common case simple.
 *
 * Exactly one source is allowed. Accepting both and picking a winner would make a caller's
 * mistake look like a preference.
 */
export function parseBodyInput(
  body: string | undefined,
  bodyFile: string | undefined,
): Record<string, unknown> | undefined {
  if (body !== undefined && bodyFile !== undefined) {
    throw new ConfigError('Pass --body or --body-file, not both.');
  }

  const source = body ?? (bodyFile === undefined ? undefined : readBodyFile(bodyFile));
  if (source === undefined) return undefined;

  const label = bodyFile ?? '--body';
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    // Only the position, never the parser's snippet of the content: a caller can name any path,
    // and the snippet would echo the first bytes of whatever file that was.
    const position =
      error instanceof Error ? /position \d+(?::? line \d+ column \d+)?/.exec(error.message)?.[0] : undefined;
    throw new ConfigError(`${label} is not valid JSON${position === undefined ? '' : ` at ${position}`}.`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : 'could not be read';
    throw new ConfigError(`Body file ${path} ${reason}.`);
  }
}

/**
 * Top-level keys Jira actually reads on an issue request. Anything else it ignores in silence,
 * which is the dangerous case: a caller who writes `{"customfield_10011":"x"}` expecting it to
 * be a field would otherwise get a cheerful "Created" and no custom field.
 */
const REQUEST_KEYS = new Set(['fields', 'update', 'transition', 'historyMetadata', 'properties']);

/**
 * Merges typed flags over a raw body, one level deep on `fields`. A template file can supply
 * the shape while a flag overrides a single value, which is the way both are actually used
 * together.
 *
 * A key the instance would ignore is refused rather than sent, naming the likely intent.
 */
export function mergeFields(
  body: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const base = body ?? {};
  const ignored = Object.keys(base).filter((key) => !REQUEST_KEYS.has(key));
  if (ignored.length > 0) {
    throw new ConfigError(
      `The request body has ${ignored.length === 1 ? 'a key' : 'keys'} Jira would ignore: ` +
        `${ignored.join(', ')}. Issue fields belong under "fields", as in ` +
        `{"fields":{"${ignored[0] ?? 'customfield_10011'}":…}}.`,
    );
  }
  const baseFields = base.fields;
  const merged = {
    ...(typeof baseFields === 'object' && baseFields !== null && !Array.isArray(baseFields) ? baseFields : {}),
    ...fields,
  };
  return { ...base, fields: merged };
}
