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

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { buildAuthHeaders } from '../../src/core/auth.js';
import type { AtlassianConfig } from '../../src/core/config.js';

function makeConfig(auth: AtlassianConfig['auth']): AtlassianConfig {
  return { url: 'https://example.atlassian.net', deployment: 'cloud', auth };
}

describe('buildAuthHeaders', () => {
  it('encodes Basic auth as base64(email:token)', () => {
    const headers = buildAuthHeaders(makeConfig({ kind: 'basic', username: 'user@example.com', apiToken: 'secret' }));

    const expected = Buffer.from('user@example.com:secret').toString('base64');
    expect(headers).toEqual({ Authorization: `Basic ${expected}` });
  });

  it('sends a PAT as a Bearer token', () => {
    const headers = buildAuthHeaders(makeConfig({ kind: 'bearer', personalToken: 'pat-secret' }));

    expect(headers).toEqual({ Authorization: 'Bearer pat-secret' });
  });
});
