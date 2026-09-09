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
import { pageIdForInstance, pageIdFromInput } from '../src/atlassian-url.js';

/*
 * Page-reference ambiguity, kept in its own file rather than appended to atlassian-url.test.ts:
 * that file is a natural place for several people to add blocks at once, and these assertions
 * are about one specific hazard — a reference that resolves to a page the caller did not name.
 *
 * Both cases below were found by security review and reproduced against the built binary.
 */

describe('page reference ambiguity', () => {
  it('prefers the path over the query string, which is what a reader sees', () => {
    expect(pageIdFromInput('https://s.atlassian.net/wiki/spaces/D/pages/123456/Title')).toBe('123456');
  });

  /*
   * `?pageId=` used to win. So a link rendering as page 123456 "Quarterly-plan" resolved to
   * 999999, and `page delete --purge` destroyed a page nobody named. Anyone who can put a link in
   * a page, a comment or a ticket controlled that, and the printed title was no defence — it was
   * the title of the wrong page.
   */
  it('refuses a URL whose path and query name different pages', () => {
    const misleading = 'https://s.atlassian.net/wiki/spaces/D/pages/123456/Quarterly-plan?pageId=999999';

    expect(() => pageIdFromInput(misleading)).toThrow(/names two different pages/);
    expect(() => pageIdFromInput(misleading)).toThrow(/123456/);
    expect(() => pageIdFromInput(misleading)).toThrow(/999999/);
  });

  it('still accepts the Server viewpage form, where the query is the only source', () => {
    expect(pageIdFromInput('https://wiki.corp/pages/viewpage.action?pageId=777')).toBe('777');
  });

  it('accepts a query-only URL when they agree', () => {
    expect(pageIdFromInput('https://s.atlassian.net/x?pageId=555')).toBe('555');
  });
});

describe('pageIdForInstance', () => {
  const configured = 'https://mine.atlassian.net/wiki';

  it('passes a bare id through, since it carries no host to disagree with', () => {
    expect(pageIdForInstance('123456', configured)).toBe('123456');
  });

  it('accepts a URL on the configured host', () => {
    expect(pageIdForInstance('https://mine.atlassian.net/wiki/spaces/D/pages/123456/T', configured)).toBe('123456');
  });

  it('ignores case in the host comparison', () => {
    expect(pageIdForInstance('https://MINE.atlassian.net/wiki/spaces/D/pages/123456/T', configured)).toBe('123456');
  });

  /*
   * An id from another tenant is still a valid id *here*. An agent handed a link by a page or a
   * ticket would otherwise act on whatever happens to carry that number on the configured
   * instance — which for a destructive command is somebody else's page.
   */
  it('refuses a URL pointing at a different instance', () => {
    expect(() => pageIdForInstance('https://evil.example.com/wiki/spaces/X/pages/777/T', configured)).toThrow(
      /points at evil\.example\.com/,
    );
  });

  it('names the id so a caller who meant it can pass it directly', () => {
    expect(() => pageIdForInstance('https://other.atlassian.net/wiki/spaces/X/pages/777/T', configured)).toThrow(/777/);
  });
});
