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

/** Why a called test's steps were not inlined. */
export type XrayCallStop = 'cycle' | 'depth' | 'inaccessible';

/** A step that describes an action. */
export interface XrayActionStep {
  readonly index: string;
  readonly action: string;
  readonly data: string;
  readonly result: string;
  /** Attachment file names; the files themselves are not exported. */
  readonly attachments: string[];
}

/** A step that calls another test instead of describing an action. */
export interface XrayCallStep {
  readonly index: string;
  readonly call: { readonly key: string; readonly summary: string | null };
  /** The called test's steps, numbered `3.1`, `3.2`… — empty unless calls are expanded. */
  readonly steps: XrayRecordStep[];
  readonly stop?: XrayCallStop;
}

export type XrayRecordStep = XrayActionStep | XrayCallStep;

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
  readonly expandCalls?: boolean;
  /** How many levels of calls `expandCalls` inlines. Defaults to {@link DEFAULT_MAX_CALL_DEPTH}. */
  readonly maxCallDepth?: number;
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
  /** Each page's records as they are assembled, so a caller can stream them. */
  readonly onRecords?: (records: XrayTestRecord[], progress: XraySearchProgress) => Promise<void> | void;
}

export interface XrayExportResult {
  readonly records: XrayTestRecord[];
  readonly total?: number;
  /** False when `limit` stopped the export before the scope ran out. */
  readonly complete: boolean;
  readonly notes: string[];
}

export const DEFAULT_MAX_CALL_DEPTH = 5;

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

/** The older, text-only form of a calling step. */
const CALL_TEST_TEXT = /^\s*call\s+test\s*\[?\s*([A-Za-z][A-Za-z0-9_]*-\d+)/i;
/** Property names Xray has used for the called key inside `testCallBean`. */
const CALL_KEY_PROPERTIES = ['calledTestIssueKey', 'calledTestKey', 'testIssueKey', 'issueKey', 'testKey', 'key'];

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
  const { records, notes } = await assembleRecords(backend, instance, [issue], extras, options);
  const [record] = records;
  if (record === undefined) throw new ConfigError(`${key} could not be read as a test.`);
  return { record, issue, notes };
}

/** A table of tests: the scope's issues with only the fields a row shows. */
export async function listXrayTests(backend: XrayBackend, input: XrayTestListInput): Promise<XrayTestListResult> {
  const instance = await backend.instance();
  const extras = await backend.resolveFields(instance, input.fields ?? []);
  const search = await searchScopedTests(
    backend,
    input.scope,
    input.filters ?? {},
    (current) => unique(['summary', 'status', current.field('testType'), ...extras.map((extra) => extra.id)]),
    { limit: input.limit },
  );
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
 * Full records for a scope, page by page. Each page's preconditions and called tests are fetched in
 * one batched search per call level, so a page of 100 tests costs a handful of requests, not 101.
 */
export async function exportXrayTests(backend: XrayBackend, input: XrayExportInput): Promise<XrayExportResult> {
  const instance = await backend.instance();
  const extras = await backend.resolveFields(instance, input.fields ?? []);
  const records: XrayTestRecord[] = [];
  const notes = new Set<string>();

  const search = await searchScopedTests(
    backend,
    input.scope,
    input.filters ?? {},
    (current) => testFields(current, extras),
    {
      limit: input.limit,
      onPage: async (issues, progress) => {
        const page = await assembleRecords(backend, instance, issues, extras, input);
        records.push(...page.records);
        for (const note of page.notes) notes.add(note);
        await input.onRecords?.(page.records, progress);
      },
    },
  );

  return { records, total: search.total, complete: search.complete, notes: [...notes] };
}

/** The flat rows a step table shows: a call becomes a marker row, followed by any inlined steps. */
export function stepRows(steps: readonly XrayRecordStep[]): XrayActionStep[] {
  return steps.flatMap((step): XrayActionStep[] => {
    if (!('call' in step)) return [step];
    const marker = { index: step.index, action: callMarker(step), data: '', result: '', attachments: [] };
    return [marker, ...stepRows(step.steps)];
  });
}

/** How a calling step reads in a table: never an empty row. */
export function callMarker(step: XrayCallStep): string {
  const { key, summary } = step.call;
  if (step.stop === 'cycle') return `↺ cycle: ${key}`;
  if (step.stop === 'inaccessible') return `⚠ not accessible: ${key}`;
  const calls = summary === null ? `→ calls ${key}` : `→ calls ${key} "${summary}"`;
  return step.stop === 'depth' ? `${calls} (call depth limit reached)` : calls;
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
  readonly expand: boolean;
  readonly maxDepth: number;
  readonly notes: Set<string>;
}

async function assembleRecords(
  backend: XrayBackend,
  instance: XrayInstance,
  issues: readonly unknown[],
  extras: readonly ResolvedField[],
  options: XrayTestOptions,
): Promise<{ records: XrayTestRecord[]; notes: string[] }> {
  const context: AssemblyContext = {
    instance,
    known: new Map(),
    expand: options.expandCalls === true,
    maxDepth: options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
    notes: new Set(),
  };
  for (const issue of issues) {
    const key = issueProperty(issue, 'key');
    if (typeof key === 'string') context.known.set(key, issue);
  }
  await fetchReferenced(backend, context, issues);
  const records = issues.map((issue) => buildRecord(issue, context, extras));
  return { records, notes: [...context.notes] };
}

/**
 * Fetches every called test and precondition the page refers to, one batched search per call
 * level. Without `expandCalls` only the first level is needed, for the called tests' summaries.
 */
async function fetchReferenced(
  backend: XrayBackend,
  context: AssemblyContext,
  issues: readonly unknown[],
): Promise<void> {
  const { instance } = context;
  const stepsField = instance.field('steps');
  const fields = unique(['summary', 'status', 'issuetype', stepsField, instance.field('testType')]);
  const levels = context.expand ? context.maxDepth : 1;
  const preconditions = issues.flatMap((issue) => keyList(fieldValue(issue, instance.field('preconditions'))));

  let frontier: readonly unknown[] = issues;
  /* eslint-disable no-await-in-loop -- each level's keys are only known once the previous level arrives. */
  for (let level = 1; level <= levels; level += 1) {
    const called = frontier.flatMap((issue) => parseSteps(fieldValue(issue, stepsField)).map((step) => step.call));
    const wanted = unique([...called, ...(level === 1 ? preconditions : [])]).filter((key) => !context.known.has(key));
    if (wanted.length === 0) return;
    const found = await backend.issuesByKeys(wanted, fields);
    for (const key of wanted) context.known.set(key, found.get(key) ?? null);
    frontier = [...found.values()];
  }
  /* eslint-enable no-await-in-loop */
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
    steps: buildSteps(issue, key, context, '', 0, new Set([key])),
    definition: definition(issue, type, instance),
    links: links(issue),
    plans: keyList(fieldValue(issue, instance.field('testPlans'))),
    sets: keyList(fieldValue(issue, instance.field('testSets'))),
    fields: extraValues(issue, extras),
  };
}

function buildSteps(
  issue: unknown,
  caller: string,
  context: AssemblyContext,
  prefix: string,
  depth: number,
  ancestors: ReadonlySet<string>,
): XrayRecordStep[] {
  return parseSteps(fieldValue(issue, context.instance.field('steps'))).map((step, position): XrayRecordStep => {
    const index = prefix === '' ? String(position + 1) : `${prefix}.${position + 1}`;
    if (step.call === undefined) {
      return { index, action: step.action, data: step.data, result: step.result, attachments: step.attachments };
    }
    return callStep(step.call, index, caller, context, depth, ancestors);
  });
}

/** None of these stops is an error: a partial export is more useful than none. */
function callStep(
  key: string,
  index: string,
  caller: string,
  context: AssemblyContext,
  depth: number,
  ancestors: ReadonlySet<string>,
): XrayCallStep {
  const called = knownIssue(context, key, caller, 'called test');
  const base = { index, call: { key, summary: summaryOf(called) }, steps: [] };
  if (called === null) return { ...base, stop: 'inaccessible' };
  if (!context.expand) return base;
  if (ancestors.has(key)) return { ...base, stop: 'cycle' };
  if (called === undefined || depth >= context.maxDepth) return { ...base, stop: 'depth' };
  return { ...base, steps: buildSteps(called, key, context, index, depth + 1, new Set([...ancestors, key])) };
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
  readonly call?: string;
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

function parseStep(raw: Record<string, unknown>): ParsedStep {
  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const action = text(pick(fields, ['action', 'step']));
  return {
    action,
    data: text(pick(fields, ['data'])),
    result: text(pick(fields, ['expected result', 'result', 'expected'])),
    attachments: attachmentNames(raw.attachments),
    call: calledKey(raw.testCallBean ?? fields.testCallBean, action),
  };
}

/** `testCallBean` wins; the `Call Test KEY` text form is for data written before it existed. */
function calledKey(bean: unknown, action: string): string | undefined {
  if (typeof bean === 'string' && isIssueKey(bean)) return bean;
  if (isRecord(bean)) {
    for (const property of CALL_KEY_PROPERTIES) {
      const value = bean[property];
      if (typeof value === 'string' && isIssueKey(value)) return value;
    }
  }
  return CALL_TEST_TEXT.exec(action)?.[1];
}

function pick(fields: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const match = Object.keys(fields).find((key) => key.trim().toLowerCase() === name);
    if (match !== undefined) return fields[match];
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
