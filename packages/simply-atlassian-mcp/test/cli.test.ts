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

import { existsSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { createCliRunner, resolveCliBin } from '../src/cli.js';
import { mapCliError } from '../src/server.js';

/**
 * This process's environment with every Atlassian setting removed, so the CLI sees none, and
 * `NODE_ENV` forced to production. Vitest sets `NODE_ENV=test`, and under a non-production
 * `NODE_ENV` oclif looks for TypeScript sources next to the workspace `tsconfig.json` instead of
 * loading the compiled `lib/` — which is not how any host launches this server.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(JIRA_|CONFLUENCE_|ATLASSIAN_)/.test(key)) env[key] = value;
  }
  env.NODE_ENV = 'production';
  return env;
}

// These spawn the real CLI from the sibling workspace package, which `pnpm run build` compiles
// before tests run (locally and in CI). They prove the child-process contract end to end:
// resolution of the binary, argv passing, the stderr JSON error line, and exit codes.
describe('CLI runner (real process)', () => {
  it('resolves the CLI binary inside the dependency, not on PATH', () => {
    const bin = resolveCliBin();
    expect(bin).toMatch(/simply-atlassian[\\/]bin[\\/]run\.js$/);
    expect(existsSync(bin)).toBe(true);
  });

  it('honours SIMPLY_ATLASSIAN_BIN as an override', () => {
    const previous = process.env.SIMPLY_ATLASSIAN_BIN;
    process.env.SIMPLY_ATLASSIAN_BIN = '/elsewhere/run.js';
    try {
      expect(resolveCliBin()).toBe('/elsewhere/run.js');
    } finally {
      if (previous === undefined) delete process.env.SIMPLY_ATLASSIAN_BIN;
      else process.env.SIMPLY_ATLASSIAN_BIN = previous;
    }
  });

  it('surfaces a configuration failure as exit code 2 with the CLI JSON error line', async () => {
    const run = createCliRunner({ env: scrubbedEnv() });

    const result = await run(['atlassian', 'jira', 'whoami', '--json']);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(mapCliError(result)).toMatchObject({ code: 'config', name: 'ConfigError', exitCode: 2 });
  });

  it('refuses a write when ATLASSIAN_READ_ONLY is set in the child environment', async () => {
    const run = createCliRunner({ env: { ...scrubbedEnv(), ATLASSIAN_READ_ONLY: '1' } });

    const result = await run(['atlassian', 'jira', 'issue', 'delete', 'P-1', '--confirm', '--json']);

    expect(result.exitCode).toBe(2);
    expect(mapCliError(result).message).toContain('ATLASSIAN_READ_ONLY');
  });

  it('kills a call that outlives its timeout and reports it', async () => {
    // A `--help` render is quick, so a tiny timeout reliably fires first.
    const run = createCliRunner({ env: scrubbedEnv(), timeoutMs: 1 });

    const result = await run(['atlassian', '--help']);

    expect(result.timedOut).toBe(true);
  });
});
