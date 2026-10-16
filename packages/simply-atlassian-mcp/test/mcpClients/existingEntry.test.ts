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
import { compareClaudeEntry, compareCodexEntry } from '../../src/mcpClients/existingEntry.js';

const launch = { command: 'simply', args: ['gitlab', 'mcp', '--env-file', 'C:\\Users\\me\\gitlab.env'] };

describe('compareCodexEntry', () => {
  it('is absent when there is no table for the name', () => {
    expect(compareCodexEntry('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n', 'simply-gitlab', launch)).toBe(
      'absent',
    );
  });

  it('is the same for the table codex writes, including escaped backslashes and comments', () => {
    const toml = [
      'model = "o3"',
      '',
      '[mcp_servers.simply-gitlab] # added by simply',
      'command = "simply"',
      'args = [',
      '  "gitlab",',
      "  'mcp',",
      '  "--env-file",',
      '  "C:\\\\Users\\\\me\\\\gitlab.env", # trailing comma is fine',
      ']',
      '',
      '[profiles.fast]',
      'model = "o4-mini"',
    ].join('\n');
    expect(compareCodexEntry(toml, 'simply-gitlab', launch)).toBe('same');
  });

  it('accepts a quoted table key', () => {
    const toml =
      '[mcp_servers."simply-gitlab"]\ncommand = "simply"\nargs = ["gitlab", "mcp", "--env-file", \'C:\\Users\\me\\gitlab.env\']\n';
    expect(compareCodexEntry(toml, 'simply-gitlab', launch)).toBe('same');
  });

  it('differs when the args differ', () => {
    expect(
      compareCodexEntry(
        '[mcp_servers.simply-gitlab]\ncommand = "simply"\nargs = ["gitlab", "mcp"]\n',
        'simply-gitlab',
        launch,
      ),
    ).toBe('differs');
  });

  it('differs when the table carries anything beyond the launch', () => {
    const extraKey = '[mcp_servers.simply-gitlab]\ncommand = "simply"\nargs = []\nstartup_timeout_sec = 20\n';
    const subTable =
      '[mcp_servers.simply-gitlab]\ncommand = "simply"\nargs = []\n[mcp_servers.simply-gitlab.env]\nX = "1"\n';
    expect(compareCodexEntry(extraKey, 'simply-gitlab', { command: 'simply', args: [] })).toBe('differs');
    expect(compareCodexEntry(subTable, 'simply-gitlab', { command: 'simply', args: [] })).toBe('differs');
  });
});

describe('compareClaudeEntry', () => {
  const file = (entry: unknown): string => JSON.stringify({ projects: {}, mcpServers: { 'simply-gitlab': entry } });

  it('is the same for what add-json writes', () => {
    expect(compareClaudeEntry(file({ type: 'stdio', ...launch, env: {} }), 'simply-gitlab', launch)).toBe('same');
  });

  it('differs on a different launch or extra env', () => {
    expect(compareClaudeEntry(file({ type: 'stdio', command: 'npx', args: [] }), 'simply-gitlab', launch)).toBe(
      'differs',
    );
    expect(compareClaudeEntry(file({ ...launch, env: { GITLAB_TOKEN: 'x' } }), 'simply-gitlab', launch)).toBe(
      'differs',
    );
  });

  it('is absent when missing, or when the file cannot be read', () => {
    expect(compareClaudeEntry(JSON.stringify({ mcpServers: {} }), 'simply-gitlab', launch)).toBe('absent');
    expect(compareClaudeEntry('{ not json', 'simply-gitlab', launch)).toBe('absent');
  });
});
