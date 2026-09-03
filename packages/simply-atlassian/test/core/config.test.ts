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
import { resolveConfluenceConfig, resolveJiraConfig } from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';

const CLOUD_ENV = {
  JIRA_URL: 'https://example.atlassian.net',
  JIRA_USERNAME: 'user@example.com',
  JIRA_API_TOKEN: 'api-token',
};

const SERVER_ENV = {
  JIRA_URL: 'https://jira.internal.example.gov',
  JIRA_PERSONAL_TOKEN: 'pat-token',
};

describe('resolveJiraConfig', () => {
  it('detects Cloud from an .atlassian.net hostname and uses Basic auth', () => {
    const config = resolveJiraConfig({}, CLOUD_ENV);

    expect(config.deployment).toBe('cloud');
    expect(config.url).toBe('https://example.atlassian.net');
    expect(config.auth).toEqual({ kind: 'basic', username: 'user@example.com', apiToken: 'api-token' });
  });

  it('detects Server/DC from any other hostname and uses a PAT', () => {
    const config = resolveJiraConfig({}, SERVER_ENV);

    expect(config.deployment).toBe('server');
    expect(config.auth).toEqual({ kind: 'bearer', personalToken: 'pat-token' });
  });

  it('lets flag overrides beat the environment', () => {
    const config = resolveJiraConfig({ url: 'https://other.atlassian.net', apiToken: 'flag-token' }, CLOUD_ENV);

    expect(config.url).toBe('https://other.atlassian.net');
    expect(config.auth).toEqual({ kind: 'basic', username: 'user@example.com', apiToken: 'flag-token' });
  });

  it('names every missing Cloud variable', () => {
    expect(() => resolveJiraConfig({}, { JIRA_URL: 'https://example.atlassian.net' })).toThrow(
      /JIRA_USERNAME and JIRA_API_TOKEN/,
    );
  });

  it('hints when Cloud credentials are supplied to a Server instance', () => {
    expect(() => resolveJiraConfig({}, { JIRA_URL: 'https://jira.example.gov', JIRA_API_TOKEN: 'token' })).toThrow(
      /JIRA_PERSONAL_TOKEN.*only apply to Cloud/s,
    );
  });

  it('rejects a missing URL with the variable name and flag', () => {
    expect(() => resolveJiraConfig({}, {})).toThrow(ConfigError);
    expect(() => resolveJiraConfig({}, {})).toThrow(/JIRA_URL|--jira-url/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => resolveJiraConfig({}, { ...CLOUD_ENV, JIRA_URL: 'not a url' })).toThrow(ConfigError);
  });

  it('rejects an SSL_VERIFY opt-out with a CA-bundle hint instead of silently ignoring it', () => {
    // Carried over from other Atlassian tooling, this used to disable certificate checking.
    // Failing loudly beats leaving a user wrong about whether verification is on.
    for (const value of ['false', '0', 'no', 'off']) {
      expect(() => resolveJiraConfig({}, { ...SERVER_ENV, JIRA_SSL_VERIFY: value })).toThrow(ConfigError);
    }
    expect(() => resolveJiraConfig({}, { ...SERVER_ENV, JIRA_SSL_VERIFY: 'false' })).toThrow(/NODE_EXTRA_CA_CERTS/);
  });

  it('accepts an SSL_VERIFY value that keeps verification on', () => {
    expect(() => resolveJiraConfig({}, { ...SERVER_ENV, JIRA_SSL_VERIFY: 'true' })).not.toThrow();
  });

  it('strips trailing slashes from the base URL', () => {
    expect(resolveJiraConfig({}, { ...CLOUD_ENV, JIRA_URL: 'https://example.atlassian.net/' }).url).toBe(
      'https://example.atlassian.net',
    );
  });
});

describe('resolveConfluenceConfig', () => {
  const env = {
    CONFLUENCE_USERNAME: 'user@example.com',
    CONFLUENCE_API_TOKEN: 'api-token',
  };

  it('canonicalizes a bare Cloud URL to /wiki', () => {
    const config = resolveConfluenceConfig({}, { ...env, CONFLUENCE_URL: 'https://example.atlassian.net' });

    expect(config.url).toBe('https://example.atlassian.net/wiki');
  });

  it('leaves an already-canonical Cloud URL alone', () => {
    const config = resolveConfluenceConfig({}, { ...env, CONFLUENCE_URL: 'https://example.atlassian.net/wiki' });

    expect(config.url).toBe('https://example.atlassian.net/wiki');
  });

  it('canonicalizes odd casing like /WIKI instead of trusting it', () => {
    const config = resolveConfluenceConfig({}, { ...env, CONFLUENCE_URL: 'https://example.atlassian.net/WIKI' });

    expect(config.url).toBe('https://example.atlassian.net/wiki');
  });

  it('truncates a pasted deep Cloud page URL back to the API root', () => {
    const config = resolveConfluenceConfig(
      {},
      { ...env, CONFLUENCE_URL: 'https://example.atlassian.net/wiki/spaces/DOCS/pages/123' },
    );

    expect(config.url).toBe('https://example.atlassian.net/wiki');
  });

  it('never appends /wiki for Server/DC', () => {
    const config = resolveConfluenceConfig(
      {},
      { CONFLUENCE_URL: 'https://confluence.example.gov', CONFLUENCE_PERSONAL_TOKEN: 'pat' },
    );

    expect(config.url).toBe('https://confluence.example.gov');
  });
});
