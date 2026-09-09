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
import { buildRemoteLinkBody, describeRemoteLink } from '../src/jira-remote-links.js';

describe('buildRemoteLinkBody', () => {
  it('builds the object Jira expects', () => {
    const body = buildRemoteLinkBody({ url: 'https://wiki.test/pages/1', title: 'Requirements' });

    expect(body).toEqual({
      globalId: 'https://wiki.test/pages/1',
      object: { url: 'https://wiki.test/pages/1', title: 'Requirements' },
    });
  });

  it('falls back to the URL as the title, so a link is never blank', () => {
    expect(buildRemoteLinkBody({ url: 'https://x.test/a' })).toMatchObject({
      object: { title: 'https://x.test/a' },
    });
  });

  /*
   * globalId is the link's identity to Jira, so setting it from the URL makes a re-run update the
   * existing link rather than adding a second one pointing at the same page. A script that runs
   * twice is the normal case, not the exception.
   */
  it('uses the URL as the identity, so re-running does not duplicate the link', () => {
    const first = buildRemoteLinkBody({ url: 'https://x.test/a', title: 'One' });
    const again = buildRemoteLinkBody({ url: 'https://x.test/a', title: 'Two' });

    expect(first.globalId).toBe(again.globalId);
  });

  it('carries a relationship, which Jira renders as the grouping heading', () => {
    expect(buildRemoteLinkBody({ url: 'https://x.test/a', relationship: 'documented by' })).toMatchObject({
      relationship: 'documented by',
    });
  });

  it('omits relationship and summary when not given', () => {
    const body = buildRemoteLinkBody({ url: 'https://x.test/a' });

    expect(body).not.toHaveProperty('relationship');
    expect(body.object).not.toHaveProperty('summary');
  });

  /*
   * A remote link lives on the issue for everyone who opens it, so the scheme is checked for the
   * same reason Markdown link targets are: stored content outlives the command that wrote it.
   */
  it('refuses a javascript: target', () => {
    expect(() => buildRemoteLinkBody({ url: 'javascript:alert(1)' })).toThrow(ConfigError);
    expect(() => buildRemoteLinkBody({ url: 'javascript:alert(1)' })).toThrow(/not allowed/);
  });

  it('refuses other non-web schemes', () => {
    for (const url of ['data:text/html,x', 'file:///etc/passwd', 'ftp://host/f']) {
      expect(() => buildRemoteLinkBody({ url })).toThrow(/not allowed/);
    }
  });

  it('refuses a relative target, since Jira needs an absolute URL', () => {
    expect(() => buildRemoteLinkBody({ url: '/wiki/pages/1' })).toThrow(/not a URL/);
  });

  it('refuses an empty URL', () => {
    expect(() => buildRemoteLinkBody({ url: '   ' })).toThrow(/needs a --url/);
  });
});

describe('describeRemoteLink', () => {
  it("reads the row out of Jira's shape", () => {
    const row = describeRemoteLink({
      id: 10_001,
      relationship: 'documented by',
      object: { url: 'https://wiki.test/1', title: 'Spec' },
    });

    expect(row).toEqual({ id: '10001', relationship: 'documented by', title: 'Spec', url: 'https://wiki.test/1' });
  });

  it('says "links to" when Jira reports no relationship, which is the common case', () => {
    expect(describeRemoteLink({ id: 1, object: { url: 'https://x.test' } }).relationship).toBe('links to');
  });

  it('does not crash on a link with no object', () => {
    const row = describeRemoteLink({ id: 1 });

    expect(row.url).toBeUndefined();
    expect(row.title).toBeUndefined();
  });
});
