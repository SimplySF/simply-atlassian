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
import { resolveConfluenceConfig, resolveJiraConfig } from '../src/config.js';
import { deprecatedEnvInUse, deprecatedEnvWarning, envValue, LEGACY_ENV } from '../src/env-vars.js';
import { secretValues } from '../src/redaction.js';
import { isReadOnly } from '../src/write-safety.js';

describe('LEGACY_ENV', () => {
  it('maps every SIMPLY_ name to the same name without the prefix', () => {
    for (const [current, legacy] of Object.entries(LEGACY_ENV)) {
      expect(current).toBe(`SIMPLY_${legacy}`);
    }
  });
});

describe('envValue', () => {
  it('prefers the prefixed name', () => {
    expect(envValue({ SIMPLY_JIRA_URL: 'new', JIRA_URL: 'old' }, 'SIMPLY_JIRA_URL')).toBe('new');
  });

  it('falls back to the deprecated name when the prefixed one is unset or empty', () => {
    expect(envValue({ JIRA_URL: 'old' }, 'SIMPLY_JIRA_URL')).toBe('old');
    expect(envValue({ SIMPLY_JIRA_URL: '', JIRA_URL: 'old' }, 'SIMPLY_JIRA_URL')).toBe('old');
  });

  it('returns what is there when neither name has a value', () => {
    expect(envValue({}, 'SIMPLY_JIRA_URL')).toBeUndefined();
    expect(envValue({ SIMPLY_JIRA_URL: '' }, 'SIMPLY_JIRA_URL')).toBe('');
  });
});

describe('deprecated names still configure every setting', () => {
  it('resolves Jira Cloud and Confluence Server from unprefixed names', () => {
    expect(
      resolveJiraConfig({}, { JIRA_URL: 'https://example.atlassian.net', JIRA_USERNAME: 'me', JIRA_API_TOKEN: 't' }),
    ).toStrictEqual({
      url: 'https://example.atlassian.net',
      deployment: 'cloud',
      auth: { kind: 'basic', username: 'me', apiToken: 't' },
    });
    expect(
      resolveConfluenceConfig({}, { CONFLUENCE_URL: 'https://wiki.example.gov', CONFLUENCE_PERSONAL_TOKEN: 'pat' })
        .auth,
    ).toStrictEqual({ kind: 'bearer', personalToken: 'pat' });
  });

  it('lets a prefixed name override its deprecated one', () => {
    const config = resolveJiraConfig(
      {},
      { SIMPLY_JIRA_URL: 'https://jira.example.gov', JIRA_URL: 'https://other.example.gov', JIRA_PERSONAL_TOKEN: 'p' },
    );
    expect(config.url).toBe('https://jira.example.gov');
  });

  it('honours ATLASSIAN_READ_ONLY and JIRA_SSL_VERIFY', () => {
    expect(isReadOnly({ ATLASSIAN_READ_ONLY: '1' })).toBe(true);
    expect(isReadOnly({ SIMPLY_ATLASSIAN_READ_ONLY: '0', ATLASSIAN_READ_ONLY: '1' })).toBe(false);
    expect(() =>
      resolveJiraConfig({}, { SIMPLY_JIRA_URL: 'https://jira.example.gov', JIRA_SSL_VERIFY: 'false' }),
    ).toThrow(/SIMPLY_JIRA_SSL_VERIFY=false is not supported/);
  });

  it('redacts tokens under either name', () => {
    const secrets = secretValues({
      JIRA_API_TOKEN: 'legacy-token-value',
      SIMPLY_JIRA_API_TOKEN: 'current-token-value',
    });
    expect([...secrets].sort()).toStrictEqual(['current-token-value', 'legacy-token-value']);
  });
});

describe('deprecation reporting', () => {
  it('reports nothing when only prefixed names are used', () => {
    expect(deprecatedEnvInUse({ SIMPLY_JIRA_URL: 'x' })).toStrictEqual([]);
    expect(deprecatedEnvWarning({ SIMPLY_JIRA_URL: 'x' })).toBeUndefined();
  });

  it('reports a deprecated name only when it is the one supplying the value', () => {
    // Shadowed by its prefixed name, JIRA_URL is likely there for another tool and is ignored.
    expect(
      deprecatedEnvInUse({ SIMPLY_JIRA_URL: 'x', JIRA_URL: 'y', JIRA_API_TOKEN: 'z', CONFLUENCE_URL: '' }),
    ).toStrictEqual([{ legacy: 'JIRA_API_TOKEN', current: 'SIMPLY_JIRA_API_TOKEN' }]);
  });

  it('names every rename in one line, without values', () => {
    const warning = deprecatedEnvWarning({ JIRA_URL: 'https://jira.example.gov', ATLASSIAN_READ_ONLY: '1' });
    expect(warning).toBe(
      'Deprecated environment variables in use: ATLASSIAN_READ_ONLY → SIMPLY_ATLASSIAN_READ_ONLY, ' +
        'JIRA_URL → SIMPLY_JIRA_URL. Rename to the SIMPLY_ prefix; the unprefixed names will stop ' +
        'working in a future major release.',
    );
    expect(warning).not.toContain('jira.example.gov');
  });

  it('uses the singular for one variable', () => {
    expect(deprecatedEnvWarning({ JIRA_URL: 'x' })).toMatch(/^Deprecated environment variable in use: /);
  });
});
