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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import {
  findWorkConfig,
  loadWorkConfig,
  parseWorkConfig,
  WORK_CONFIG_KEYS,
  WORK_FIELD_TYPES,
  workValueProblem,
} from '../src/work-config.js';
import { decodeWorkField, encodeWorkField } from '../src/work-fields.js';

/** The worked example from design 0020 and the guide, comments included. */
export const EXAMPLE_CONFIG = `{
  "$schema": "https://unpkg.com/@simplysf/simply-atlassian-core/schema/work-config.schema.json",
  // Project-wide direction for the agent.
  "guidance": "Write for business reviewers outside engineering.",
  "jira": {
    "project": "PAY",
    "issueType": "Story",
    "fields": [
      { "name": "Summary", "key": "summary", "type": "text", "required": true, "description": "Under 80 characters." },
      { "name": "Description", "key": "description", "type": "markdown", "required": true },
      { "name": "Acceptance Criteria", "key": "customfield_10045", "type": "markdown", "required": true,
        "description": "Numbered AC-1… in Given/When/Then." },
      { "name": "Component/s", "key": "components", "type": "components", "value": ["O&M"], "always": true },
      { "name": "Priority", "key": "priority", "type": "option", "allowed": ["High", "Medium", "Low"], "default": "Medium" },
      { "name": "Epic", "key": "parent", "type": "issue" },
      { "name": "Assignee", "key": "assignee", "type": "user" },
      { "name": "Labels", "key": "labels", "type": "labels", "value": ["agent-drafted"], "always": true }
    ]
  },
  "confluence": {
    "space": "ENG",
    "parent": "123456",
    "title": "{issue.key}: {issue.Summary}",
    "labels": ["tech-design"],
    "when": "Create a page when the work spans more than one system.",
    "sections": [
      { "heading": "Problem", "required": true },
      { "heading": "Design", "required": true, "description": "The chosen approach." },
      { "heading": "Open questions" }
    ]
  }
}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'work-config-'));
  dirs.push(dir);
  return dir;
}

function problems(text: string): string {
  try {
    parseWorkConfig(text, 'test.json');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the config to be refused');
}

const minimal = (fields: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    jira: { project: 'P', issueType: 'Story', fields: [{ name: 'Summary', key: 'summary', type: 'text' }, ...fields] },
    ...extra,
  });

describe('parseWorkConfig', () => {
  it('accepts the documented example, comments and all', () => {
    const config = parseWorkConfig(EXAMPLE_CONFIG, 'example.json');
    expect(config.source).toBe('example.json');
    expect(config.jira.fields).toHaveLength(8);
    expect(config.confluence?.sections?.map((section) => section.heading)).toEqual([
      'Problem',
      'Design',
      'Open questions',
    ]);
  });

  it('accepts the examples published in the guide and the design doc, exactly as written', () => {
    for (const file of [
      '../../simply-atlassian/docs/guides/work-items.md',
      '../../../docs/design/0020-project-configured-work-items.md',
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const example = /```jsonc\n([\s\S]*?)\n```/.exec(text)?.[1];
      expect(example, file).toBeDefined();
      expect(parseWorkConfig(example ?? '', file).jira.project).toBe('PAY');
    }
  });

  it('accepts trailing commas, which JSONC formatters add', () => {
    const config = parseWorkConfig(
      '{ "jira": { "project": "P", "issueType": "S", "fields": [{ "name": "S", "key": "summary", "type": "text", },], }, }',
    );
    expect(config.jira.fields).toHaveLength(1);
    expect(parseWorkConfig(minimal([], { guidance: 'a ,} stays' })).guidance).toBe('a ,} stays');
  });

  it('keeps comment markers that sit inside strings', () => {
    const config = parseWorkConfig(minimal([], { guidance: 'see https://x.test/a // not a comment /* nor this */' }));
    expect(config.guidance).toBe('see https://x.test/a // not a comment /* nor this */');
  });

  it('reports every problem at once, each with its path', () => {
    const message = problems(
      JSON.stringify({
        jira: {
          project: 'P',
          issueType: 'Story',
          fields: [
            { name: 'Summary', key: 'summary', type: 'text', requried: true },
            { name: 'summary', key: 'customfield_1', type: 'text' },
            { name: 'Pri', key: 'priority', type: 'option', always: true },
            { name: 'Text', key: 'customfield_2', type: 'text', allowed: ['a'] },
            { name: 'Kind', key: 'customfield_3', type: 'option', allowed: ['A'], default: 'B' },
            { name: 'When', key: 'duedate', type: 'date', default: 'tomorrow' },
            { name: 'Odd', key: 'customfield_4', type: 'mystery' },
          ],
        },
      }),
    );
    expect(message).toContain('jira.fields[0]: unknown property "requried"');
    expect(message).toContain('jira.fields: name "summary" is used more than once');
    expect(message).toContain('jira.fields[2].always: needs a value to apply');
    expect(message).toContain('jira.fields[3].allowed: only applies to');
    expect(message).toContain('jira.fields[4].default: B is not in allowed');
    expect(message).toContain('jira.fields[5].default: must be a YYYY-MM-DD date');
    expect(message).toContain('jira.fields[6].type: must be one of');
  });

  it('requires the summary field, since Jira refuses an issue without one', () => {
    expect(
      problems(
        JSON.stringify({
          jira: { project: 'P', issueType: 'Story', fields: [{ name: 'D', key: 'description', type: 'markdown' }] },
        }),
      ),
    ).toContain('must include the summary field');
  });

  it('refuses anything that looks like a credential, since the file is committed', () => {
    expect(problems(minimal([], { confluence: { space: 'S', apiToken: 'x' } }))).toContain(
      'confluence.apiToken: looks like a credential',
    );
  });

  it('refuses a value without always, which would otherwise silently do nothing', () => {
    expect(problems(minimal([{ name: 'L', key: 'labels', type: 'labels', value: ['x'] }]))).toContain(
      'only applies with always: true',
    );
  });

  it('checks title placeholders against the configured field names', () => {
    expect(problems(minimal([], { confluence: { space: 'S', title: '{issue.key} {issue.Nope} {other}' } }))).toMatch(
      /\{issue\.Nope\}[\s\S]*\{other\}/,
    );
  });

  it('names the file when it is not JSON at all', () => {
    expect(() => parseWorkConfig('{ nope', 'repo/.simply/atlassian.json')).toThrow(
      /repo\/.simply\/atlassian.json is not valid JSON/,
    );
  });
});

describe('findWorkConfig and loadWorkConfig', () => {
  it('searches upward from the working directory', () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, '.simply'));
    writeFileSync(path.join(repo, '.simply', 'atlassian.json'), EXAMPLE_CONFIG);
    const nested = path.join(repo, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    expect(findWorkConfig({ cwd: nested, env: {} })).toBe(path.join(repo, '.simply', 'atlassian.json'));
    expect(loadWorkConfig({ cwd: nested, env: {} }).jira.project).toBe('PAY');
  });

  it('prefers --config over the environment over the repo file', () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, '.simply'));
    writeFileSync(path.join(repo, '.simply', 'atlassian.json'), EXAMPLE_CONFIG);
    writeFileSync(path.join(repo, 'env.json'), minimal([]));
    writeFileSync(path.join(repo, 'flag.json'), minimal([]));
    const env = { ATLASSIAN_CONFIG: 'env.json' };
    expect(findWorkConfig({ cwd: repo, env, config: 'flag.json' })).toBe(path.join(repo, 'flag.json'));
    expect(findWorkConfig({ cwd: repo, env })).toBe(path.join(repo, 'env.json'));
    expect(findWorkConfig({ cwd: repo, env: {} })).toBe(path.join(repo, '.simply', 'atlassian.json'));
  });

  it('says where it looked when there is no config', () => {
    const repo = tempRepo();
    expect(() => findWorkConfig({ cwd: repo, env: {} })).toThrow(/No work item config found/);
    expect(() => findWorkConfig({ cwd: repo, env: {}, config: 'missing.json' })).toThrow(/does not exist/);
  });
});

describe('the published JSON Schema', () => {
  interface SchemaObject {
    readonly properties?: Readonly<Record<string, SchemaObject & { readonly enum?: readonly string[] }>>;
    readonly $defs?: Readonly<Record<string, SchemaObject>>;
  }
  const schema = JSON.parse(
    readFileSync(new URL('../schema/work-config.schema.json', import.meta.url), 'utf8'),
  ) as SchemaObject;
  const keys = (definition: SchemaObject | undefined): string[] => Object.keys(definition?.properties ?? {}).sort();

  it('declares exactly the properties the validator accepts', () => {
    expect(keys(schema)).toEqual([...WORK_CONFIG_KEYS.root].sort());
    expect(keys(schema.properties?.jira)).toEqual([...WORK_CONFIG_KEYS.jira].sort());
    expect(keys(schema.$defs?.field)).toEqual([...WORK_CONFIG_KEYS.field].sort());
    expect(keys(schema.properties?.confluence)).toEqual([...WORK_CONFIG_KEYS.confluence].sort());
    expect(keys(schema.$defs?.section)).toEqual([...WORK_CONFIG_KEYS.section].sort());
  });

  it('lists exactly the field types the validator accepts', () => {
    expect([...(schema.$defs?.field?.properties?.type?.enum ?? [])].sort()).toEqual([...WORK_FIELD_TYPES].sort());
  });
});

describe('field codecs', () => {
  const spec = (type: (typeof WORK_FIELD_TYPES)[number], key = 'customfield_1') => ({ name: 'F', key, type });

  it.each([
    ['text', 'hello'],
    ['markdown', '# Title\n\n1. **AC-1** Given x'],
    ['number', 5],
    ['date', '2026-11-01'],
    ['option', 'High'],
    ['options', ['A', 'B']],
    ['components', ['O&M']],
    ['versions', ['1.2']],
    ['labels', ['agent-drafted']],
    ['issue', 'PAY-7'],
  ] as const)('round-trips a %s value on both deployments', (type, value) => {
    for (const deployment of ['cloud', 'server'] as const) {
      const encoded = encodeWorkField(spec(type), value, deployment);
      expect(decodeWorkField(spec(type), encoded, deployment).value).toEqual(value);
    }
  });

  it('encodes the system fields Jira shapes differently', () => {
    expect(encodeWorkField(spec('option', 'priority'), 'High', 'cloud')).toEqual({ name: 'High' });
    expect(encodeWorkField(spec('option'), 'High', 'cloud')).toEqual({ value: 'High' });
    expect(encodeWorkField(spec('issue', 'parent'), 'PAY-1', 'cloud')).toEqual({ key: 'PAY-1' });
    expect(encodeWorkField(spec('user', 'assignee'), 'abc', 'cloud')).toEqual({ accountId: 'abc' });
    expect(encodeWorkField(spec('user', 'assignee'), 'jsmith', 'server')).toEqual({ name: 'jsmith' });
  });

  it('writes rich text as ADF on Cloud and wiki markup on Server/DC', () => {
    expect(encodeWorkField(spec('markdown'), '**x**', 'cloud')).toMatchObject({ type: 'doc', version: 1 });
    expect(encodeWorkField(spec('markdown'), '**x**', 'server')).toBe('*x*');
  });

  it('clears with null, or an empty list for list types', () => {
    expect(encodeWorkField(spec('text'), '', 'cloud')).toBeNull();
    expect(encodeWorkField(spec('labels'), [], 'cloud')).toEqual([]);
    expect(decodeWorkField(spec('components'), undefined, 'cloud').value).toEqual([]);
  });

  it('holds configured defaults and agent values to the same rule', () => {
    expect(workValueProblem('PAY-1', 'issue')).toBeUndefined();
    expect(workValueProblem('not a key', 'issue')).toMatch(/issue key/);
    expect(workValueProblem(['has space'], 'labels')).toMatch(/without spaces/);
    expect(workValueProblem({ any: 'thing' }, 'raw')).toBeUndefined();
  });
});
