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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildArgs, TOOLS, type ToolSpec } from '../src/tools.js';

const byName = (name: string): ToolSpec => {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (spec === undefined) throw new Error(`no tool named ${name}`);
  return spec;
};

describe('TOOLS registry', () => {
  it('names every tool uniquely in snake case', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('covers every command in the CLI package exactly once', () => {
    // The CLI's snapshot is the authoritative command list; a command added there without a
    // tool here should fail this test, not go quietly unexposed.
    const snapshot = JSON.parse(
      readFileSync(new URL('../../simply-atlassian/command-snapshot.json', import.meta.url), 'utf8'),
    ) as Array<{ command: string }>;
    const cliCommands = snapshot.map((entry) => entry.command).sort();
    const toolCommands = TOOLS.map((tool) => tool.command.join(':')).sort();
    expect(toolCommands).toEqual(cliCommands);
  });

  it('maps every positional and flag input onto a schema property', () => {
    for (const tool of TOOLS) {
      const properties = Object.keys(tool.inputSchema);
      for (const positional of tool.positionals) expect(properties).toContain(positional);
      for (const flagged of Object.keys(tool.flags)) expect(properties).toContain(flagged);
    }
  });

  it('gives every write tool dryRun and every destructive tool confirm as well', () => {
    for (const tool of TOOLS) {
      const properties = Object.keys(tool.inputSchema);
      if (tool.kind === 'read') {
        expect(properties).not.toContain('dryRun');
        expect(properties).not.toContain('confirm');
      } else {
        expect(properties).toContain('dryRun');
        expect(properties.includes('confirm')).toBe(tool.kind === 'destructive');
      }
    }
  });

  it('marks exactly the CLI commands that take --confirm as destructive', () => {
    const destructive = TOOLS.filter((tool) => tool.kind === 'destructive').map((tool) => tool.name);
    expect(destructive.sort()).toEqual(['jira_issue_comment_delete', 'jira_issue_delete']);
  });
});

describe('buildArgs', () => {
  it('places positionals first, in declared order', () => {
    expect(buildArgs(byName('jira_issue_link_create'), { from: 'A-1', type: 'blocks', to: 'B-2' })).toEqual([
      'A-1',
      'blocks',
      'B-2',
    ]);
  });

  it('throws when a positional is missing', () => {
    expect(() => buildArgs(byName('jira_issue_view'), {})).toThrow(/"issue" is required/);
  });

  it('renders strings and numbers as flag values, and joins comma-list arrays', () => {
    expect(
      buildArgs(byName('jira_issue_search'), { jql: 'project = X', limit: 5, fields: ['summary', 'status'] }),
    ).toEqual(['--jql', 'project = X', '--limit', '5', '--fields', 'summary,status']);
  });

  it('repeats a flag for array inputs that the CLI declares repeatable', () => {
    expect(buildArgs(byName('jira_issue_create'), { project: 'P', labels: ['a', 'b'] })).toEqual([
      '--project',
      'P',
      '--label',
      'a',
      '--label',
      'b',
    ]);
  });

  it('serialises an object input as a JSON flag value', () => {
    expect(
      buildArgs(byName('jira_issue_update'), { issue: 'P-1', body: { fields: { duedate: '2026-10-01' } } }),
    ).toEqual(['P-1', '--body', '{"fields":{"duedate":"2026-10-01"}}']);
  });

  it('passes true booleans as bare flags and negatable false as --no-', () => {
    const update = byName('jira_issue_update');
    expect(buildArgs(update, { issue: 'P-1', verify: true })).toEqual(['P-1', '--verify']);
    expect(buildArgs(update, { issue: 'P-1', verify: false })).toEqual(['P-1', '--no-verify']);
    expect(buildArgs(byName('jira_issue_transition'), { issue: 'P-1', transition: 'Done', byName: false })).toEqual([
      'P-1',
      'Done',
    ]);
  });

  it('ignores dryRun and confirm, which the server appends itself', () => {
    expect(buildArgs(byName('jira_issue_delete'), { issue: 'P-1', dryRun: true, confirm: true })).toEqual(['P-1']);
  });

  it('omits an empty comma-list array rather than passing an empty value', () => {
    expect(buildArgs(byName('jira_issue_view'), { issue: 'P-1', fields: [] })).toEqual(['P-1']);
  });
});
