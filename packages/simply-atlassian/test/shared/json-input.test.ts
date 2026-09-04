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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/errors.js';
import { mergeFields, parseBodyInput } from '../../src/shared/json-input.js';

function writeBody(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'simply-body-')), 'body.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('parseBodyInput', () => {
  it('returns undefined when neither source is given', () => {
    expect(parseBodyInput(undefined, undefined)).toBeUndefined();
  });

  it('parses an inline body', () => {
    expect(parseBodyInput('{"fields":{"summary":"x"}}', undefined)).toEqual({ fields: { summary: 'x' } });
  });

  it('parses a body file', () => {
    expect(parseBodyInput(undefined, writeBody('{"a":1}'))).toEqual({ a: 1 });
  });

  it('refuses both sources at once rather than picking a winner', () => {
    expect(() => parseBodyInput('{}', '/tmp/x.json')).toThrow(ConfigError);
  });

  it('names the parse position for malformed JSON', () => {
    expect(() => parseBodyInput('{not json', undefined)).toThrow(/position/);
  });

  it('requires a JSON object, not an array or scalar', () => {
    expect(() => parseBodyInput('[1,2]', undefined)).toThrow(/must be a JSON object/);
    expect(() => parseBodyInput('"text"', undefined)).toThrow(/must be a JSON object/);
    expect(() => parseBodyInput('null', undefined)).toThrow(/must be a JSON object/);
  });

  it('reports a missing body file by path', () => {
    expect(() => parseBodyInput(undefined, '/nonexistent/body.json')).toThrow(/not found/);
  });
});

describe('mergeFields', () => {
  it('merges typed fields over a body so a flag can override a template', () => {
    const body = { fields: { summary: 'from file', project: { key: 'OLD' } } };
    expect(mergeFields(body, { summary: 'from flag' })).toEqual({
      fields: { summary: 'from flag', project: { key: 'OLD' } },
    });
  });

  it('keeps non-fields keys from the body untouched', () => {
    expect(mergeFields({ update: { labels: [] }, fields: {} }, { summary: 'x' })).toEqual({
      update: { labels: [] },
      fields: { summary: 'x' },
    });
  });

  it('refuses a body key Jira would silently ignore, naming the likely intent', () => {
    // Found in review: the docs said "fields JSON", the code took a full request body, so a
    // custom field written at top level was dropped and the command still reported success.
    /* eslint-disable camelcase -- a real Jira custom field is named exactly this */
    expect(() => mergeFields({ customfield_10011: 'sprint-x' }, { summary: 's' })).toThrow(ConfigError);
    expect(() => mergeFields({ customfield_10011: 'x' }, {})).toThrow(/belong under "fields"/);
    /* eslint-enable camelcase */
  });

  it('accepts the top-level keys the API actually reads', () => {
    expect(() => mergeFields({ fields: {}, update: {}, transition: { id: '1' } }, {})).not.toThrow();
    expect(() => mergeFields({ historyMetadata: {}, properties: [] }, {})).not.toThrow();
  });

  it('works with no body at all', () => {
    expect(mergeFields(undefined, { summary: 'x' })).toEqual({ fields: { summary: 'x' } });
  });

  it('tolerates a body whose fields key is not an object', () => {
    expect(mergeFields({ fields: 'nonsense' }, { summary: 'x' })).toEqual({ fields: { summary: 'x' } });
  });
});
