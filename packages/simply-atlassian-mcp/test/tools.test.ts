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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools.js';

describe('TOOLS catalogue', () => {
  it('names every tool uniquely in snake case', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('covers every command in the CLI package exactly once', () => {
    // The CLI's snapshot is the authoritative command list; a command added there without a
    // tool here should fail this test, not go quietly unexposed. Read from the sibling package
    // in the repo: the server no longer depends on the CLI at runtime, only on this parity.
    const snapshot = JSON.parse(
      readFileSync(new URL('../../simply-atlassian/command-snapshot.json', import.meta.url), 'utf8'),
    ) as Array<{ command: string }>;
    const cliCommands = snapshot.map((entry) => entry.command).sort();
    const toolCommands = TOOLS.map((tool) => tool.command.join(':')).sort();
    expect(toolCommands).toEqual(cliCommands);
  });

  it('gives every write tool dryRun and every destructive tool confirm as well', () => {
    for (const tool of TOOLS) {
      const properties = Object.keys(tool.inputSchema);
      if (tool.kind === 'read') {
        expect(properties, tool.name).not.toContain('dryRun');
        expect(properties, tool.name).not.toContain('confirm');
      } else {
        expect(properties, tool.name).toContain('dryRun');
        expect(properties.includes('confirm'), tool.name).toBe(tool.kind === 'destructive');
      }
    }
  });

  it('marks exactly the CLI commands that take --confirm as destructive', () => {
    const destructive = TOOLS.filter((tool) => tool.kind === 'destructive').map((tool) => tool.name);
    expect(destructive.sort()).toEqual(['confluence_page_delete', 'jira_issue_comment_delete', 'jira_issue_delete']);
  });

  /*
   * The architectural rule is: implement in simply-atlassian-core, then expose through BOTH the
   * CLI and this server. A capability that lives in core and reaches only the CLI is the failure
   * mode worth a test — the tool schemas here are a closed allowlist, so a new input silently
   * fails to reach an agent unless it is declared.
   */
  it('exposes Markdown bodies wherever the CLI accepts them', () => {
    for (const name of ['confluence_page_create', 'confluence_page_update', 'confluence_page_comment_add']) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool?.inputSchema ?? {}), name).toContain('markdown');
    }
  });

  it('exposes append on page update, so an agent can add to a page without rewriting it', () => {
    const update = TOOLS.find((t) => t.name === 'confluence_page_update');

    expect(Object.keys(update?.inputSchema ?? {})).toContain('append');
  });

  it('exposes the discovery, label, sprint-write and remote-link commands', () => {
    const names = TOOLS.map((tool) => tool.name);

    for (const name of [
      'confluence_page_label_add',
      'confluence_page_label_list',
      'jira_fields',
      'jira_issue_remotelink_create',
      'jira_issue_remotelink_delete',
      'jira_issue_remotelink_list',
      'jira_project_versions',
      'jira_projects',
      'jira_sprint_create',
      'jira_sprint_update',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('marks the new writes as writes, so the read-only default covers them', () => {
    for (const name of [
      'confluence_page_label_add',
      'jira_sprint_create',
      'jira_sprint_update',
      'jira_issue_remotelink_create',
      'jira_issue_remotelink_delete',
    ]) {
      expect(TOOLS.find((tool) => tool.name === name)?.kind, name).toBe('write');
    }
  });

  it('only demands confirm from a page delete that purges, matching the CLI', () => {
    const pageDelete = TOOLS.find((tool) => tool.name === 'confluence_page_delete');
    expect(pageDelete?.requiresConfirm?.({ page: '1' })).toBe(false);
    expect(pageDelete?.requiresConfirm?.({ page: '1', purge: true })).toBe(true);
  });
});
