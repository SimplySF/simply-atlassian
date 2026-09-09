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
import { issueUrl, pageIdFromInput, pageUrl, projectUrl } from '../src/atlassian-url.js';
import { ConfigError } from '../src/errors.js';

describe('browser URL builders', () => {
  it('builds an encoded issue URL without a duplicate trailing slash', () => {
    expect(issueUrl('https://jira.example.gov/', 'PROJ/1')).toBe('https://jira.example.gov/browse/PROJ%2F1');
  });

  it('builds the universal project URL for Cloud and Server/DC bases', () => {
    expect(projectUrl('https://example.atlassian.net', 'PROJ')).toBe('https://example.atlassian.net/browse/PROJ');
    expect(projectUrl('https://jira.example.gov/', 'OPS')).toBe('https://jira.example.gov/browse/OPS');
  });

  it('builds the page URL from either Cloud or Server/DC base shapes', () => {
    expect(pageUrl('https://example.atlassian.net/wiki', '123456')).toBe(
      'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=123456',
    );
    expect(pageUrl('https://confluence.example.gov/', '987/65')).toBe(
      'https://confluence.example.gov/pages/viewpage.action?pageId=987%2F65',
    );
  });
});

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
