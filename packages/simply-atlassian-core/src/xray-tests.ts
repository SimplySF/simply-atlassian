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

import { isIssueKey } from './atlassian-url.js';
import { ConfigError } from './errors.js';
import { describeLinkFromIssue, type IssueLink } from './issue-links.js';
import type { JiraSearchResult } from './jira-client.js';
import { stripControl } from './text.js';
import type { XrayBackend, XraySearchProgress } from './xray-backend.js';
import type { ResolvedField, XrayFieldRole, XrayInstance } from './xray-fields.js';
import { searchScopedTests, type XrayFilters, type XrayScope } from './xray-scope.js';

/** One manual test step. */
export interface XrayActionStep {
  readonly index: string;
  readonly action: string;
  readonly data: string;
  readonly result: string;
  /** Attachment file names; the files themselves are not exported. */
  readonly attachments: string[];
  /**
   * Step properties this version does not interpret, exactly as Xray sent them — such as the
   * `testCallBean` of a step that calls another test. Absent when there are none. A later version
   * may give some of them a typed form of their own.
   */
  readonly extra?: Record<string, unknown>;
}

/**
 * A step in an export record. Only action steps today; a step that calls another test is passed
 * through as one, with the call under `extra`, until called tests are supported (0015, Deferred).
 */
export type XrayRecordStep = XrayActionStep;

export interface XrayLinkRecord {
  /** The link type's name, such as `Tests` or `Blocks`. */
  readonly type: string | null;
  /** Which end of the link the other issue is on, from this test's side. */
  readonly direction: 'inward' | 'outward';
  /** The phrase read from this test's side: `tests`, `is tested by`, `relates to`. */
  readonly relationship: string;
  readonly key: string | null;
  readonly issueType: string | null;
  readonly status: string | null;
  readonly summary: string | null;
}

/**
 * The export record: one test assembled from a search, its steps, its links and its membership.
 * The shape is this project's own contract, documented in the Xray guide — changing a key's
 * meaning or removing one is a breaking change.
 */
export interface XrayTestRecord {
  readonly key: string;
  readonly id: string | null;
  readonly summary: string | null;
  readonly status: string | null;
  /** `Manual`, `Cucumber`, `Generic`, or whatever the instance calls a custom type. */
  readonly type: string | null;
  /** Repository folder, with a leading slash. */
  readonly path: string | null;
  readonly preconditions: Array<{ readonly key: string; readonly summary: string | null }>;
  readonly steps: XrayRecordStep[];
  /** The Gherkin scenario or generic definition; null for a manual test. */
  readonly definition: string | null;
  readonly links: XrayLinkRecord[];
  readonly plans: string[];
  readonly sets: string[];
  /** Every `--fields` value, keyed by the name the caller used. */
  readonly fields: Record<string, unknown>;
}

export interface XrayTestOptions {
  /** Extra fields, added to the defaults: roles, Xray field names, or any Jira field. */
  readonly fields?: readonly string[];
}

export interface XrayTestGetResult {
  readonly record: XrayTestRecord;
  /** The underlying Jira issue, for `--raw`. */
  readonly issue: unknown;
  /** Things skipped because the caller cannot see them — never fatal. */
  readonly notes: string[];
}

export interface XrayTestListInput {
  readonly scope: XrayScope;
  readonly filters?: XrayFilters;
  readonly fields?: readonly string[];
  readonly limit: number;
}

export interface XrayTestRow {
  readonly key: string | null;
  readonly type: string | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly fields: Record<string, unknown>;
}

export interface XrayTestListResult {
  /** What `--json` prints: raw issues plus paging, like `issue search`. */
  readonly search: JiraSearchResult;
  readonly rows: XrayTestRow[];
  readonly extraFields: ResolvedField[];
}

export interface XrayExportInput extends XrayTestListInput, XrayTestOptions {
  /**
   * Each page's records as they are assembled, so a caller can stream them. Given this, the result
   * does not also collect them, so a large export's memory stays at one page.
   */
  readonly onRecords?: (records: XrayTestRecord[], progress: XraySearchProgress) => Promise<void> | void;
}

export interface XrayExportResult {
  /** Every record, or none when they were streamed through `onRecords`. */
  readonly records: XrayTestRecord[];
  readonly total?: number;
  /** False when `limit` stopped the export before the scope ran out. */
  readonly complete: boolean;
  readonly notes: string[];
}

/** Fields every assembled test needs from Jira itself. */
const BASE_FIELDS = ['summary', 'status', 'issuetype', 'issuelinks'];

/** The Xray fields a Test carries; each is requested when this instance has it. */
const TEST_ROLES: readonly XrayFieldRole[] = [
  'testType',
  'steps',
  'cucumberType',
  'cucumberScenario',
  'genericDefinition',
  'preconditions',
  'testSets',
  'testPlans',
  'repositoryPath',
];

/** Step properties the parser reads; any other is passed through under the step's `extra`. */
const READ_STEP_PROPERTIES = new Set(['id', 'index', 'fields', 'attachments']);

/** One test, assembled. */
export async function getXrayTest(
  backend: XrayBackend,
  key: string,
  options: XrayTestOptions = {},
): Promise<XrayTestGetResult> {
  if (!isIssueKey(key)) throw new ConfigError(`"${key}" is not an issue key. Pass a test key such as PROJ-12.`);
  const instance = await backend.instance();
  const extras = await backend.resolveFields(instance, options.fields ?? []);
  const issue = await backend.issue(key, testFields(instance, extras));
  assertIsTest(issue, key, instance);
  const { records, notes } = await assembleRecords(backend, instance, [issue], extras);
  const [record] = records;
  if (record === undefined) throw new ConfigError(`${key} could not be read as a test.`);
  return { record, issue, notes };
}

/** A table of tests: the scope's issues with only the fields a row shows. */
export async function listXrayTests(backend: XrayBackend, input: XrayTestListInput): Promise<XrayTestListResult> {
  const extrasFor = fieldResolver(backend, input.fields ?? []);
  const { instance, ...search } = await searchScopedTests(
    backend,
    input.scope,
    input.filters ?? {},
    async (current) =>
      unique(['summary', 'status', current.field('testType'), ...(await extrasFor(current)).map((extra) => extra.id)]),
    { limit: input.limit },
  );
  // The instance the search ran with: after a rediscovery, the one it started with has stale ids.
  const extras = await extrasFor(instance);
  const testType = instance.field('testType');
  const rows = search.issues.map((issue) => ({
    key: stringOrNull(issueProperty(issue, 'key')),
    type: optionText(fieldValue(issue, testType)),
    status: nameOf(fieldValue(issue, 'status')),
    summary: stringOrNull(fieldValue(issue, 'summary')),
    fields: extraValues(issue, extras),
  }));
  return { search, rows, extraFields: extras };
}

/**
 * Full records for a scope, page by page. Each page's preconditions are fetched in one batched
 * search, so a page of 100 tests costs two requests, not 101.
 */
export async function exportXrayTests(backend: XrayBackend, input: XrayExportInput): Promise<XrayExportResult> {
  const extrasFor = fieldResolver(backend, input.fields ?? []);
  const records: XrayTestRecord[] = [];
  const notes = new Set<string>();

  const search = await searchScopedTests(
    backend,
    input.scope,
    input.filters ?? {},
    async (current) => testFields(current, await extrasFor(current)),
    {
      limit: input.limit,
      onPage: async (issues, progress, instance) => {
        const page = await assembleRecords(backend, instance, issues, await extrasFor(instance));
        if (input.onRecords === undefined) records.push(...page.records);
        for (const note of page.notes) notes.add(note);
        await input.onRecords?.(page.records, progress);
      },
    },
  );

  return { records, total: search.total, complete: search.complete, notes: [...notes] };
}

/**
 * `--fields` resolved against a given instance record, once per record. A search that rediscovers
 * builds its retry from the fresh record, so the extra fields must be resolved against it too.
 */
export function fieldResolver(
  backend: XrayBackend,
  names: readonly string[],
): (instance: XrayInstance) => Promise<ResolvedField[]> {
  let cached: { readonly instance: XrayInstance; readonly extras: Promise<ResolvedField[]> } | undefined;
  return (instance) => {
    if (cached?.instance !== instance) cached = { instance, extras: backend.resolveFields(instance, names) };
    return cached.extras;
  };
}

/**
 * The rows a step table shows, one per step. A step that carries only data this version does not
 * interpret — a call to another test, say — names it rather than show an empty row.
 */
export function stepRows(steps: readonly XrayRecordStep[]): XrayActionStep[] {
  return steps.map((step) =>
    step.action === '' && step.extra !== undefined
      ? { ...step, action: `(not interpreted: ${Object.keys(step.extra).join(', ')})` }
      : step,
  );
}

/** One section per test, readable by a person or a model. */
export function renderXrayMarkdown(record: XrayTestRecord): string {
  const lines = [`## ${record.key}${record.summary === null ? '' : ` — ${inline(record.summary)}`}`, ''];
  const facts: Array<[string, string | null]> = [
    ['Type', record.type],
    ['Status', record.status],
    ['Path', record.path],
    ['Plans', record.plans.join(', ') || null],
    ['Sets', record.sets.join(', ') || null],
  ];
  for (const [label, value] of facts) if (value !== null) lines.push(`- **${label}:** ${inline(value)}`);
  lines.push(
    ...markdownPreconditions(record),
    ...markdownSteps(record),
    ...markdownDefinition(record),
    ...markdownLinks(record),
    ...markdownFields(record),
  );
  return `${lines.join('\n')}\n`;
}

function markdownPreconditions(record: XrayTestRecord): string[] {
  if (record.preconditions.length === 0) return [];
  return [
    '',
    '### Preconditions',
    '',
    ...record.preconditions.map((pre) => `- ${pre.key}${pre.summary === null ? '' : ` — ${inline(pre.summary)}`}`),
  ];
}

function markdownSteps(record: XrayTestRecord): string[] {
  if (record.steps.length === 0) return [];
  return [
    '',
    '### Steps',
    '',
    '| # | Action | Data | Expected result |',
    '| --- | --- | --- | --- |',
    ...stepRows(record.steps).map(
      (row) => `| ${row.index} | ${cellText(row.action)} | ${cellText(row.data)} | ${cellText(row.result)} |`,
    ),
  ];
}

function markdownDefinition(record: XrayTestRecord): string[] {
  if (record.definition === null) return [];
  const body = stripControl(record.definition);
  // Longer than any backtick run in the body, so a definition cannot close its own fence.
  const longest = (body.match(/`+/g) ?? []).reduce((widest, run) => Math.max(widest, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const language = record.type?.toLowerCase() === 'cucumber' ? 'gherkin' : '';
  return ['', '### Definition', '', `${fence}${language}`, body, fence];
}

function markdownLinks(record: XrayTestRecord): string[] {
  if (record.links.length === 0) return [];
  return [
    '',
    '### Links',
    '',
    ...record.links.map((link) => {
      const detail = [link.issueType, link.status].filter((part) => part !== null).join(', ');
      const summary = link.summary === null ? '' : ` — ${inline(link.summary)}`;
      return `- ${link.relationship} ${link.key ?? '—'}${detail === '' ? '' : ` (${inline(detail)})`}${summary}`;
    }),
  ];
}

function markdownFields(record: XrayTestRecord): string[] {
  const extras = Object.entries(record.fields);
  if (extras.length === 0) return [];
  return [
    '',
    '### Fields',
    '',
    ...extras.map(([name, value]) => `- **${inline(name)}:** ${inline(displayValue(value))}`),
  ];
}

/** Renders a simplified field value as one line of text. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).join(', ');
  return JSON.stringify(value) ?? '—';
}

/**
 * Named Jira objects become their name, so `components` reads `["Accounts"]` rather than a list of
 * objects carrying ids and self links. Anything without a name is kept as Jira sent it.
 */
export function simplifyFieldValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return null;
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => simplifyFieldValue(item, depth + 1));
  const named = value as Record<string, unknown>;
  for (const property of ['name', 'value', 'displayName', 'key']) {
    if (typeof named[property] === 'string') return named[property];
  }
  return value;
}

// --- Assembly ---

interface AssemblyContext {
  readonly instance: XrayInstance;
  /** Issues already fetched by key; `null` means asked for and not visible to this caller. */
  readonly known: Map<string, unknown>;
  readonly notes: Set<string>;
}

async function assembleRecords(
  backend: XrayBackend,
  instance: XrayInstance,
  issues: readonly unknown[],
  extras: readonly ResolvedField[],
): Promise<{ records: XrayTestRecord[]; notes: string[] }> {
  const context: AssemblyContext = { instance, known: new Map(), notes: new Set() };
  await fetchPreconditions(backend, context, issues);
  const records = issues.map((issue) => buildRecord(issue, context, extras));
  return { records, notes: [...context.notes] };
}

/** Fetches every precondition the page refers to, for their summaries, in one batched search. */
async function fetchPreconditions(
  backend: XrayBackend,
  context: AssemblyContext,
  issues: readonly unknown[],
): Promise<void> {
  const field = context.instance.field('preconditions');
  const wanted = unique(issues.flatMap((issue) => keyList(fieldValue(issue, field))));
  if (wanted.length === 0) return;
  const found = await backend.issuesByKeys(wanted, ['summary', 'status', 'issuetype']);
  for (const key of wanted) context.known.set(key, found.get(key) ?? null);
}

function buildRecord(issue: unknown, context: AssemblyContext, extras: readonly ResolvedField[]): XrayTestRecord {
  const { instance } = context;
  const key = stringOrNull(issueProperty(issue, 'key')) ?? '';
  const type = testTypeOf(issue, instance);
  return {
    key,
    id: stringOrNull(issueProperty(issue, 'id')),
    summary: stringOrNull(fieldValue(issue, 'summary')),
    status: nameOf(fieldValue(issue, 'status')),
    type,
    path: repositoryPath(fieldValue(issue, instance.field('repositoryPath'))),
    preconditions: keyList(fieldValue(issue, instance.field('preconditions'))).map((pre) => ({
      key: pre,
      summary: summaryOf(knownIssue(context, pre, key, 'precondition')),
    })),
    steps: buildSteps(issue, context),
    definition: definition(issue, type, instance),
    links: links(issue),
    plans: keyList(fieldValue(issue, instance.field('testPlans'))),
    sets: keyList(fieldValue(issue, instance.field('testSets'))),
    fields: extraValues(issue, extras),
  };
}

/** The test's steps, numbered from 1. Data a step carries that is not read is kept, and noted once per name. */
function buildSteps(issue: unknown, context: AssemblyContext): XrayRecordStep[] {
  return parseSteps(fieldValue(issue, context.instance.field('steps'))).map((step, position) => {
    const { extra, ...read } = step;
    if (extra === undefined) return { index: String(position + 1), ...read };
    for (const name of uninterpretedNames(extra)) {
      context.notes.add(
        `Steps carry "${name}", which this version does not interpret; it is passed through under the step's "extra".`,
      );
    }
    return { index: String(position + 1), ...read, extra };
  });
}

/** `testCallBean`, or `fields.Comment` for a step column the parser does not read. */
function uninterpretedNames(extra: Record<string, unknown>): string[] {
  return Object.entries(extra).flatMap(([name, value]) =>
    name === 'fields' && isRecord(value) ? Object.keys(value).map((column) => `fields.${column}`) : [name],
  );
}

/** A fetched issue, `null` if it was asked for and is not visible (noted), or undefined if never fetched. */
function knownIssue(context: AssemblyContext, key: string, from: string, what: string): unknown {
  const issue = context.known.get(key);
  if (issue === null) context.notes.add(`${key} (${what} of ${from}) is not accessible; skipped.`);
  return issue;
}

function assertIsTest(issue: unknown, key: string, instance: XrayInstance): void {
  const expected = instance.issueType('test');
  const actual = nameOf(fieldValue(issue, 'issuetype'));
  if (expected !== undefined && actual !== null && actual !== expected) {
    throw new ConfigError(`${key} is a ${actual}, not an Xray ${expected}.`);
  }
}

// --- Parsing Xray's field values ---

interface ParsedStep {
  readonly action: string;
  readonly data: string;
  readonly result: string;
  readonly attachments: string[];
  readonly extra?: Record<string, unknown>;
}

/**
 * Reads the manual steps field. Current Xray returns `{ steps: [{ index, fields: { Action, Data,
 * "Expected Result" } }] }`; older versions return the list itself with `step`/`data`/`result`,
 * sometimes as `{ raw, rendered }`. Step field names are configurable, so they are matched loosely.
 */
function parseSteps(value: unknown): ParsedStep[] {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.steps) ? value.steps : [];
  return list
    .filter(isRecord)
    .map((raw, position) => ({ raw, position, order: typeof raw.index === 'number' ? raw.index : Number.NaN }))
    .sort((left, right) =>
      Number.isNaN(left.order) || Number.isNaN(right.order) ? left.position - right.position : left.order - right.order,
    )
    .map(({ raw }) => parseStep(raw));
}

/**
 * One step. Whatever is not read — a property such as `testCallBean`, or a step column beyond
 * action, data and expected result — is kept under `extra` as Xray sent it, so nothing is dropped
 * and nothing is guessed at.
 */
function parseStep(raw: Record<string, unknown>): ParsedStep {
  const nested = isRecord(raw.fields);
  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const columns = {
    action: pickKey(fields, ['action', 'step']),
    data: pickKey(fields, ['data']),
    result: pickKey(fields, ['expected result', 'result', 'expected']),
  };
  const read = new Set(Object.values(columns));
  const unread = (entries: Record<string, unknown>, skip: (name: string) => boolean): Record<string, unknown> =>
    Object.fromEntries(Object.entries(entries).filter(([name]) => !skip(name)));

  const extra = unread(raw, (name) => READ_STEP_PROPERTIES.has(name) || (!nested && read.has(name)));
  const columnsLeft = nested ? unread(fields, (name) => read.has(name)) : {};
  if (Object.keys(columnsLeft).length > 0) extra.fields = columnsLeft;

  return {
    action: text(columns.action === undefined ? undefined : fields[columns.action]),
    data: text(columns.data === undefined ? undefined : fields[columns.data]),
    result: text(columns.result === undefined ? undefined : fields[columns.result]),
    attachments: attachmentNames(raw.attachments),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/** The first of `names` that `fields` has, matched case-insensitively. */
function pickKey(fields: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const match = Object.keys(fields).find((key) => key.trim().toLowerCase() === name);
    if (match !== undefined) return match;
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isRecord(value)) {
    if (typeof value.raw === 'string') return value.raw;
    if (typeof value.rendered === 'string') return value.rendered;
  }
  return '';
}

function attachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: unknown) =>
      isRecord(item) ? (item.fileName ?? item.filename ?? item.name) : typeof item === 'string' ? item : undefined,
    )
    .filter((name): name is string => typeof name === 'string');
}

function testTypeOf(issue: unknown, instance: XrayInstance): string | null {
  const declared = optionText(fieldValue(issue, instance.field('testType')));
  if (declared !== null) return declared;
  if (parseSteps(fieldValue(issue, instance.field('steps'))).length > 0) return 'Manual';
  if (text(fieldValue(issue, instance.field('cucumberScenario'))) !== '') return 'Cucumber';
  if (text(fieldValue(issue, instance.field('genericDefinition'))) !== '') return 'Generic';
  return null;
}

function definition(issue: unknown, type: string | null, instance: XrayInstance): string | null {
  const scenario = text(fieldValue(issue, instance.field('cucumberScenario')));
  const generic = text(fieldValue(issue, instance.field('genericDefinition')));
  const kind = type?.toLowerCase();
  if (kind === 'manual') return null;
  if (kind === 'cucumber') return scenario === '' ? null : scenario;
  if (kind === 'generic') return generic === '' ? null : generic;
  return scenario !== '' ? scenario : generic !== '' ? generic : null;
}

/** The repository path field holds a string or a list of folder names, depending on version. */
function repositoryPath(value: unknown): string | null {
  const raw = Array.isArray(value) ? value.filter((part) => typeof part === 'string').join('/') : text(value);
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function links(issue: unknown): XrayLinkRecord[] {
  const raw = fieldValue(issue, 'issuelinks');
  if (!Array.isArray(raw)) return [];
  return (raw as IssueLink[]).map((link) => {
    const { phrase, other } = describeLinkFromIssue(link);
    const otherFields = other?.fields as { issuetype?: unknown; status?: unknown; summary?: unknown } | undefined;
    return {
      type: stringOrNull(link.type?.name),
      direction: link.inwardIssue === undefined ? 'outward' : 'inward',
      relationship: phrase,
      key: stringOrNull(other?.key),
      issueType: nameOf(otherFields?.issuetype),
      status: nameOf(otherFields?.status),
      summary: stringOrNull(otherFields?.summary),
    };
  });
}

function extraValues(issue: unknown, extras: readonly ResolvedField[]): Record<string, unknown> {
  return Object.fromEntries(extras.map((extra) => [extra.name, simplifyFieldValue(fieldValue(issue, extra.id))]));
}

/** Plans, sets and preconditions arrive as keys, or as objects carrying one. */
function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: unknown) => (typeof item === 'string' ? item : isRecord(item) ? item.key : undefined))
    .filter((key): key is string => typeof key === 'string');
}

/** A select option (`{ value }`), a named object, or a bare string. */
function optionText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (isRecord(value)) {
    const option = value.value ?? value.name;
    if (typeof option === 'string' && option !== '') return option;
  }
  return null;
}

function nameOf(value: unknown): string | null {
  return isRecord(value) && typeof value.name === 'string' ? value.name : null;
}

function summaryOf(issue: unknown): string | null {
  return stringOrNull(fieldValue(issue, 'summary'));
}

function fieldValue(issue: unknown, id: string | undefined): unknown {
  if (id === undefined || !isRecord(issue) || !isRecord(issue.fields)) return undefined;
  return issue.fields[id];
}

function issueProperty(issue: unknown, name: string): unknown {
  return isRecord(issue) ? issue[name] : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unique(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function testFields(instance: XrayInstance, extras: readonly ResolvedField[]): string[] {
  return unique([
    ...BASE_FIELDS,
    ...TEST_ROLES.map((role) => instance.field(role)),
    ...extras.map((extra) => extra.id),
  ]);
}

/** Markdown table cells cannot hold a pipe or a line break. */
function cellText(value: string): string {
  return stripControl(value).replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
}

function inline(value: string): string {
  return stripControl(value).replaceAll(/\s*\n\s*/g, ' ');
}
