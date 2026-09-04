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

import { describe, expect, it } from 'vitest';
import { pageIdFromInput } from '../../src/shared/atlassian-url.js';
import { ConfigError } from '../../src/core/errors.js';

describe('pageIdFromInput', () => {
  it('passes a bare numeric id through', () => {
    expect(pageIdFromInput('123456')).toBe('123456');
    expect(pageIdFromInput('  123456  ')).toBe('123456');
  });

  it('reads the id out of a Cloud page URL, with or without a slug', () => {
    expect(pageIdFromInput('https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/Some+Title')).toBe('123456');
    expect(pageIdFromInput('https://site.atlassian.net/wiki/spaces/DOCS/pages/123456')).toBe('123456');
    expect(pageIdFromInput('https://site.atlassian.net/wiki/spaces/DOCS/pages/123456/')).toBe('123456');
  });

  it('reads the id out of a Server/DC URL, which has no /wiki segment', () => {
    expect(pageIdFromInput('https://confluence.example.gov/pages/viewpage.action?pageId=98765')).toBe('98765');
    expect(pageIdFromInput('https://confluence.example.gov/display/DOCS/Title?pageId=98765')).toBe('98765');
  });

  it('rejects anything it cannot read an id from, naming both accepted forms', () => {
    expect(() => pageIdFromInput('DOCS')).toThrow(ConfigError);
    expect(() => pageIdFromInput('https://site.atlassian.net/wiki/spaces/DOCS')).toThrow(/numeric id, or a page URL/);
    expect(() => pageIdFromInput('')).toThrow(ConfigError);
  });
});
