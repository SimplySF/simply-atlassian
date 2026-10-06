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

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { EnvLike } from './config.js';
import { ConfigError } from './errors.js';
import type { JiraClient } from './jira-client.js';
import { listFields, listIssueTypes, type JiraField, type JiraIssueType } from './jira-discovery.js';

/** Every Xray custom field's schema type starts with this; nothing else on an instance does. */
export const XRAY_SCHEMA_PREFIX = 'com.xpandit.plugins.xray:';

export type XrayFieldRole =
  | 'testType'
  | 'steps'
  | 'cucumberType'
  | 'cucumberScenario'
  | 'genericDefinition'
  | 'preconditions'
  | 'testSets'
  | 'testPlans'
  | 'repositoryPath'
  | 'testSetTests'
  | 'testPlanTests';

export type XrayIssueTypeRole = 'test' | 'testSet' | 'testPlan' | 'testExecution' | 'precondition';

export interface XrayFieldRoleSpec {
  readonly role: XrayFieldRole;
  /** The part of the schema type after {@link XRAY_SCHEMA_PREFIX}. */
  readonly schemaType: string;
  /** The issue type that carries the field. */
  readonly issueType: XrayIssueTypeRole;
  /**
   * The Xray Server release that added the field, set only where Xray's own issue tracker
   * (jira.getxray.app) records it. A missing-field error compares it with the installed version.
   */
  readonly introducedIn?: string;
}

/**
 * Role → schema type. Mapped by schema type and never by display name: an administrator can rename
 * or translate a field, but the app fixes its schema type.
 */
export const XRAY_FIELD_ROLES: readonly XrayFieldRoleSpec[] = [
  { role: 'testType', schemaType: 'test-type-custom-field', issueType: 'test' },
  { role: 'steps', schemaType: 'manual-test-steps-custom-field', issueType: 'test' },
  { role: 'cucumberType', schemaType: 'automated-test-type-custom-field', issueType: 'test' },
  { role: 'cucumberScenario', schemaType: 'steps-editor-custom-field', issueType: 'test' },
  { role: 'genericDefinition', schemaType: 'path-editor-custom-field', issueType: 'test' },
  { role: 'preconditions', schemaType: 'test-precondition-custom-field', issueType: 'test' },
  { role: 'testSets', schemaType: 'test-sets-custom-field', issueType: 'test' },
  {
    role: 'testPlans',
    schemaType: 'test-plans-associated-with-test-custom-field',
    issueType: 'test',
  },
  // XRAY-1251, fixed in R3.0.0: "I can see in a Custom Field, the Test Repository folder".
  { role: 'repositoryPath', schemaType: 'test-repository-path-custom-field', issueType: 'test', introducedIn: '3.0.0' },
  { role: 'testSetTests', schemaType: 'test-sets-tests-custom-field', issueType: 'testSet' },
  {
    role: 'testPlanTests',
    schemaType: 'tests-associated-with-test-plan-custom-field',
    issueType: 'testPlan',
  },
];

interface IssueTypeRoleSpec {
  readonly role: XrayIssueTypeRole;
  /** Xray's default name, used only in messages; discovery never matches on it. */
  readonly label: string;
  /** Letters-only token found in the plugin-served icon's file name. */
  readonly iconToken: string;
  readonly description: RegExp;
}

/**
 * Issue types can be renamed in Xray's settings too, so they are recognised by what the app
 * installs rather than by name: a default description beginning "Represents a …", or, failing that,
 * an icon served from the plugin's own resources. An administrator can edit either; a type that
 * matches neither — say an edited description and an icon replaced by an uploaded avatar — is not
 * recognised, and the error asks for an `overrides` pin. Most specific first, because every token
 * contains "test".
 */
const ISSUE_TYPE_ROLES: readonly IssueTypeRoleSpec[] = [
  {
    role: 'testExecution',
    label: 'Test Execution',
    iconToken: 'testexecution',
    description: /^represents a test execution/i,
  },
  { role: 'testPlan', label: 'Test Plan', iconToken: 'testplan', description: /^represents a test plan/i },
  { role: 'testSet', label: 'Test Set', iconToken: 'testset', description: /^represents a test set/i },
  {
    role: 'precondition',
    label: 'Precondition',
    iconToken: 'precondition',
    description: /^represents a pre-?condition/i,
  },
  { role: 'test', label: 'Test', iconToken: 'test', description: /^represents an? test\b/i },
];

const XRAY_PLUGIN_KEY = 'com.xpandit.plugins.xray';

/** One instance's discovered Xray layout, saved as JSON so later commands skip discovery. */
export interface XrayInstanceRecord {
  readonly jiraUrl: string;
  readonly discoveredAt: string;
  readonly xrayVersion: string | null;
  /** Role → field id, for every role exactly one field claims. */
  readonly fields: Partial<Record<XrayFieldRole, string>>;
  /** Xray fields with no role: field id → schema type. Still requestable through `--fields`. */
  readonly unmapped: Record<string, string>;
  /** Field id → display name, for every Xray field, so `--fields` can resolve names offline. */
  readonly fieldNames: Record<string, string>;
  /** Role → issue type name, for every role exactly one issue type claims. */
  readonly issueTypes: Partial<Record<XrayIssueTypeRole, string>>;
  /** Roles more than one candidate claimed. Discovery does not guess; `overrides` decides. */
  readonly ambiguous: {
    readonly fields: Partial<Record<XrayFieldRole, string[]>>;
    readonly issueTypes: Partial<Record<XrayIssueTypeRole, string[]>>;
  };
  /** Hand-edited pins that beat discovery and survive a refresh. */
  readonly overrides: {
    readonly fields: Partial<Record<XrayFieldRole, string>>;
    readonly issueTypes: Partial<Record<XrayIssueTypeRole, string>>;
  };
}

/** A `--fields` value resolved to the id Jira needs, keeping the name the caller used. */
export interface ResolvedField {
  readonly name: string;
  readonly id: string;
}

/** Where instance records live by default: `${XDG_CACHE_HOME:-~/.cache}/simply-atlassian/xray`. */
export function defaultXrayCacheDir(env: EnvLike = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() ?? '';
  const cacheRoot = base === '' ? path.join(env.HOME ?? env.USERPROFILE ?? homedir(), '.cache') : base;
  return path.join(cacheRoot, 'simply-atlassian', 'xray');
}

/** `<host>[_<path>].json`, with anything a file system might object to (a port's colon) replaced. */
export function xrayRecordPath(cacheDir: string, jiraUrl: string): string {
  const url = new URL(jiraUrl);
  const suffix = url.pathname.replace(/^\/+|\/+$/g, '');
  const name = suffix === '' ? url.host : `${url.host}_${suffix}`;
  return path.join(cacheDir, `${name.replaceAll(/[^A-Za-z0-9.-]/g, '_')}.json`);
}

/**
 * Reads a saved record. A missing file is not an error; a file that exists but is not a record is,
 * because it may hold hand-edited overrides, and silently rediscovering would overwrite them.
 */
export function loadXrayRecord(file: string): XrayInstanceRecord | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`The Xray instance record at ${file} is not valid JSON (${reason}). Fix it or delete it.`);
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { jiraUrl?: unknown }).jiraUrl !== 'string') {
    throw new ConfigError(`The Xray instance record at ${file} is not a record. Fix it or delete it.`);
  }
  return normaliseRecord(parsed as Partial<XrayInstanceRecord> & { jiraUrl: string });
}

/**
 * Writes a record atomically — a temporary file renamed into place — so a reader never sees half a
 * file. Returns why saving failed rather than throwing: the record is a cache, and a directory the
 * caller cannot write must not stop a read.
 */
export function saveXrayRecord(file: string, record: XrayInstanceRecord): string | undefined {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
    return undefined;
  } catch (error) {
    rmSync(temporary, { force: true });
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Discovers which fields and issue types hold Xray's data on this instance. `previous` carries the
 * overrides a person pinned, which must survive the rewrite.
 */
export async function discoverXray(
  client: JiraClient,
  jiraUrl: string,
  previous?: XrayInstanceRecord,
): Promise<XrayInstanceRecord> {
  const [fields, issueTypes, xrayVersion] = await Promise.all([
    listFields(client),
    listIssueTypes(client),
    readXrayVersion(client),
  ]);
  const mapped = mapFields(fields);
  const types = mapIssueTypes(issueTypes);
  return {
    jiraUrl,
    discoveredAt: new Date().toISOString(),
    xrayVersion,
    fields: mapped.fields,
    unmapped: mapped.unmapped,
    fieldNames: mapped.fieldNames,
    issueTypes: types.issueTypes,
    ambiguous: { fields: mapped.ambiguous, issueTypes: types.ambiguous },
    overrides: previous?.overrides ?? { fields: {}, issueTypes: {} },
  };
}

/**
 * A record plus where it lives, which every error that tells a person to edit it has to name. The
 * lookups apply the rules in one place: an override wins, an ambiguous role refuses to guess, and a
 * missing role names the Xray release that introduced it.
 */
export class XrayInstance {
  public readonly record: XrayInstanceRecord;
  public readonly path: string;

  public constructor(record: XrayInstanceRecord, recordPath: string) {
    this.record = record;
    this.path = recordPath;
  }

  /** The field id for a role, or undefined when this instance has none. Ambiguity still throws. */
  public field(role: XrayFieldRole): string | undefined {
    const pinned = this.record.overrides.fields[role];
    if (pinned !== undefined) return pinned;
    const candidates = this.record.ambiguous.fields[role];
    if (candidates !== undefined && candidates.length > 1) {
      throw new ConfigError(
        `More than one field holds Xray's "${role}" data: ${candidates.join(', ')}. This usually follows ` +
          `a reinstall that left orphaned fields. Pin the right one in the instance record at ${this.path}:\n` +
          `  "overrides": { "fields": { "${role}": "${candidates[0] ?? 'customfield_…'}" } }`,
      );
    }
    return this.record.fields[role];
  }

  /** The field id for a role a command cannot work without. */
  public requireField(role: XrayFieldRole): string {
    const id = this.field(role);
    if (id !== undefined) return id;
    const spec = XRAY_FIELD_ROLES.find((candidate) => candidate.role === role);
    const missing =
      `This instance has no Xray "${role}" field: no field has the schema type ` +
      `${XRAY_SCHEMA_PREFIX}${spec?.schemaType ?? role}.`;
    const remedy =
      'Run "jira xray fields --refresh" to rediscover. If the field exists but was not recognised, pin its ' +
      `id in the instance record at ${this.path}:\n  "overrides": { "fields": { "${role}": "customfield_…" } }`;
    const installed = this.record.xrayVersion;
    const added = spec?.introducedIn;
    if (installed === null || added === undefined) {
      const context = installed === null ? (added === undefined ? '' : ` Xray added it in ${added}.`) : '';
      throw new ConfigError(`${missing}${context} ${remedy}`);
    }
    if (compareVersions(installed, added) < 0) {
      throw new ConfigError(
        `${missing} The installed Xray (${installed}) predates ${added}, which added it, so this needs an Xray upgrade.`,
      );
    }
    throw new ConfigError(
      `${missing} The installed Xray (${installed}) has had it since ${added}, so discovery missed it. ${remedy}`,
    );
  }

  public issueType(role: XrayIssueTypeRole): string | undefined {
    const pinned = this.record.overrides.issueTypes[role];
    if (pinned !== undefined) return pinned;
    const candidates = this.record.ambiguous.issueTypes[role];
    if (candidates !== undefined && candidates.length > 1) {
      throw new ConfigError(
        `More than one issue type looks like Xray's "${role}" type: ${candidates.join(', ')}. Pin the right one ` +
          `in the instance record at ${this.path}:\n` +
          `  "overrides": { "issueTypes": { "${role}": "${candidates[0] ?? '…'}" } }`,
      );
    }
    return this.record.issueTypes[role];
  }

  public requireIssueType(role: XrayIssueTypeRole): string {
    const name = this.issueType(role);
    if (name !== undefined) return name;
    const label = ISSUE_TYPE_ROLES.find((spec) => spec.role === role)?.label ?? role;
    throw new ConfigError(
      `No issue type on this instance looks like Xray's ${label} type. Run "jira xray fields --refresh" to ` +
        `rediscover, or pin its name in the instance record at ${this.path}:\n` +
        `  "overrides": { "issueTypes": { "${role}": "${label}" } }`,
    );
  }

  /** Every field id and issue-type name this record would put in a query. */
  public recordedNames(): { readonly fieldIds: string[]; readonly issueTypeNames: string[] } {
    const { record } = this;
    return {
      fieldIds: [...Object.values(record.fields), ...Object.values(record.overrides.fields)],
      issueTypeNames: [...Object.values(record.issueTypes), ...Object.values(record.overrides.issueTypes)],
    };
  }
}

/**
 * Resolves `--fields` values to field ids, keeping the name the caller used. Role names and Xray
 * field names resolve through the record with no request; anything else needs the instance's
 * field list, which is fetched once and only when such a name is present. Names that match nothing
 * are refused together, before any search runs, rather than silently dropped.
 */
export async function resolveFieldNames(
  instance: XrayInstance,
  client: JiraClient,
  names: readonly string[],
): Promise<ResolvedField[]> {
  const resolved: Array<ResolvedField | undefined> = names.map((name) => resolveFromRecord(instance, name));
  if (resolved.every((entry) => entry !== undefined)) return resolved;

  const all = await listFields(client);
  const unknown: string[] = [];
  const result = names.map((name, index) => {
    const known = resolved[index];
    if (known !== undefined) return known;
    const id = resolveFromJira(all, name);
    if (id === undefined) unknown.push(name);
    return { name, id: id ?? name };
  });
  if (unknown.length > 0) {
    throw new ConfigError(
      `No field matches ${unknown.map((name) => `"${name}"`).join(', ')}. Pass an Xray role (for example ` +
        'steps or repositoryPath), a field name, or a field id; "jira fields --search" finds the id.',
    );
  }
  return result;
}

function resolveFromRecord(instance: XrayInstance, name: string): ResolvedField | undefined {
  const wanted = name.trim().toLowerCase();
  const role = XRAY_FIELD_ROLES.find((spec) => spec.role.toLowerCase() === wanted);
  if (role !== undefined) return { name, id: instance.requireField(role.role) };

  const named = Object.entries(instance.record.fieldNames).filter(
    ([id, display]) => id.toLowerCase() === wanted || display.toLowerCase() === wanted,
  );
  if (named.length > 1)
    throw ambiguousName(
      name,
      named.map(([id]) => id),
    );
  return named[0] === undefined ? undefined : { name, id: named[0][0] };
}

function resolveFromJira(all: readonly JiraField[], name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  const byId = all.find((field) => field.id?.toLowerCase() === wanted);
  if (byId?.id !== undefined) return byId.id;
  const byName = all.filter((field) => field.name?.toLowerCase() === wanted && field.id !== undefined);
  if (byName.length > 1)
    throw ambiguousName(
      name,
      byName.map((field) => field.id ?? ''),
    );
  return byName[0]?.id;
}

function ambiguousName(name: string, ids: readonly string[]): ConfigError {
  return new ConfigError(`More than one field is named "${name}": ${ids.join(', ')}. Pass the id instead.`);
}

/** The plugin's version, when the credential can see it. Purely informational, so never fatal. */
async function readXrayVersion(client: JiraClient): Promise<string | null> {
  try {
    const info = await client.getFromRoot<{ version?: unknown }>(`/rest/plugins/1.0/${XRAY_PLUGIN_KEY}-key`);
    return typeof info.version === 'string' ? info.version : null;
  } catch {
    return null;
  }
}

interface FieldMapping {
  readonly fields: Partial<Record<XrayFieldRole, string>>;
  readonly ambiguous: Partial<Record<XrayFieldRole, string[]>>;
  readonly unmapped: Record<string, string>;
  readonly fieldNames: Record<string, string>;
}

function mapFields(all: readonly JiraField[]): FieldMapping {
  const candidates = new Map<XrayFieldRole, string[]>();
  const unmapped: Record<string, string> = {};
  const fieldNames: Record<string, string> = {};

  for (const field of all) {
    const schema = field.schema?.custom;
    if (field.id === undefined || schema?.startsWith(XRAY_SCHEMA_PREFIX) !== true) continue;
    fieldNames[field.id] = field.name ?? field.id;
    const spec = XRAY_FIELD_ROLES.find((role) => `${XRAY_SCHEMA_PREFIX}${role.schemaType}` === schema);
    if (spec === undefined) {
      unmapped[field.id] = schema;
    } else {
      candidates.set(spec.role, [...(candidates.get(spec.role) ?? []), field.id]);
    }
  }

  return { ...splitCandidates(candidates), unmapped, fieldNames };
}

function mapIssueTypes(all: readonly JiraIssueType[]): {
  issueTypes: Partial<Record<XrayIssueTypeRole, string>>;
  ambiguous: Partial<Record<XrayIssueTypeRole, string[]>>;
} {
  const candidates = new Map<XrayIssueTypeRole, string[]>();
  for (const type of all) {
    const role = issueTypeRole(type);
    if (role === undefined || type.name === undefined) continue;
    const names = candidates.get(role) ?? [];
    // Jira lists a type once per scheme context on some versions; one name is one candidate.
    if (!names.includes(type.name)) candidates.set(role, [...names, type.name]);
  }
  const { fields, ambiguous } = splitCandidates(candidates);
  return { issueTypes: fields, ambiguous };
}

/** Recognises an Xray issue type by its plugin-served icon or its "Represents a …" description. */
function issueTypeRole(type: JiraIssueType): XrayIssueTypeRole | undefined {
  const description = type.description?.trim() ?? '';
  const byDescription = ISSUE_TYPE_ROLES.find((spec) => spec.description.test(description));
  if (byDescription !== undefined) return byDescription.role;

  const icon = type.iconUrl ?? '';
  if (!icon.includes(XRAY_PLUGIN_KEY)) return undefined;
  const file = (icon.split('?')[0]?.split('/').pop() ?? '').toLowerCase().replaceAll(/[^a-z]/g, '');
  return ISSUE_TYPE_ROLES.find((spec) => file.includes(spec.iconToken))?.role;
}

/** Orders dotted release numbers numerically; Xray's tracker writes some as `R3.0.0`. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] =>
    version
      .replace(/^[^\d]*/, '')
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function splitCandidates<R extends string>(
  candidates: ReadonlyMap<R, string[]>,
): { fields: Partial<Record<R, string>>; ambiguous: Partial<Record<R, string[]>> } {
  const fields: Partial<Record<R, string>> = {};
  const ambiguous: Partial<Record<R, string[]>> = {};
  for (const [role, values] of candidates) {
    if (values.length === 1) fields[role] = values[0];
    else ambiguous[role] = values;
  }
  return { fields, ambiguous };
}

/** Fills in anything an older or hand-edited record left out, so lookups never meet `undefined`. */
function normaliseRecord(raw: Partial<XrayInstanceRecord> & { jiraUrl: string }): XrayInstanceRecord {
  return {
    jiraUrl: raw.jiraUrl,
    discoveredAt: raw.discoveredAt ?? '',
    xrayVersion: raw.xrayVersion ?? null,
    fields: raw.fields ?? {},
    unmapped: raw.unmapped ?? {},
    fieldNames: raw.fieldNames ?? {},
    issueTypes: raw.issueTypes ?? {},
    ambiguous: { fields: raw.ambiguous?.fields ?? {}, issueTypes: raw.ambiguous?.issueTypes ?? {} },
    overrides: { fields: raw.overrides?.fields ?? {}, issueTypes: raw.overrides?.issueTypes ?? {} },
  };
}
