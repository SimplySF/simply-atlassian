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

import { ConfigError } from './errors.js';
import { stripControlOneLine } from './text.js';

/** A link type as the instance reports it. Both phrases are configurable per instance. */
export interface LinkType {
  readonly id?: string;
  readonly name?: string;
  readonly inward?: string;
  readonly outward?: string;
}

export interface LinkTypesResponse {
  readonly issueLinkTypes?: LinkType[];
}

/** One end of a link, plus the phrase describing it, ready to POST. */
export interface ResolvedLink {
  readonly type: LinkType;
  /** The type's own phrase for this direction, so a summary reads as a sentence. */
  readonly phrase: string;
  readonly inwardIssue: string;
  readonly outwardIssue: string;
}

/** How many types an error lists before summarising the rest. */
const MAX_LISTED = 20;

function normalise(value: string): string {
  // Collapsed rather than merely trimmed, so `"is  blocked   by"` matches `"is blocked by"`.
  return value.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

/** Names a type by everything a caller could have typed, since a match may come from any of them. */
function describe(type: LinkType): string {
  // Administrator-defined prose, kept to one line for the same reason as a display name: it is
  // interpolated into a message whose own line breaks carry meaning.
  const name = stripControlOneLine(type.name ?? '(unnamed)');
  const phrases = [type.outward, type.inward]
    .filter((phrase): phrase is string => phrase !== undefined)
    .map((phrase) => stripControlOneLine(phrase));
  return phrases.length === 0 ? name : `${name} ("${phrases.join('" / "')}")`;
}

/**
 * Works out which issue goes in which end of a link, from a phrase said the natural way round.
 *
 * The mapping is the one genuinely counter-intuitive thing in this file, so it is stated here
 * once and asserted by tests. Atlassian's rule for rendering a link is that an entry containing
 * an `inwardIssue` field is labeled with `type.inward`. Read from the side of the issue you
 * fetched, that means the issue occupying the **`inwardIssue`** field is the *subject* of the
 * **outward** phrase — the opposite of what the field names suggest.
 *
 * So for `Blocks` (outward `blocks`, inward `is blocked by`):
 *
 * | Intent            | inwardIssue | outwardIssue |
 * | ----------------- | ----------- | ------------ |
 * | A blocks B        | A           | B            |
 * | A is blocked by B | B           | A            |
 *
 * Getting this backwards produces a link that exists, looks plausible in every payload, and
 * states the reverse of what was asked — with no error anywhere. That is why the phrase is
 * resolved centrally rather than at each call site.
 *
 * A phrase naming the inward direction flips the pair instead of being rejected, because both
 * ways of saying it are natural and an agent will use whichever the source text used.
 */
export function resolveLinkDirection(
  types: readonly LinkType[],
  from: string,
  phrase: string,
  to: string,
): ResolvedLink {
  const wanted = normalise(phrase);
  if (wanted === '') throw new ConfigError('The link type cannot be empty.');

  // Built lazily and capped. Every entry is instance-supplied prose that lands in an agent's
  // context, so it is bounded, and a successful create should not pay to format it at all.
  const available = (): string => {
    const shown = types.slice(0, MAX_LISTED).map((type) => describe(type));
    const rest = types.length - shown.length;
    return shown.join(', ') + (rest > 0 ? `, and ${rest} more — see "issue link types"` : '');
  };
  const unmatched = (): never => {
    throw new ConfigError(
      `No link type matches "${phrase}".` +
        (types.length === 0
          ? ' This instance reports no link types, which usually means issue linking is disabled.'
          : ` Available: ${available()}. Pass a type name or either of its phrases.`),
    );
  };

  const byOutward = types.filter((type) => type.outward !== undefined && normalise(type.outward) === wanted);
  const byInward = types.filter((type) => type.inward !== undefined && normalise(type.inward) === wanted);
  const byName = types.filter((type) => type.name !== undefined && normalise(type.name) === wanted);

  // Outward is preferred over inward across all types, because an outward phrase is how anyone
  // states a relationship out loud and an inward one is its passive form. A symmetric type —
  // `Relates`, whose phrases are identical — appears in both lists as the same entry, which is
  // not ambiguity: either orientation describes the same fact.
  const [phraseMatches, inverted] = byOutward.length > 0 ? [byOutward, false] : [byInward, true];

  // A name and a phrase are different kinds of token, so one cannot be ranked over the other the
  // way outward is ranked over inward. When they point at different types there is no principled
  // winner, and picking one silently is the failure this module exists to prevent.
  const collides =
    phraseMatches.length > 0 && byName.length > 0 && !byName.every((type) => phraseMatches.includes(type));
  if (collides) {
    throw new ConfigError(
      `"${phrase}" is the name of one link type and a phrase of another, so the relationship is ` +
        `not clear: ${[...new Set([...phraseMatches, ...byName])].map((type) => describe(type)).join(', ')}. ` +
        'Pass a phrase unique to the one you mean.',
    );
  }

  // A bare type name is read as its outward phrase: `link create A Blocks B` means "A blocks B".
  const [matches, flip] = phraseMatches.length > 0 ? [phraseMatches, inverted] : [byName, false];
  if (matches.length === 0) unmatched();

  if (matches.length > 1) {
    throw new ConfigError(
      `"${phrase}" matches more than one link type, so the relationship is not clear: ` +
        `${matches.map((type) => describe(type)).join(', ')}. Pass a phrase unique to one of them.`,
    );
  }

  const type = matches[0];
  if (type === undefined) unmatched();
  if (type.id === undefined && type.name === undefined) {
    throw new ConfigError(`The instance reported a link type matching "${phrase}" with no id or name.`);
  }

  const subject = flip ? to : from;
  const object = flip ? from : to;
  // Echoed as the type's own canonical phrase rather than the caller's raw input, so a bare name
  // reads back as a sentence ("A blocks B", not "A Blocks B") and odd spacing is normalised.
  const canonical = (flip ? type.inward : type.outward) ?? phrase.trim();
  // Subject of the outward phrase goes in `inwardIssue`. See the table above.
  return { type, phrase: canonical, inwardIssue: subject, outwardIssue: object };
}

/** A link as it appears in an issue's `issuelinks` field, where one end names the counterpart. */
export interface IssueLink {
  readonly id?: string;
  readonly type?: LinkType;
  readonly inwardIssue?: LinkedIssue;
  readonly outwardIssue?: LinkedIssue;
}

export interface LinkedIssue {
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly status?: { readonly name?: string };
  };
}

/** Said of a link whose direction the instance did not describe well enough to state. */
const UNDIRECTED = 'is linked to';

/**
 * Renders one link from the perspective of the issue it was read from, so a reader never has to
 * work out which side they are on.
 *
 * Per Atlassian's labeling rule: the end that is present names the *other* issue, and the phrase
 * to use is the one matching that end's name — an `inwardIssue` end takes `type.inward`.
 *
 * When the needed phrase is missing or blank, this deliberately does **not** fall back to the
 * type's name. `resolveLinkDirection` reads a bare name as the *outward* phrase, so rendering an
 * inward end as `Blocks` would read as "this issue blocks that one" — the exact reversal this
 * module exists to prevent. A direction that cannot be stated is stated as no direction.
 */
export function describeLinkFromIssue(link: IssueLink): { phrase: string; other: LinkedIssue | undefined } {
  const usable = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value;

  // Both ends present is malformed for this shape; naming neither direction beats guessing one.
  if (link.inwardIssue !== undefined && link.outwardIssue !== undefined) {
    return { phrase: UNDIRECTED, other: link.inwardIssue };
  }
  if (link.inwardIssue !== undefined) {
    return { phrase: usable(link.type?.inward) ?? UNDIRECTED, other: link.inwardIssue };
  }
  return { phrase: usable(link.type?.outward) ?? UNDIRECTED, other: link.outwardIssue };
}
