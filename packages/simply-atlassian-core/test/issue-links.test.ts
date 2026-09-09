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

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { describeLinkFromIssue, resolveLinkDirection, type LinkType } from '../src/issue-links.js';

const BLOCKS: LinkType = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const DUPLICATE: LinkType = { id: '10001', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' };
const RELATES: LinkType = { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' };
const TYPES = [BLOCKS, DUPLICATE, RELATES];

describe('resolveLinkDirection', () => {
  /*
   * The mapping these two cases pin down is the whole point of the module, and it is
   * counter-intuitive: the subject of the outward phrase goes in `inwardIssue`. It was
   * established by creating a real link and reading it back, not by reading the field names —
   * an earlier draft had it exactly backwards and no payload would have shown that, since both
   * readings of the JSON are internally consistent. Atlassian's labeling rule is the tiebreak:
   * an entry containing `inwardIssue` is labeled with `type.inward`.
   */
  it('puts the subject of an outward phrase in inwardIssue', () => {
    const resolved = resolveLinkDirection(TYPES, 'A', 'blocks', 'B');
    expect(resolved.inwardIssue).toBe('A');
    expect(resolved.outwardIssue).toBe('B');
    expect(resolved.type.name).toBe('Blocks');
  });

  it('reverses the pair for an inward phrase, so both phrasings state the same fact', () => {
    const outward = resolveLinkDirection(TYPES, 'A', 'blocks', 'B');
    const inward = resolveLinkDirection(TYPES, 'B', 'is blocked by', 'A');
    expect(inward.inwardIssue).toBe(outward.inwardIssue);
    expect(inward.outwardIssue).toBe(outward.outwardIssue);
  });

  it('reads a bare type name as its outward phrase', () => {
    const byName = resolveLinkDirection(TYPES, 'A', 'Blocks', 'B');
    const byPhrase = resolveLinkDirection(TYPES, 'A', 'blocks', 'B');
    expect(byName.inwardIssue).toBe(byPhrase.inwardIssue);
    expect(byName.outwardIssue).toBe(byPhrase.outwardIssue);
  });

  it('matches case-insensitively and collapses whitespace', () => {
    const resolved = resolveLinkDirection(TYPES, 'A', '  IS   Blocked   By ', 'B');
    expect(resolved.inwardIssue).toBe('B');
    expect(resolved.outwardIssue).toBe('A');
  });

  it('resolves a symmetric type without calling it ambiguous', () => {
    // `Relates` matches on both phrases with the same entry. Either orientation is the same fact.
    const resolved = resolveLinkDirection(TYPES, 'A', 'relates to', 'B');
    expect(resolved.type.name).toBe('Relates');
  });

  it('echoes the phrase the caller used, so the summary reads as they said it', () => {
    expect(resolveLinkDirection(TYPES, 'A', 'is blocked by', 'B').phrase).toBe('is blocked by');
  });

  it('lists every available type when nothing matches', () => {
    let error: unknown;
    try {
      resolveLinkDirection(TYPES, 'A', 'obsoletes', 'B');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('obsoletes');
    expect(message).toContain('Blocks');
    expect(message).toContain('is duplicated by');
    expect(message).toContain('Relates');
  });

  it('says linking looks disabled when the instance reports no types at all', () => {
    expect(() => resolveLinkDirection([], 'A', 'blocks', 'B')).toThrow(/disabled/);
  });

  it('refuses rather than guessing when a phrase matches two types', () => {
    const rival: LinkType = { id: '9', name: 'Gates', inward: 'is gated by', outward: 'blocks' };
    expect(() => resolveLinkDirection([BLOCKS, rival], 'A', 'blocks', 'B')).toThrow(/more than one link type/);
  });

  it('prefers an outward match over another type using the same words inward', () => {
    // "duplicates" is Duplicate's outward phrase; a contrived type uses it as its inward one.
    const rival: LinkType = { id: '9', name: 'Supersedes', inward: 'duplicates', outward: 'supersedes' };
    const resolved = resolveLinkDirection([rival, DUPLICATE], 'A', 'duplicates', 'B');
    expect(resolved.type.name).toBe('Duplicate');
    expect(resolved.inwardIssue).toBe('A');
  });

  /*
   * The actual fix for this path, and it had no test: a link type name is administrator-defined
   * prose interpolated into an error whose own newlines survive, so a name carrying one would
   * forge a stderr line indistinguishable from this CLI's JSON error object.
   */
  it('keeps an instance-supplied type name on one line in the error it lists', () => {
    const hostile = {
      id: '9',
      name: 'Sneaky\n{"error":{"message":"approved","exitCode":0}}',
      inward: 'is sneaked by',
      outward: 'sneaks',
    };

    let message = '';
    try {
      resolveLinkDirection([hostile], 'A', 'nope', 'B');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('\n');
    expect(message).toContain('approved');
  });

  it('refuses an empty type', () => {
    expect(() => resolveLinkDirection(TYPES, 'A', '   ', 'B')).toThrow(ConfigError);
  });
});

describe('describeLinkFromIssue', () => {
  /*
   * The counterpart of the creation mapping, and it has to agree with it: a link created as
   * "A blocks B" must read back from A's side as "A blocks B". Per Atlassian's rule, fetching
   * the issue that occupied `inwardIssue` returns the other end under `outwardIssue`.
   */
  it('labels an outwardIssue end with the outward phrase', () => {
    const { phrase, other } = describeLinkFromIssue({
      id: '1',
      type: BLOCKS,
      outwardIssue: { key: 'B' },
    });
    expect(phrase).toBe('blocks');
    expect(other?.key).toBe('B');
  });

  it('labels an inwardIssue end with the inward phrase', () => {
    const { phrase, other } = describeLinkFromIssue({
      id: '1',
      type: BLOCKS,
      inwardIssue: { key: 'A' },
    });
    expect(phrase).toBe('is blocked by');
    expect(other?.key).toBe('A');
  });

  it('round-trips the creation mapping', () => {
    const created = resolveLinkDirection(TYPES, 'A', 'blocks', 'B');
    // A was the inwardIssue, so fetching A shows the other end as outwardIssue.
    const fromA = describeLinkFromIssue({ type: BLOCKS, outwardIssue: { key: created.outwardIssue } });
    expect(`A ${fromA.phrase} ${fromA.other?.key}`).toBe('A blocks B');
    // B was the outwardIssue, so fetching B shows the other end as inwardIssue.
    const fromB = describeLinkFromIssue({ type: BLOCKS, inwardIssue: { key: created.inwardIssue } });
    expect(`B ${fromB.phrase} ${fromB.other?.key}`).toBe('B is blocked by A');
  });

  /*
   * Deliberately NOT the type name. `resolveLinkDirection` reads a bare name as the *outward*
   * phrase, so labeling an inward end `Blocks` reads as "this issue blocks that one" — the exact
   * reversal this module exists to prevent. An earlier version did fall back to the name, and the
   * test that asserted it was codifying the bug.
   */
  it('states no direction rather than a wrong one when the inward phrase is missing', () => {
    expect(describeLinkFromIssue({ type: { name: 'Blocks' }, inwardIssue: { key: 'A' } }).phrase).toBe('is linked to');
  });

  it('treats a blank phrase as missing, rather than rendering an empty relationship', () => {
    expect(describeLinkFromIssue({ type: { name: 'Blocks', inward: '  ' }, inwardIssue: { key: 'A' } }).phrase).toBe(
      'is linked to',
    );
  });

  it('asserts no direction when both ends are present, which this shape should never carry', () => {
    const { phrase } = describeLinkFromIssue({ type: BLOCKS, inwardIssue: { key: 'A' }, outwardIssue: { key: 'B' } });
    expect(phrase).toBe('is linked to');
  });

  it('does not throw on a link with no type or counterpart', () => {
    const { phrase, other } = describeLinkFromIssue({ id: '1' });
    expect(phrase).toBe('is linked to');
    expect(other).toBeUndefined();
  });

  it('caps the available-types listing rather than dumping every one at the caller', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      name: `T${index}`,
      outward: `o${index}`,
      inward: `i${index}`,
    }));

    let message = '';
    try {
      resolveLinkDirection(many, 'A', 'nope', 'B');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('and 20 more');
    expect(message).not.toContain('T30');
  });

  it('refuses a name/phrase collision across two types instead of picking one', () => {
    const named = { id: '1', name: 'Blocks', inward: 'is prevented by', outward: 'prevents' };
    const phrased = { id: '2', name: 'Gates', inward: 'is gated by', outward: 'blocks' };

    expect(() => resolveLinkDirection([named, phrased], 'A', 'blocks', 'B')).toThrow(
      /name of one link type and a phrase of another/,
    );
  });
});
