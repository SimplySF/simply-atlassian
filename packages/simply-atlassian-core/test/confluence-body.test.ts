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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { resolveStorageBody } from '../src/confluence-body.js';

describe('resolveStorageBody', () => {
  it('returns nothing when no source is given, since an empty body is legitimate', () => {
    expect(resolveStorageBody({})).toBeUndefined();
  });

  it('passes --body through verbatim as storage', () => {
    const resolved = resolveStorageBody({ body: '<p>already <strong>storage</strong></p>' });

    expect(resolved).toEqual({
      storage: { value: '<p>already <strong>storage</strong></p>', representation: 'storage' },
    });
  });

  it('reads --body-file verbatim', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'simply-body-')), 'page.xml');
    writeFileSync(path, '<h1>From a file</h1>', 'utf8');

    expect(resolveStorageBody({ 'body-file': path })?.storage.value).toBe('<h1>From a file</h1>');
  });

  it('names a missing file without echoing anything about it', () => {
    let message = '';
    try {
      resolveStorageBody({ 'body-file': '/nope/definitely-not-here.xml' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('not found');
    expect(message).toContain('/nope/definitely-not-here.xml');
  });

  describe('--text', () => {
    it('wraps a single line in a paragraph', () => {
      expect(resolveStorageBody({ text: 'hello' })?.storage.value).toBe('<p>hello</p>');
    });

    it('splits blank-line separated blocks into paragraphs', () => {
      expect(resolveStorageBody({ text: 'one\n\ntwo' })?.storage.value).toBe('<p>one</p><p>two</p>');
    });

    it('turns a single newline into a line break rather than a paragraph', () => {
      expect(resolveStorageBody({ text: 'one\ntwo' })?.storage.value).toBe('<p>one<br />two</p>');
    });

    /*
     * Storage format is XHTML, so unescaped caller text is not merely ugly — an `&` or a stray
     * `<` produces a body the instance rejects, and markup that happens to parse would be
     * silently reinterpreted as formatting the caller never asked for.
     */
    it('escapes markup characters, because --text means text', () => {
      const value = resolveStorageBody({ text: 'a < b & c > d "quoted"' })?.storage.value;

      expect(value).toBe('<p>a &lt; b &amp; c &gt; d &quot;quoted&quot;</p>');
    });

    it('does not let caller text inject a macro', () => {
      const value = resolveStorageBody({ text: '<ac:structured-macro ac:name="html" />' })?.storage.value;

      expect(value).not.toContain('<ac:');
      expect(value).toContain('&lt;ac:structured-macro');
    });

    it('produces an empty paragraph for whitespace only, which Confluence accepts', () => {
      expect(resolveStorageBody({ text: '   \n\n  ' })?.storage.value).toBe('<p />');
    });
  });

  it('refuses more than one source rather than picking a winner', () => {
    expect(() => resolveStorageBody({ text: 'a', body: '<p>b</p>' })).toThrow(ConfigError);
    expect(() => resolveStorageBody({ text: 'a', body: '<p>b</p>' })).toThrow(/only one of/);
  });

  it('names every source the caller actually passed', () => {
    let message = '';
    try {
      resolveStorageBody({ body: '<p>a</p>', 'body-file': './x.xml' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('--body');
    expect(message).toContain('--body-file');
    expect(message).not.toContain('--text');
  });
});
