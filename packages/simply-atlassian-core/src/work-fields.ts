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

import type { Deployment } from './config.js';
import { ConfigError } from './errors.js';
import type { JiraClient } from './jira-client.js';
import { adfToMarkdown, markdownToAdf } from './markdown-adf.js';
import { markdownToWiki, wikiToMarkdown } from './markdown-wiki.js';
import { isListType, type WorkFieldSpec } from './work-config.js';

/**
 * One encoder and one decoder per configured field type, for each deployment.
 *
 * The contract the tests pin: what `decodeWorkField` returns, `encodeWorkField` accepts, and a
 * value read and written back unchanged sends exactly what Jira already holds. That is what lets
 * an agent edit one field of a story without disturbing the others.
 *
 * System fields that Jira encodes differently from their type's usual shape (`priority` is
 * `{ name }`, not `{ value }`; `parent` is `{ key }`) are handled here, so a project config never
 * has to know about them.
 */

/** A field's value as an agent sees it, plus what reading it could not carry. */
export interface DecodedField {
  readonly value: unknown;
  /** A person's display name, for `user` fields whose value is an account id. */
  readonly display?: string;
  readonly lossy: readonly string[];
}

/** Clearing a field: `null` for single values, an empty list for list types. */
export function emptyValue(spec: WorkFieldSpec): unknown {
  return isListType(spec.type) ? [] : null;
}

/** Whether a value counts as absent for `required`. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Reads a field from an issue's `fields` object into the form an agent edits. */
export function decodeWorkField(spec: WorkFieldSpec, raw: unknown, deployment: Deployment): DecodedField {
  if (raw === undefined || raw === null) return { value: emptyValue(spec), lossy: [] };

  switch (spec.type) {
    case 'markdown':
      return decodeRichText(raw, deployment);
    case 'text':
      return { value: typeof raw === 'string' ? raw : adfToMarkdown(raw).markdown, lossy: [] };
    case 'number':
    case 'date':
    case 'raw':
      return { value: raw, lossy: [] };
    case 'option':
      return { value: choiceName(raw) ?? null, lossy: [] };
    case 'options':
    case 'components':
    case 'versions':
      return {
        value: asList(raw)
          .map((item) => choiceName(item))
          .filter(isString),
        lossy: [],
      };
    case 'labels':
      return { value: asList(raw).filter(isString), lossy: [] };
    case 'user':
      return decodeUser(raw, deployment);
    case 'issue': {
      const key = typeof raw === 'string' ? raw : (raw as { key?: unknown }).key;
      return { value: typeof key === 'string' ? key : null, lossy: [] };
    }
  }
}

function decodeRichText(raw: unknown, deployment: Deployment): DecodedField {
  if (typeof raw !== 'string') {
    const reading = adfToMarkdown(raw);
    return { value: reading.markdown, lossy: reading.lossy };
  }
  // Server/DC stores wiki markup. On Cloud a string means a plain-text field, read as-is.
  if (deployment === 'cloud') return { value: raw, lossy: [] };
  const reading = wikiToMarkdown(raw);
  return { value: reading.markdown, lossy: reading.lossy };
}

function decodeUser(raw: unknown, deployment: Deployment): DecodedField {
  const user = raw as { accountId?: unknown; name?: unknown; key?: unknown; displayName?: unknown };
  const id = deployment === 'cloud' ? user.accountId : (user.name ?? user.key);
  return {
    value: typeof id === 'string' ? id : null,
    display: typeof user.displayName === 'string' ? user.displayName : undefined,
    lossy: [],
  };
}

/**
 * Encodes an agent's value for the request body. The value has already been checked against the
 * type (`workValueProblem`) and, for `user`, resolved to an account by `resolveWorkUser`.
 */
export function encodeWorkField(spec: WorkFieldSpec, value: unknown, deployment: Deployment): unknown {
  if (isEmptyValue(value)) return emptyValue(spec);

  switch (spec.type) {
    case 'markdown':
      return deployment === 'cloud' ? markdownToAdf(value as string) : markdownToWiki(value as string);
    case 'text':
    case 'number':
    case 'date':
    case 'labels':
    case 'raw':
      return value;
    case 'option':
      // Priority is a system field addressed by name; every select field is addressed by value.
      return spec.key === 'priority' ? { name: value } : { value };
    case 'options':
      return (value as string[]).map((item) => ({ value: item }));
    case 'components':
    case 'versions':
      return (value as string[]).map((item) => ({ name: item }));
    case 'user':
      return deployment === 'cloud' ? { accountId: value } : { name: value };
    case 'issue':
      // `parent` takes an issue reference; an Epic Link custom field takes the bare key.
      return spec.key === 'parent' ? { key: value } : value;
  }
}

/** An account id on Cloud: the modern `712020:uuid` form, or the older 24-character hex. */
const ACCOUNT_ID = /^(?:\d+:[0-9a-f-]{36}|[0-9a-f]{24})$/i;

/**
 * Turns what an agent passed for a `user` field into the account Jira expects. On Cloud an email
 * or a name is looked up and must match exactly one person — picking the first of several would
 * assign the work to someone nobody named. On Server/DC the username is the identifier already.
 */
export async function resolveWorkUser(client: JiraClient, spec: WorkFieldSpec, value: string): Promise<string> {
  if (client.deployment !== 'cloud' || ACCOUNT_ID.test(value)) return value;
  const found = (await client.searchUsers(value, 10)) as Array<{
    accountId?: string;
    displayName?: string;
    emailAddress?: string;
    active?: boolean;
  }>;
  const people = (Array.isArray(found) ? found : []).filter((user) => user.active !== false && user.accountId);
  const exact = people.filter(
    (user) =>
      user.emailAddress?.toLowerCase() === value.toLowerCase() ||
      user.displayName?.toLowerCase() === value.toLowerCase(),
  );
  const matches = exact.length > 0 ? exact : people;
  const [only, ...others] = matches;
  if (only?.accountId !== undefined && others.length === 0) return only.accountId;
  if (matches.length === 0) throw new ConfigError(`${spec.name}: no active Jira user matches "${value}".`);
  throw new ConfigError(
    `${spec.name}: "${value}" matches ${matches.length} people. Pass one of these account ids:\n` +
      matches.map((user) => `  ${user.accountId ?? '?'}  ${user.displayName ?? ''}`).join('\n'),
  );
}

function choiceName(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return undefined;
  const { value, name } = item as { value?: unknown; name?: unknown };
  if (typeof value === 'string') return value;
  return typeof name === 'string' ? name : undefined;
}

function asList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [raw];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
