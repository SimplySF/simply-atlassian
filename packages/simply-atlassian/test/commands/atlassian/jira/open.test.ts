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

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JiraOpen from '../../../../src/commands/atlassian/jira/open.js';

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
  const command = new JiraOpen(['--jira-url', 'https://jira.example.gov', '--jira-personal-token', 'pat', ...extra], {
    runHook: async () => ({ successes: [], failures: [] }),
  } as never);
  command.log = (message?: string): void => {
    logged.push(String(message));
  };
  await command.init();
  const result = await command.run();
  return { logged, result };
}

describe('jira open', () => {
  it('prints an issue URL with --print without spawning', async () => {
    const outcome = await invoke(['PROJ-1', '--print']);

    expect(outcome.logged).toEqual(['https://jira.example.gov/browse/PROJ-1']);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts --url as an alias and treats a non-issue as a project key', async () => {
    const outcome = await invoke(['OPS', '--url']);

    expect(outcome.logged).toEqual(['https://jira.example.gov/browse/OPS']);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns the URL and never spawns under --json', async () => {
    const outcome = await invoke(['PROJ-1', '--json']);

    expect(outcome.result).toEqual({ url: 'https://jira.example.gov/browse/PROJ-1' });
    expect(outcome.logged).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('prints instead of spawning in CI', async () => {
    process.env.CI = '1';

    const outcome = await invoke(['PROJ-1']);

    expect(outcome.logged).toEqual(['https://jira.example.gov/browse/PROJ-1']);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('prints when the platform opener cannot be spawned', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('xdg-open unavailable');
    });

    const outcome = await invoke(['PROJ-1']);

    expect(spawnMock).toHaveBeenCalledWith(
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open',
      ['https://jira.example.gov/browse/PROJ-1'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(outcome.logged).toEqual(['https://jira.example.gov/browse/PROJ-1']);
  });

  it('prints when the platform opener emits an error', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValue(child as never);

    const outcome = await invoke(['PROJ-1']);
    child.emit('error', new Error('xdg-open unavailable'));

    expect(child.unref).not.toHaveBeenCalled();
    expect(outcome.logged).toEqual(['https://jira.example.gov/browse/PROJ-1']);
  });

  it('prints when the platform opener exits unsuccessfully', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValue(child as never);

    const outcome = await invoke(['PROJ-1']);
    child.emit('exit', 1);

    expect(child.unref).not.toHaveBeenCalled();
    expect(outcome.logged).toEqual(['https://jira.example.gov/browse/PROJ-1']);
  });
});
