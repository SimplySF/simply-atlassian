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

import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfluenceOpen from '../../../../src/commands/atlassian/confluence/open.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const originalCi = process.env.CI;
const originalDisplay = process.env.DISPLAY;

beforeEach(() => {
  delete process.env.CI;
  process.env.DISPLAY = ':99';
  spawnMock.mockReset();
});

afterEach(() => {
  if (originalCi === undefined) delete process.env.CI;
  else process.env.CI = originalCi;
  if (originalDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = originalDisplay;
});

async function invoke(extra: string[]): Promise<{ logged: string[]; result: unknown }> {
  const logged: string[] = [];
  const command = new ConfluenceOpen(
    [
      '--confluence-url',
      'https://example.atlassian.net',
      '--confluence-username',
      'user',
      '--confluence-api-token',
      'token',
      ...extra,
    ],
    { runHook: async () => ({ successes: [], failures: [] }) } as never,
  );
  command.log = (message?: string): void => {
    logged.push(String(message));
  };
  await command.init();
  const result = await command.run();
  return { logged, result };
}

describe('confluence open', () => {
  it('prints the canonical Cloud page URL for a page id', async () => {
    const outcome = await invoke(['123456', '--print']);

    expect(outcome.logged).toEqual(['https://example.atlassian.net/wiki/pages/viewpage.action?pageId=123456']);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('extracts the page id from a URL', async () => {
    const outcome = await invoke(['https://example.atlassian.net/wiki/spaces/DOCS/pages/98765/Runbook', '--url']);

    expect(outcome.logged).toEqual(['https://example.atlassian.net/wiki/pages/viewpage.action?pageId=98765']);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns the URL and never spawns under --json', async () => {
    const outcome = await invoke(['123456', '--json']);

    expect(outcome.result).toEqual({ url: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=123456' });
    expect(outcome.logged).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
