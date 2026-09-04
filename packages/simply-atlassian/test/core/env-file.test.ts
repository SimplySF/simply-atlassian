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
import { loadEnvFile, parseEnvFile } from '../../src/core/env-file.js';
import { ConfigError } from '../../src/core/errors.js';

function writeEnv(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'simply-atlassian-')), '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('parseEnvFile', () => {
  it('reads plain assignments and ignores blanks and comments', () => {
    expect(
      parseEnvFile(['# a comment', '', 'JIRA_URL=https://jira.example.gov', '  ', '# trailing'].join('\n')),
    ).toEqual({ JIRA_URL: 'https://jira.example.gov' });
  });

  it('tolerates an export prefix and whitespace around the equals sign', () => {
    expect(parseEnvFile('export JIRA_PERSONAL_TOKEN = pat-value')).toEqual({ JIRA_PERSONAL_TOKEN: 'pat-value' });
  });

  it('strips matching quotes, honouring escapes only inside double quotes', () => {
    expect(parseEnvFile('A="line\\none"\nB=\x27raw\\nvalue\x27')).toEqual({ A: 'line\none', B: 'raw\\nvalue' });
  });

  it('drops an inline comment from an unquoted value but keeps hashes inside quotes', () => {
    expect(parseEnvFile('TOKEN=abc123 # the token')).toEqual({ TOKEN: 'abc123' });
    expect(parseEnvFile('TOKEN="abc#123"')).toEqual({ TOKEN: 'abc#123' });
  });

  it('keeps a quoted value intact when an inline comment follows it', () => {
    // The quotes used to survive into the value, so every request failed as bad credentials.
    expect(parseEnvFile('JIRA_API_TOKEN="secret" # prod token')).toEqual({ JIRA_API_TOKEN: 'secret' });
    expect(parseEnvFile("JIRA_API_TOKEN='secret' # prod token")).toEqual({ JIRA_API_TOKEN: 'secret' });
  });

  it('keeps a value that itself contains an equals sign', () => {
    expect(parseEnvFile('JIRA_API_TOKEN=abc=def==')).toEqual({ JIRA_API_TOKEN: 'abc=def==' });
  });

  it('reads CRLF files and strips a leading byte-order mark', () => {
    expect(parseEnvFile('\uFEFFJIRA_URL=https://x\r\nJIRA_PERSONAL_TOKEN=pat\r\n')).toEqual({
      JIRA_URL: 'https://x',
      JIRA_PERSONAL_TOKEN: 'pat',
    });
  });

  it('skips lines that are not assignments rather than failing the whole file', () => {
    expect(parseEnvFile('nonsense\nJIRA_URL=https://x')).toEqual({ JIRA_URL: 'https://x' });
  });
});

describe('loadEnvFile', () => {
  it('applies values that are absent from the environment', () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(writeEnv('JIRA_URL=https://jira.example.gov'), env);

    expect(env.JIRA_URL).toBe('https://jira.example.gov');
  });

  it('never overwrites a variable already set in the environment', () => {
    const env: NodeJS.ProcessEnv = { JIRA_URL: 'https://real.example.gov' };
    loadEnvFile(writeEnv('JIRA_URL=https://from-file.example.gov'), env);

    expect(env.JIRA_URL).toBe('https://real.example.gov');
  });

  it('fills in a variable that is exported as an empty string', () => {
    // `export JIRA_URL=` in a wrapper script carries no value, so it must not beat the file.
    const env: NodeJS.ProcessEnv = { JIRA_URL: '' };
    loadEnvFile(writeEnv('JIRA_URL=https://from-file.example.gov'), env);

    expect(env.JIRA_URL).toBe('https://from-file.example.gov');
  });

  it('ignores variables outside the Atlassian connection set', () => {
    // A .env file may come from a repo or an agent. Applying arbitrary keys would let it set
    // NODE_TLS_REJECT_UNAUTHORIZED=0 and undo certificate verification entirely.
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(
      writeEnv(
        [
          'NODE_TLS_REJECT_UNAUTHORIZED=0',
          'NODE_OPTIONS=--require=/tmp/evil.js',
          'PATH=/tmp/evil',
          'JIRA_URL=https://jira.example.gov',
        ].join('\n'),
      ),
      env,
    );

    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.JIRA_URL).toBe('https://jira.example.gov');
  });

  it('still applies SSL_VERIFY so the explanatory config error can fire', () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(writeEnv('JIRA_SSL_VERIFY=false'), env);

    expect(env.JIRA_SSL_VERIFY).toBe('false');
  });

  it('raises ConfigError for a path that does not exist', () => {
    expect(() => loadEnvFile(join(tmpdir(), 'simply-atlassian-missing', '.env'), {})).toThrow(ConfigError);
    expect(() => loadEnvFile(join(tmpdir(), 'simply-atlassian-missing', '.env'), {})).toThrow(/not found/);
  });
});
