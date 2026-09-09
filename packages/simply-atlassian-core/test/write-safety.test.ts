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
import { ConfigError } from '../src/errors.js';
import { collectSecrets, redactSecrets, sanitiseDeep, secretValues } from '../src/redaction.js';
import { assertWritesAllowed, isReadOnly } from '../src/write-safety.js';

describe('the read-only guard', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
    it(`refuses a write when ATLASSIAN_READ_ONLY is "${value}"`, () => {
      const env = { ATLASSIAN_READ_ONLY: value };
      expect(isReadOnly(env)).toBe(true);
      expect(() => assertWritesAllowed(env)).toThrow(ConfigError);
      expect(() => assertWritesAllowed(env)).toThrow(/ATLASSIAN_READ_ONLY/);
    });
  }

  it('ignores a value that does not mean yes, and an absent variable', () => {
    expect(isReadOnly({ ATLASSIAN_READ_ONLY: 'false' })).toBe(false);
    expect(isReadOnly({})).toBe(false);
    expect(() => assertWritesAllowed({ ATLASSIAN_READ_ONLY: '0' })).not.toThrow();
  });
});

describe('redaction', () => {
  it('collects only values long enough to be a credential', () => {
    expect([...collectSecrets(['short', undefined, 'long-enough-token'])]).toEqual(['long-enough-token']);
  });

  it('reads the credential variables out of an environment', () => {
    const secrets = secretValues({
      JIRA_API_TOKEN: 'jira-token-1',
      CONFLUENCE_PERSONAL_TOKEN: 'conf-pat-2',
      OTHER: 'x',
    });
    expect([...secrets].sort()).toEqual(['conf-pat-2', 'jira-token-1']);
  });

  it('blanks every occurrence of every secret', () => {
    expect(redactSecrets('a secret-one b secret-one c secret-two', ['secret-one', 'secret-two'])).toBe(
      'a <redacted> b <redacted> c <redacted>',
    );
  });

  it('sanitises a response body recursively, keys included', () => {
    const body = {
      errorMessages: ['bad secret-one[2K'],
      errors: { ['field']: { nested: ['secret-one'] } },
      status: 400,
    };
    expect(sanitiseDeep(body, ['secret-one'])).toEqual({
      errorMessages: ['bad <redacted>[2K'],
      errors: { field: { nested: ['<redacted>'] } },
      status: 400,
    });
  });

  it('stops walking a pathologically deep body rather than overflowing', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = [deep];
    expect(JSON.stringify(sanitiseDeep(deep, []))).not.toContain('leaf');
  });
});
