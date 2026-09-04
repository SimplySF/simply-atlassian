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
import type { JiraClient } from '../core/jira-client.js';

/** Enough of Jira's user shape to identify a person and tell two candidates apart. */
interface JiraUser {
  readonly accountId?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
  readonly active?: boolean;
}

export interface ResolvedMention {
  readonly account: string;
  /** Undefined when the caller gave a bare id, since no name was looked up. */
  readonly display?: string;
}

/**
 * Cloud account ids come in more than one shape — `70121:8d8e…`, `qm:8b1e…`, and the older
 * colon-less 24-hex form — and `jira user search` prints whichever the tenant uses. Missing a
 * shape means the id is searched as if it were a name, which finds nothing and reports "no
 * user matches" for a perfectly valid id.
 */
const ACCOUNT_ID_SHAPES = [
  // `70121:8d8e…`, `qm:8b1e…` — a prefix, a colon, then a uuid-ish tail.
  /^[\da-z]+:[\da-f-]{8,}$/i,
  // The colon-less 24-character form, e.g. `5b10a2844c20165700ede21g`. Alphanumeric, not hex:
  // Atlassian's own documented example ends in `g`, and a hex-only pattern rejected it.
  /^[\da-z]{24}$/i,
];

/** An explicit prefix, for an id whose shape this cannot recognise. */
const EXPLICIT_PREFIX = 'account:';

/**
 * How many candidates an ambiguity error lists, and how many are fetched. Kept small on purpose:
 * a wall of matches is the least useful form of "retry precisely", and every extra row is a
 * colleague's name landing somewhere the operator did not ask for it to go.
 */
const MAX_LISTED = 5;

function looksLikeAccountId(term: string): boolean {
  return ACCOUNT_ID_SHAPES.some((shape) => shape.test(term));
}

/**
 * Identifies a candidate without quoting their email. The account id is the whole remediation
 * — the message tells the caller to pass one — so an address adds nothing, and this error is a
 * path the operator did not ask for: they wanted to post a comment, not receive a staff list.
 */
function describe(user: JiraUser): string {
  const id = user.accountId ?? user.name ?? '(no id)';
  const name = user.displayName ?? user.name ?? '(no name)';
  const state = user.active === false ? ' [inactive]' : '';
  return `${id} — ${name}${state}`;
}

/**
 * Turns each `--mention` term into an account, and a display name when one was looked up.
 *
 * A term that is already an account id passes through without a lookup; `account:` forces that
 * for an id shape this does not recognise. Anything else is searched, and **ambiguity is an
 * error**: silently taking the first of several matches is how the wrong person gets mentioned,
 * and the consequence is a real notification to a real person about work they have no context
 * for. The error lists candidates one per line with their ids so the caller — often an agent —
 * can retry precisely rather than guess again.
 *
 * Deactivated accounts are excluded before counting. Without that, a person with an old
 * duplicate account makes their own email ambiguous, and a lone deactivated match would resolve
 * silently to an account that never receives the notification.
 */
export async function resolveMentions(client: JiraClient, terms: readonly string[]): Promise<ResolvedMention[]> {
  const resolved: ResolvedMention[] = [];

  /* Each term needs its own request, and there is nothing to overlap them with. */
  /* eslint-disable no-await-in-loop */
  for (const raw of terms) {
    const term = raw.trim();
    if (term === '') throw new ConfigError('A --mention value cannot be empty.');

    if (term.startsWith(EXPLICIT_PREFIX)) {
      const account = term.slice(EXPLICIT_PREFIX.length).trim();
      if (account === '') throw new ConfigError(`"${term}" names no account after "${EXPLICIT_PREFIX}".`);
      resolved.push({ account });
      continue;
    }

    if (looksLikeAccountId(term)) {
      // No lookup, and no display name — mentionValue omits the fallback text rather than
      // rendering the id as if it were a name.
      resolved.push({ account: term });
      continue;
    }

    // One more than is listed, so the tail can say honestly that there are others.
    const response = (await client.searchUsers(term, MAX_LISTED + 1)) as JiraUser[] | { values?: JiraUser[] };
    const candidates = Array.isArray(response) ? response : (response.values ?? []);
    const identifiable = candidates.filter((user) => user.accountId !== undefined || user.name !== undefined);
    const usable = identifiable.filter((user) => user.active !== false);

    if (usable.length === 0) {
      const inactive = identifiable.length > 0;
      throw new ConfigError(
        inactive
          ? `The only accounts matching "${term}" are deactivated, so they cannot be notified: ${identifiable
              .slice(0, MAX_LISTED)
              .map((user) => describe(user))
              .join('; ')}.`
          : `No user matches "${term}". Try an email address, which is the most likely to be unique, ` +
              `or "${EXPLICIT_PREFIX}<id>" to pass an account id directly.`,
      );
    }

    if (usable.length > 1) {
      const shown = usable.slice(0, MAX_LISTED).map((user) => `  ${describe(user)}`);
      const more = usable.length > MAX_LISTED ? '\n  …and others; narrow the term or use an email address' : '';
      throw new ConfigError(
        `"${term}" matches more than one user, so it is not clear who to mention. ` +
          `Pass one of these ids instead, as "${EXPLICIT_PREFIX}<id>":\n${shown.join('\n')}${more}`,
      );
    }

    const [user] = usable;
    const account = user?.accountId ?? user?.name;
    if (account === undefined) {
      throw new ConfigError(`The instance returned a user for "${term}" with no id, so they cannot be mentioned.`);
    }
    resolved.push({ account, display: user?.displayName ?? user?.name });
  }
  /* eslint-enable no-await-in-loop */

  return resolved;
}

/** Wraps plain text in the minimal ADF document Cloud accepts. */
function adfDoc(content: unknown[]): Record<string, unknown> {
  return { type: 'doc', version: 1, content };
}

/**
 * Appends mentions to a comment body, in the shape the deployment expects.
 *
 * The deployment is taken from the client, never inferred from the body's shape. Guessing —
 * "this body is a string, so the instance must be Server" — silently dropped every mention on
 * Cloud when a caller supplied a string body, and silently replaced the caller's entire comment
 * with a bare mention on Server when they supplied an ADF one. Both were losses on a write path
 * with no error.
 *
 * Appended rather than interpolated into the caller's text on purpose: substituting `@name`
 * inside the text would mean guessing which `@something` is a mention, and a comment that
 * legitimately quotes an email address or a handle would then either misfire or notify someone
 * nobody named.
 */
export function appendMentions(
  client: JiraClient,
  body: Record<string, unknown>,
  mentions: readonly ResolvedMention[],
): Record<string, unknown> {
  if (mentions.length === 0) return body;

  const shapes = mentions.map((mention) => client.mentionValue(mention.account, mention.display));

  if (client.deployment !== 'cloud') {
    const tokens = shapes.map((shape) => shape.text).join(' ');
    const existing = body.body;
    if (existing === undefined) return { ...body, body: tokens };
    if (typeof existing === 'string') {
      return { ...body, body: existing === '' ? tokens : `${existing}\n\n${tokens}` };
    }
    // Refusing beats appending to something this cannot read, which would discard it.
    throw new ConfigError(
      'This instance expects a plain-text comment body, but the body supplied is not text. ' +
        'Use --text, or a body whose "body" is a string.',
    );
  }

  const paragraph: unknown[] = [];
  for (const [index, shape] of shapes.entries()) {
    if (index > 0) paragraph.push({ type: 'text', text: ' ' });
    paragraph.push(shape.adf);
  }
  const mentionParagraph = { type: 'paragraph', content: paragraph };

  const existing = body.body;
  if (existing === undefined) return { ...body, body: adfDoc([mentionParagraph]) };

  // A string body on Cloud is a caller convenience, not an error: promote it to ADF so the
  // text survives alongside the mentions.
  if (typeof existing === 'string') {
    const text = existing === '' ? [] : [{ type: 'paragraph', content: [{ type: 'text', text: existing }] }];
    return { ...body, body: adfDoc([...text, mentionParagraph]) };
  }

  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    const doc = existing as { version?: number; content?: unknown[] };
    return {
      ...body,
      // The caller's document version is preserved rather than overwritten.
      body: { type: 'doc', version: doc.version ?? 1, content: [...(doc.content ?? []), mentionParagraph] },
    };
  }

  throw new ConfigError('The comment body must be text or an Atlassian Document Format object.');
}
