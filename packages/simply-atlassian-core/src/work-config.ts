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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { EnvLike } from './config.js';
import { ConfigError } from './errors.js';
import { isIssueKey } from './atlassian-url.js';

/**
 * The project config that defines a work item: what its Jira issue holds, field by field, and
 * what its Confluence page is. Checked into the team's repository, so the shape of every story an
 * agent writes is reviewed in a pull request rather than decided by whichever model ran.
 *
 * The server enforces mechanics (types, required and fixed values, read-before-write); the
 * content rules are all here. See design 0020.
 */

/** How a field's value is encoded for Jira. See `work-fields.ts`. */
export const WORK_FIELD_TYPES = [
  'text',
  'markdown',
  'number',
  'date',
  'option',
  'options',
  'components',
  'versions',
  'labels',
  'user',
  'issue',
  'raw',
] as const;
export type WorkFieldType = (typeof WORK_FIELD_TYPES)[number];

/** Types whose values are names drawn from a fixed set, so `allowed` can restrict them. */
const CHOICE_TYPES = new Set<WorkFieldType>(['option', 'options', 'components', 'versions', 'labels']);
/** Types whose value is a list. */
const LIST_TYPES = new Set<WorkFieldType>(['options', 'components', 'versions', 'labels']);

export interface WorkFieldSpec {
  /** The label the agent reads and writes against. Unique within the config. */
  readonly name: string;
  /** The Jira field id: `summary`, `components`, `customfield_10045`. */
  readonly key: string;
  readonly type: WorkFieldType;
  /** What belongs in the field, as instructions to the agent. Never sent to Jira. */
  readonly description?: string;
  readonly required?: boolean;
  /** A value the server applies: always when `always` is set. */
  readonly value?: unknown;
  readonly always?: boolean;
  /** Applied on create when the agent omits the field. */
  readonly default?: unknown;
  readonly allowed?: readonly string[];
}

export interface WorkSectionSpec {
  readonly heading: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface WorkJiraConfig {
  readonly project: string;
  readonly issueType: string;
  readonly fields: readonly WorkFieldSpec[];
}

export interface WorkConfluenceConfig {
  readonly space: string;
  readonly parent?: string;
  readonly title?: string;
  readonly labels?: readonly string[];
  readonly when?: string;
  readonly sections?: readonly WorkSectionSpec[];
}

export interface WorkConfig {
  /** Where the config was read from, for messages. */
  readonly source: string;
  readonly guidance?: string;
  readonly jira: WorkJiraConfig;
  readonly confluence?: WorkConfluenceConfig;
}

/** Where a config is looked for, in order: an explicit path, this variable, then the repo file. */
export const WORK_CONFIG_ENV = 'ATLASSIAN_CONFIG';
export const WORK_CONFIG_FILE = path.join('.simply', 'atlassian.json');

/**
 * The keys each object in the config accepts. Exported so the published JSON Schema can be
 * checked against the validator in a test, rather than trusted to agree with it.
 */
export const WORK_CONFIG_KEYS = {
  root: ['$schema', 'guidance', 'jira', 'confluence'],
  jira: ['project', 'issueType', 'fields'],
  field: ['name', 'key', 'type', 'description', 'required', 'value', 'always', 'default', 'allowed'],
  confluence: ['space', 'parent', 'title', 'labels', 'when', 'sections'],
  section: ['heading', 'description', 'required'],
} as const;

export interface WorkConfigLocation {
  /** An explicit path, from `--config`. Relative paths resolve against `cwd`. */
  readonly config?: string;
  readonly cwd?: string;
  readonly env?: EnvLike;
}

/** Finds the config file: `--config`, then `ATLASSIAN_CONFIG`, then `.simply/atlassian.json` upward. */
export function findWorkConfig(location: WorkConfigLocation = {}): string {
  const cwd = location.cwd ?? process.cwd();
  const env = location.env ?? process.env;
  const explicit = location.config ?? env[WORK_CONFIG_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    const resolved = path.resolve(cwd, explicit);
    if (!existsSync(resolved)) {
      const from = location.config === undefined ? `${WORK_CONFIG_ENV}` : '--config';
      throw new ConfigError(`The work item config ${resolved} (from ${from}) does not exist.`);
    }
    return resolved;
  }

  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, WORK_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(
    `No work item config found. Add ${WORK_CONFIG_FILE} to the repository (searched upward from ${cwd}), ` +
      `or point --config or ${WORK_CONFIG_ENV} at one. See the work items guide for the format.`,
  );
}

/** Finds, reads and validates the config. Read fresh on every call, so edits apply immediately. */
export function loadWorkConfig(location: WorkConfigLocation = {}): WorkConfig {
  const source = findWorkConfig(location);
  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseWorkConfig(text, source);
}

/**
 * Parses and validates config text. Comments and trailing commas are allowed, as in `tsconfig.json`, because the
 * descriptions in this file are documentation and the reasons behind them often deserve a note.
 * Every problem is reported at once, each with its path, so fixing a config is one pass.
 */
export function parseWorkConfig(text: string, source = WORK_CONFIG_FILE): WorkConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (error) {
    throw new ConfigError(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const problems: string[] = [];
  const config = new Validator(problems).root(raw, source);
  if (problems.length > 0 || config === undefined) {
    throw new ConfigError(`${source} is not a valid work item config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return config;
}

/** Removes `//` and `/* *\/` comments outside strings. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** Removes a comma before a closing `}` or `]` outside strings, which JSONC editors and formatters write. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out += char;
  }
  return out;
}

/** A key named like a credential. The file is committed, so it must never hold one. */
const CREDENTIAL_KEY = /token|password|passwd|secret|api[-_]?key|credential/i;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Validator {
  public constructor(private readonly problems: string[]) {}

  public root(raw: unknown, source: string): WorkConfig | undefined {
    if (!isObject(raw)) {
      this.problems.push('the file must hold a JSON object');
      return undefined;
    }
    this.credentials(raw, '');
    this.keys(raw, WORK_CONFIG_KEYS.root, '(root)');
    const guidance = this.optionalString(raw, 'guidance', 'guidance');
    const jira = this.jira(raw.jira);
    const confluence = raw.confluence === undefined ? undefined : this.confluence(raw.confluence, jira);
    if (jira === undefined) return undefined;
    return { source, guidance, jira, confluence };
  }

  private jira(raw: unknown): WorkJiraConfig | undefined {
    if (!isObject(raw)) {
      this.problems.push('jira: required, an object with project, issueType and fields');
      return undefined;
    }
    this.keys(raw, WORK_CONFIG_KEYS.jira, 'jira');
    const project = this.requiredString(raw, 'project', 'jira.project');
    const issueType = this.requiredString(raw, 'issueType', 'jira.issueType');
    if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
      this.problems.push('jira.fields: required, a non-empty list of field specs');
      return undefined;
    }
    const fields = raw.fields
      .map((field, index) => this.field(field, `jira.fields[${index}]`))
      .filter((field): field is WorkFieldSpec => field !== undefined);

    this.unique(
      fields.map((field) => field.name.toLowerCase()),
      'jira.fields',
      'name',
    );
    this.unique(
      fields.map((field) => field.key),
      'jira.fields',
      'key',
    );
    if (!fields.some((field) => field.key === 'summary')) {
      this.problems.push(
        'jira.fields: must include the summary field (key "summary"), which Jira requires on every issue',
      );
    }
    if (project === undefined || issueType === undefined) return undefined;
    return { project, issueType, fields };
  }

  private field(raw: unknown, at: string): WorkFieldSpec | undefined {
    if (!isObject(raw)) {
      this.problems.push(`${at}: must be an object`);
      return undefined;
    }
    this.keys(raw, WORK_CONFIG_KEYS.field, at);
    const name = this.requiredString(raw, 'name', `${at}.name`);
    const key = this.requiredString(raw, 'key', `${at}.key`);
    const type = raw.type as WorkFieldType;
    if (!WORK_FIELD_TYPES.includes(type)) {
      this.problems.push(`${at}.type: must be one of ${WORK_FIELD_TYPES.join(', ')}`);
      return undefined;
    }
    const description = this.optionalString(raw, 'description', `${at}.description`);
    const required = this.optionalBoolean(raw, 'required', `${at}.required`);
    const always = this.optionalBoolean(raw, 'always', `${at}.always`);
    const allowed = this.allowed(raw, type, at);

    if (raw.value !== undefined) this.value(raw.value, type, allowed, `${at}.value`);
    if (raw.default !== undefined) this.value(raw.default, type, allowed, `${at}.default`);
    if (always === true && raw.value === undefined) this.problems.push(`${at}.always: needs a value to apply`);
    if (always === true && raw.default !== undefined) {
      this.problems.push(`${at}.default: cannot be combined with always; the always value wins every time`);
    }
    if (raw.value !== undefined && always !== true) {
      this.problems.push(`${at}.value: only applies with always: true; use default for a value the agent may change`);
    }
    if (name === undefined || key === undefined) return undefined;
    return { name, key, type, description, required, value: raw.value, always, default: raw.default, allowed };
  }

  private allowed(raw: Json, type: WorkFieldType, at: string): string[] | undefined {
    if (raw.allowed === undefined) return undefined;
    if (!CHOICE_TYPES.has(type)) {
      this.problems.push(`${at}.allowed: only applies to ${[...CHOICE_TYPES].join(', ')} fields`);
      return undefined;
    }
    if (!isStringList(raw.allowed) || raw.allowed.length === 0) {
      this.problems.push(`${at}.allowed: must be a non-empty list of strings`);
      return undefined;
    }
    return raw.allowed;
  }

  /** Checks a configured `value` or `default` the same way an agent's value is checked. */
  private value(value: unknown, type: WorkFieldType, allowed: readonly string[] | undefined, at: string): void {
    const problem = workValueProblem(value, type);
    if (problem !== undefined) {
      this.problems.push(`${at}: ${problem}`);
      return;
    }
    if (allowed === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    const outside = values.filter((item) => typeof item === 'string' && !allowed.includes(item));
    if (outside.length > 0) this.problems.push(`${at}: ${outside.join(', ')} is not in allowed`);
  }

  private confluence(raw: unknown, jira: WorkJiraConfig | undefined): WorkConfluenceConfig | undefined {
    if (!isObject(raw)) {
      this.problems.push('confluence: must be an object with at least space');
      return undefined;
    }
    this.keys(raw, WORK_CONFIG_KEYS.confluence, 'confluence');
    const space = this.requiredString(raw, 'space', 'confluence.space');
    let parent: string | undefined;
    if (raw.parent !== undefined) {
      parent = typeof raw.parent === 'number' ? String(raw.parent) : (raw.parent as string);
      if (typeof parent !== 'string' || !/^\d+$/.test(parent)) {
        this.problems.push('confluence.parent: must be a numeric page id');
        parent = undefined;
      }
    }
    const title = this.optionalString(raw, 'title', 'confluence.title');
    if (title !== undefined && jira !== undefined) this.titlePattern(title, jira);
    let labels: string[] | undefined;
    if (raw.labels !== undefined) {
      if (isStringList(raw.labels) && raw.labels.every((label) => /^\S+$/.test(label))) labels = raw.labels;
      else this.problems.push('confluence.labels: must be a list of labels without spaces');
    }
    const when = this.optionalString(raw, 'when', 'confluence.when');
    const sections = this.sections(raw.sections);
    if (space === undefined) return undefined;
    return { space, parent, title, labels, when, sections };
  }

  private titlePattern(title: string, jira: WorkJiraConfig): void {
    for (const match of title.matchAll(/\{([^}]*)\}/g)) {
      const token = match[1] ?? '';
      if (token === 'issue.key') continue;
      const name = token.startsWith('issue.') ? token.slice('issue.'.length) : undefined;
      if (name === undefined || !jira.fields.some((field) => field.name === name)) {
        this.problems.push(
          `confluence.title: {${token}} is not {issue.key} or {issue.<field name>} for a configured field`,
        );
      }
    }
  }

  private sections(raw: unknown): WorkSectionSpec[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      this.problems.push('confluence.sections: must be a list');
      return undefined;
    }
    const sections = raw
      .map((section, index): WorkSectionSpec | undefined => {
        const at = `confluence.sections[${index}]`;
        if (!isObject(section)) {
          this.problems.push(`${at}: must be an object`);
          return undefined;
        }
        this.keys(section, WORK_CONFIG_KEYS.section, at);
        const heading = this.requiredString(section, 'heading', `${at}.heading`);
        const description = this.optionalString(section, 'description', `${at}.description`);
        const required = this.optionalBoolean(section, 'required', `${at}.required`);
        return heading === undefined ? undefined : { heading, description, required };
      })
      .filter((section): section is WorkSectionSpec => section !== undefined);
    this.unique(
      sections.map((section) => section.heading.toLowerCase()),
      'confluence.sections',
      'heading',
    );
    return sections;
  }

  private credentials(raw: unknown, at: string): void {
    if (Array.isArray(raw)) {
      raw.forEach((item, index) => this.credentials(item, `${at}[${index}]`));
      return;
    }
    if (!isObject(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      const here = at === '' ? key : `${at}.${key}`;
      if (CREDENTIAL_KEY.test(key)) {
        this.problems.push(
          `${here}: looks like a credential. This file is committed; credentials stay in the environment`,
        );
      }
      // Field `value`s are data, which may legitimately be an object; their keys are not config.
      if (key !== 'value' && key !== 'default') this.credentials(value, here);
    }
  }

  private keys(raw: Json, known: readonly string[], at: string): void {
    for (const key of Object.keys(raw)) {
      if (!known.includes(key)) this.problems.push(`${at}: unknown property "${key}" (expected ${known.join(', ')})`);
    }
  }

  private unique(values: readonly string[], at: string, what: string): void {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) this.problems.push(`${at}: ${what} "${value}" is used more than once`);
      seen.add(value);
    }
  }

  private requiredString(raw: Json, key: string, at: string): string | undefined {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      this.problems.push(`${at}: required, a non-empty string`);
      return undefined;
    }
    return value;
  }

  private optionalString(raw: Json, key: string, at: string): string | undefined {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      this.problems.push(`${at}: must be a string`);
      return undefined;
    }
    return value;
  }

  private optionalBoolean(raw: Json, key: string, at: string): boolean | undefined {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      this.problems.push(`${at}: must be true or false`);
      return undefined;
    }
    return value;
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Why a value is wrong for a field type, or undefined when it is right. Shared by config
 * validation and by `jira_work_save`, so a configured default and an agent's value are held to
 * exactly the same rule. `null` (clearing the field) is checked by the caller, not here.
 */
export function workValueProblem(value: unknown, type: WorkFieldType): string | undefined {
  switch (type) {
    case 'text':
    case 'markdown':
    case 'option':
    case 'user':
      return typeof value === 'string' ? undefined : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a number';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : 'must be a YYYY-MM-DD date';
    case 'issue':
      return typeof value === 'string' && isIssueKey(value) ? undefined : 'must be an issue key such as PROJ-123';
    case 'labels':
    case 'options':
    case 'components':
    case 'versions':
      return listValueProblem(value, type);
    case 'raw':
      return undefined;
  }
}

function listValueProblem(value: unknown, type: WorkFieldType): string | undefined {
  if (type === 'labels') {
    return isStringList(value) && value.every((label) => /^\S+$/.test(label))
      ? undefined
      : 'must be a list of labels without spaces';
  }
  return isStringList(value) ? undefined : 'must be a list of strings';
}

/** Whether a type holds a list, so an empty value is `[]` rather than `null`. */
export function isListType(type: WorkFieldType): boolean {
  return LIST_TYPES.has(type);
}
