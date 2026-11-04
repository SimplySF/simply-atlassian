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
import { CliError, ConfigError, XrayPartialWriteError } from './errors.js';
import { listFields, type JiraField } from './jira-discovery.js';
import type { JiraClient } from './jira-client.js';
import { assertIssueKey } from './jira-issues.js';
import { buildIssueLinkBody } from './jira-links.js';
import { mergeFields } from './json-input.js';
import type { XrayBackend } from './xray-backend.js';
import { compareVersions, XRAY_FIELD_ROLES, type ResolvedField, type XrayInstance } from './xray-fields.js';
import { assertProjectKey } from './xray-scope.js';
import { getXrayTest, parseSteps, type ParsedStep, type XrayTestRecord } from './xray-tests.js';

/** The text of a step: what the record calls action, data and result. */
export interface XrayStepText {
  readonly action: string;
  readonly data: string;
  readonly result: string;
}

/** A step as a caller wants it. An `id` says which existing step this is. */
export interface XrayStepInput extends XrayStepText {
  readonly id?: string | null;
  readonly attachments?: readonly string[];
  readonly extra?: Record<string, unknown>;
}

export type XrayStepOperation =
  | ({ readonly op: 'add' } & XrayStepText)
  | { readonly op: 'update'; readonly id: string; readonly changes: Partial<XrayStepText> }
  | { readonly op: 'delete'; readonly id: string; readonly action: string };

/** What a replace would do, in the order it would do it. */
export interface XrayStepPlan {
  readonly operations: XrayStepOperation[];
  readonly warnings: string[];
  readonly deletes: boolean;
}

/** A write that was carried out: the test read back, or null with a note if that read failed. */
export interface XrayWriteResult {
  readonly record: XrayTestRecord | null;
  readonly notes: string[];
}

export interface XrayStepDryRun {
  readonly dryRun: true;
  readonly test: string;
  readonly operations: XrayStepOperation[];
  readonly notes: string[];
}

export type XrayStepWriteResult = XrayWriteResult | XrayStepDryRun;

export interface XrayStepAddInput {
  readonly test: string;
  readonly action?: string;
  readonly data?: string;
  readonly result?: string;
  readonly dryRun?: boolean;
}

export interface XrayStepUpdateInput extends XrayStepAddInput {
  readonly step: string;
}

export interface XrayStepDeleteInput {
  readonly test: string;
  readonly step: string;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
}

const REORDER_REFUSAL =
  "Xray's API documents no way to reorder steps or to add one at a position: a new step always goes last. " +
  'Keep the existing steps in their order with new ones after them, or delete and re-add the steps to move.';

/**
 * Works out what turns `current` into `desired`, sending nothing, so a dry run prints exactly what
 * a real run does. Steps are matched by id, or by position when the input has no ids at all.
 * Updates run first and deletes last, so what cannot be undone happens after everything else worked.
 */
export function planStepChanges(
  test: string,
  current: readonly ParsedStep[],
  desired: readonly XrayStepInput[],
): XrayStepPlan {
  for (const step of desired) assertNotCallStep(test, step);
  const byId = desired.some((step) => hasId(step));
  return byId ? planById(test, current, desired) : planByPosition(test, current, desired);
}

function planById(test: string, current: readonly ParsedStep[], desired: readonly XrayStepInput[]): XrayStepPlan {
  const known = new Map(current.flatMap((step) => (step.id === null ? [] : [[step.id, step] as const])));
  const seen = new Set<string>();
  const updates: XrayStepOperation[] = [];
  const adds: XrayStepOperation[] = [];
  const kept: string[] = [];

  for (const step of desired) {
    if (!hasId(step)) {
      adds.push(addOperation(step));
    } else {
      const existing = known.get(step.id);
      if (existing === undefined) {
        throw new ConfigError(
          `Step ${step.id} is not on ${test}, so the input is stale or came from another test; nothing was sent. ` +
            `Its steps are: ${describeIds(current)}. Export the test again, or remove the id to add it as new.`,
        );
      }
      if (seen.has(step.id)) throw new ConfigError(`Step ${step.id} appears twice in the input; nothing was sent.`);
      if (adds.length > 0) throw new ConfigError(`A new step comes before step ${step.id}. ${REORDER_REFUSAL}`);
      seen.add(step.id);
      kept.push(step.id);
      const changes = changedText(existing, step);
      if (Object.keys(changes).length > 0) updates.push({ op: 'update', id: step.id, changes });
    }
  }

  const order = current.flatMap((step) => (step.id !== null && seen.has(step.id) ? [step.id] : []));
  if (order.some((id, index) => id !== kept[index])) {
    throw new ConfigError(`The input reorders the steps of ${test}. ${REORDER_REFUSAL}`);
  }
  const deletes = current.filter((step) => step.id !== null && !seen.has(step.id)).map((step) => deleteOperation(step));
  return { operations: [...updates, ...adds, ...deletes], warnings: [], deletes: deletes.length > 0 };
}

function planByPosition(test: string, current: readonly ParsedStep[], desired: readonly XrayStepInput[]): XrayStepPlan {
  const updates: XrayStepOperation[] = [];
  const warnings: string[] = [];

  desired.slice(0, current.length).forEach((step, position) => {
    const existing = current[position];
    if (existing === undefined) return;
    const changes = changedText(existing, step);
    if (Object.keys(changes).length === 0) return;
    assertNotCallStep(test, existing);
    if (existing.id === null)
      throw new ConfigError(`Step ${position + 1} of ${test} has no id, so it cannot be edited.`);
    updates.push({ op: 'update', id: existing.id, changes });
    if (existing.attachments.length > 0) {
      warnings.push(
        `Step ${position + 1} of ${test} changes text but keeps its attachments (${existing.attachments.join(', ')}), ` +
          'because the input has no step ids and steps were matched by position.',
      );
    }
  });

  const adds = desired.slice(current.length).map((step) => addOperation(step));
  const deletes = current.slice(desired.length).map((step, offset) => {
    if (step.id === null) {
      throw new ConfigError(`Step ${desired.length + offset + 1} of ${test} has no id, so it cannot be deleted.`);
    }
    return deleteOperation(step);
  });
  return { operations: [...updates, ...adds, ...deletes], warnings, deletes: deletes.length > 0 };
}

/**
 * Sends a plan's operations in order. Past the first, a failure is reported with what landed and
 * what did not, since the test is now part-way there and a blind retry would repeat the adds.
 */
export async function applyStepOperations(
  backend: XrayBackend,
  test: string,
  operations: readonly XrayStepOperation[],
  applied: readonly string[] = [],
): Promise<void> {
  const done = [...applied];
  /* eslint-disable no-await-in-loop -- steps are positional: Xray appends in the order it receives them. */
  for (const [position, operation] of operations.entries()) {
    try {
      await sendOperation(backend, test, operation);
    } catch (error) {
      if (done.length === 0 || !(error instanceof CliError)) throw error;
      throw new XrayPartialWriteError(
        `${test} was only partly updated: ${error.message}`,
        done,
        operations.slice(position).map((rest) => describeStepOperation(rest)),
        `Read it with "jira xray test get ${test}" before retrying.`,
      );
    }
    done.push(describeStepOperation(operation));
  }
  /* eslint-enable no-await-in-loop */
}

function sendOperation(backend: XrayBackend, test: string, operation: XrayStepOperation): Promise<void> {
  switch (operation.op) {
    case 'add':
      return backend.addTestStep(test, stepBody(operation));
    case 'update':
      return backend.updateTestStep(test, operation.id, stepBody(operation.changes));
    case 'delete':
      return backend.deleteTestStep(test, operation.id);
  }
}

/** One line a person can read, for a dry run and for a partial failure. */
export function describeStepOperation(operation: XrayStepOperation): string {
  switch (operation.op) {
    case 'add':
      return `add a step: ${operation.action}`;
    case 'update':
      return `update step ${operation.id}: ${Object.keys(operation.changes).join(', ')}`;
    case 'delete':
      return `delete step ${operation.id}: ${operation.action}`;
  }
}

/** Appends one step; Xray documents no way to place it anywhere else. */
export async function addXrayStep(backend: XrayBackend, input: XrayStepAddInput): Promise<XrayStepWriteResult> {
  const test = assertIssueKey(input.test);
  if (input.action === undefined || input.action.trim() === '') {
    throw new ConfigError('A step needs an action. Pass --action.');
  }
  const { record } = await getXrayTest(backend, test);
  assertManual(test, record.type);
  const operation: XrayStepOperation = {
    op: 'add',
    action: input.action,
    data: input.data ?? '',
    result: input.result ?? '',
  };
  if (input.dryRun === true) return { dryRun: true, test, operations: [operation], notes: [] };
  await applyStepOperations(backend, test, [operation]);
  return readBackTest(backend, test);
}

/** Edits one step, sending only the columns that change; custom columns are left as they are. */
export async function updateXrayStep(backend: XrayBackend, input: XrayStepUpdateInput): Promise<XrayStepWriteResult> {
  const test = assertIssueKey(input.test);
  const id = assertStepId(input.step);
  if (input.action === undefined && input.data === undefined && input.result === undefined) {
    throw new ConfigError(`Nothing to update on step ${id}. Pass --action, --data or --result.`);
  }
  const existing = await findStep(backend, test, id);
  assertNotCallStep(test, existing);
  const changes = changedText(existing, input);
  const notes = untouchedColumnNotes(test, [existing]);
  const operations: XrayStepOperation[] = Object.keys(changes).length > 0 ? [{ op: 'update', id, changes }] : [];
  if (input.dryRun === true) return { dryRun: true, test, operations, notes };
  await applyStepOperations(backend, test, operations);
  return readBackTest(backend, test, notes);
}

/**
 * Deletes one step, in the order `deleteIssue` uses: shapes first, a dry run before consent, and
 * consent before any request, so a call without it never reaches the instance.
 */
export async function deleteXrayStep(backend: XrayBackend, input: XrayStepDeleteInput): Promise<XrayStepWriteResult> {
  const test = assertIssueKey(input.test);
  const id = assertStepId(input.step);
  if (input.dryRun !== true && input.confirm !== true) {
    throw new ConfigError(`Deleting step ${id} of ${test} cannot be undone. Pass --confirm to proceed.`);
  }
  const operation = deleteOperation(await findStep(backend, test, id));
  if (input.dryRun === true) return { dryRun: true, test, operations: [operation], notes: [] };
  await applyStepOperations(backend, test, [operation]);
  return readBackTest(backend, test);
}

/** The steps through Xray's step API, which is the documented source of the ids its writes take. */
export async function readCurrentSteps(backend: XrayBackend, test: string): Promise<ParsedStep[]> {
  return parseSteps(await backend.testSteps(test));
}

/**
 * Reads a test back after a write, reporting a failure rather than throwing it: the write landed,
 * so calling this a failure would invite a retry of it.
 */
export async function readBackTest(
  backend: XrayBackend,
  test: string,
  notes: readonly string[] = [],
): Promise<XrayWriteResult> {
  try {
    const result = await getXrayTest(backend, test);
    return { record: result.record, notes: [...notes, ...result.notes] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown reason';
    return { record: null, notes: [...notes, `The write succeeded, but ${test} could not be read back: ${reason}`] };
  }
}

/** One note naming the custom step columns a write leaves alone, or none. */
export function untouchedColumnNotes(test: string, steps: ReadonlyArray<{ readonly extra?: unknown }>): string[] {
  const columns = new Set(
    steps.flatMap((step) => {
      const fields = (step.extra as { fields?: unknown } | undefined)?.fields;
      return typeof fields === 'object' && fields !== null ? Object.keys(fields) : [];
    }),
  );
  if (columns.size === 0) return [];
  return [
    `Custom step columns on ${test} (${[...columns].join(', ')}) were not written: Xray documents no way to, ` +
      'so existing values are left as they are.',
  ];
}

export function assertManual(test: string, type: string | null): void {
  if (type !== null && type.toLowerCase() !== 'manual') {
    throw new ConfigError(`${test} is a ${type} test; only Manual tests have steps.`);
  }
}

function assertStepId(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`"${value}" is not a step id. Step ids are numeric; "jira xray test get" shows them.`);
  }
  return value;
}

async function findStep(backend: XrayBackend, test: string, id: string): Promise<ParsedStep> {
  const steps = await readCurrentSteps(backend, test);
  const found = steps.find((step) => step.id === id);
  if (found === undefined) throw new ConfigError(`Step ${id} is not on ${test}. Its steps are: ${describeIds(steps)}.`);
  return found;
}

function hasId(step: XrayStepInput): step is XrayStepInput & { readonly id: string } {
  return step.id !== undefined && step.id !== null;
}

function describeIds(steps: readonly ParsedStep[]): string {
  const ids = steps.flatMap((step) => (step.id === null ? [] : [step.id]));
  return ids.length === 0 ? '(none)' : ids.join(', ');
}

function assertNotCallStep(test: string, step: { readonly extra?: Record<string, unknown> }): void {
  if (step.extra !== undefined && 'testCallBean' in step.extra) {
    throw new ConfigError(
      `A step of ${test} calls another test, which this version cannot write: Xray does not document the form. ` +
        'Nothing was sent.',
    );
  }
}

/** The columns of `wanted` that differ from `existing`; a column left undefined is not a change. */
function changedText(existing: XrayStepText, wanted: Partial<XrayStepText>): Partial<XrayStepText> {
  const changes: { -readonly [K in keyof XrayStepText]?: string } = {};
  for (const column of ['action', 'data', 'result'] as const) {
    const value = wanted[column];
    if (value !== undefined && normalise(value) !== normalise(existing[column])) changes[column] = value;
  }
  return changes;
}

/** Line endings only: a text area may hand back CRLF for what was sent as LF, and that is no edit. */
function normalise(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function addOperation(step: XrayStepText): XrayStepOperation {
  return { op: 'add', action: step.action, data: step.data, result: step.result };
}

function deleteOperation(step: ParsedStep): XrayStepOperation {
  return { op: 'delete', id: step.id ?? '', action: step.action };
}

/** Test Steps - REST: `{ step, data, result }`, sending only "the information you want to update". */
function stepBody(text: Partial<XrayStepText>): Record<string, string> {
  return {
    ...(text.action === undefined ? {} : { step: text.action }),
    ...(text.data === undefined ? {} : { data: text.data }),
    ...(text.result === undefined ? {} : { result: text.result }),
  };
}

// --- Creating and updating a test ---

/** What `create` and `update` both accept. Flags override `record`, and `record` overrides `body`. */
export interface XrayTestInput {
  /** One export record, as `test export --format json` writes one test. */
  readonly record?: Record<string, unknown>;
  readonly summary?: string;
  readonly type?: string;
  readonly steps?: readonly XrayStepInput[];
  readonly gherkin?: string;
  readonly definition?: string;
  /** Role or field name → value. Never needs a `customfield_…` id. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Raw `{ fields: … }`, merged underneath, as on `issue create`. */
  readonly body?: Record<string, unknown>;
  readonly dryRun?: boolean;
}

export interface XrayTestCreateInput extends XrayTestInput {
  readonly project?: string;
  /** Requirements this test verifies; each gets a link. */
  readonly verifies?: readonly string[];
}

export interface XrayTestUpdateInput extends XrayTestInput {
  readonly test: string;
  /** Needed only when the step plan deletes a step. */
  readonly confirm?: boolean;
}

export interface XrayTestCreateDryRun {
  readonly dryRun: true;
  readonly request: Record<string, unknown>;
  readonly verifies: string[];
  readonly notes: string[];
}

export interface XrayTestUpdateDryRun {
  readonly dryRun: true;
  readonly test: string;
  /** The issue update, or null when no field changes. */
  readonly request: Record<string, unknown> | null;
  readonly operations: XrayStepOperation[];
  readonly notes: string[];
}

/** The phrase resolved against the instance's own link types, so a renamed type is reported, not guessed. */
const VERIFIES_PHRASE = 'tests';
/** From this Xray version the Cucumber type is detected, and need not be sent (Tests - REST). */
const CUCUMBER_TYPE_OPTIONAL_FROM = '7.3.0';
const RECORD_APPLIED = new Set(['summary', 'type', 'steps', 'definition', 'fields']);
/** Xray's own fields, which have typed input or belong to deferred features. */
const NOT_WRITABLE_ROLES = XRAY_FIELD_ROLES.map((spec) => spec.role).filter((role) => role !== 'cucumberType');

/** Reads one export record from a file. An array is a batch, which is not supported yet. */
export function readXrayRecordFile(path: string): Record<string, unknown> {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read ${path}: ${error instanceof Error ? error.message : 'unknown reason'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Never the parser's snippet: a caller can name any path, and it would echo the file's bytes.
    throw new ConfigError(`${path} is not valid JSON.`);
  }
  if (Array.isArray(parsed)) {
    throw new ConfigError(
      `${path} holds a list, and this takes one test. Batches are not supported yet: split it with ` +
        '"test export --format jsonl" and run the command once for each line.',
    );
  }
  if (!isRecord(parsed)) throw new ConfigError(`${path} must hold one test record, a JSON object.`);
  return parsed;
}

/** `action|data|result`. Later parts are optional, and a literal pipe is written `\|`. */
export function parseStepFlag(value: string): XrayStepInput {
  const parts = value.split(/(?<!\\)\|/).map((part) => part.replaceAll('\\|', '|'));
  if (parts.length > 3 || (parts[0] ?? '').trim() === '') {
    throw new ConfigError(`"${value}" is not a step. Write it as 'action|data|result', and a literal pipe as \\|.`);
  }
  return { action: parts[0] ?? '', data: parts[1] ?? '', result: parts[2] ?? '' };
}

/** Turns repeated `role=value` flags into the object `fields` takes. */
export function parseFieldFlags(values: readonly string[] | undefined): Record<string, string> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const fields: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) throw new ConfigError(`"${value}" is not a field. Write it as role=value.`);
    fields[value.slice(0, separator).trim()] = value.slice(separator + 1);
  }
  return fields;
}

/** Creates a Test in one request, steps included. Only links can follow it, so only they can fail part-way. */
export async function createXrayTest(
  backend: XrayBackend,
  input: XrayTestCreateInput,
): Promise<XrayWriteResult | XrayTestCreateDryRun> {
  const verifies = (input.verifies ?? []).map((key) => assertIssueKey(key));
  const merged = mergeInput(input);
  const instance = await backend.instance();
  const client = backend.jira();
  const { project, summary } = requireProjectAndSummary(input, merged);

  const steps = merged.steps ?? [];
  for (const step of steps) assertNotCallStep(project, step);
  const typeName = merged.type ?? inferType(merged, steps);
  const kind = typeName.toLowerCase();
  const definition = assertDefinitionFits(merged, kind);
  if (steps.length > 0 && kind !== 'manual') {
    throw new ConfigError(`A ${typeName} test has no steps; only Manual tests do.`);
  }

  // Before the issue exists, so an instance with no matching link type costs nothing to learn about.
  await Promise.all(verifies.map((key) => buildIssueLinkBody(client, `${project}-1`, VERIFIES_PHRASE, key)));

  const extra = await resolveExtraFields(backend, instance, merged);
  if (kind === 'cucumber') assertCucumberTypeGiven(instance, extra.values);
  const notes = [...merged.notes, ...extra.notes, ...untouchedColumnNotes(project, steps), ...attachmentNotes(steps)];
  const fields: Record<string, unknown> = {
    project: { key: project },
    issuetype: { name: instance.requireIssueType('test') },
    summary,
    [instance.requireField('testType')]: { value: await resolveTypeValue(client, instance, project, typeName, notes) },
    ...(steps.length === 0 ? {} : { [instance.requireField('steps')]: stepsFieldValue(steps) }),
    ...definitionField(instance, kind, definition),
    ...extra.values,
  };
  const request = mergeFields(input.body, fields);
  if (input.dryRun === true) return { dryRun: true, request, verifies, notes };

  const created = (await client.createIssue(request)) as { key?: string };
  const key = created.key;
  if (key === undefined) throw new ConfigError('Jira accepted the test but returned no key; find it in the project.');
  await linkRequirements(client, key, verifies);
  return readBackTest(backend, key, notes);
}

/** Applies a record or flags. Only what differs is sent, so an unchanged round trip writes nothing. */
export async function updateXrayTest(
  backend: XrayBackend,
  input: XrayTestUpdateInput,
): Promise<XrayWriteResult | XrayTestUpdateDryRun> {
  const test = assertIssueKey(input.test);
  const merged = mergeInput(input);
  const notes = [...merged.notes];
  const recordKey = input.record?.key;
  if (typeof recordKey === 'string' && recordKey !== test)
    notes.push(`The record is for ${recordKey}; applying it to ${test}.`);

  const startInstance = await backend.instance();
  const extraNames = await writableExtraNames(backend, startInstance, merged);
  const { record: current } = await getXrayTest(backend, test, { fields: extraNames });
  const instance = await backend.instance();
  if (!hasUpdateInput(input, merged)) {
    throw new ConfigError(`Nothing to update on ${test}. Pass --file, a field flag, or a body.`);
  }
  const fields = await changedIssueFields(backend, instance, test, current, merged, notes);
  const { operations, deletes } = await planStepsForUpdate(backend, test, current, merged, notes);

  const request = Object.keys(fields).length > 0 || input.body !== undefined ? mergeFields(input.body, fields) : null;
  if (input.dryRun === true) return { dryRun: true, test, request, operations, notes };

  if (deletes && input.confirm !== true) {
    const doomed = operations.flatMap((operation) => (operation.op === 'delete' ? [operation.id] : []));
    throw new ConfigError(
      `This would delete step${doomed.length === 1 ? '' : 's'} ${doomed.join(', ')} of ${test}, which cannot be ` +
        'undone. Pass --confirm to proceed, or --dry-run to see the whole plan.',
    );
  }

  const applied: string[] = [];
  if (request !== null) {
    await backend.jira().updateIssue(test, request);
    applied.push('the issue fields');
  }
  await applyStepOperations(backend, test, operations, applied);
  return readBackTest(backend, test, notes);
}

function requireProjectAndSummary(
  input: XrayTestCreateInput,
  merged: MergedInput,
): { readonly project: string; readonly summary: string } {
  const baseFields = isRecord(input.body?.fields) ? input.body.fields : {};
  const baseProject = isRecord(baseFields.project) ? (baseFields.project.key as string | undefined) : undefined;
  const project = input.project ?? baseProject;
  if (project === undefined) throw new ConfigError('A test needs a project. Pass --project.');
  const summary = merged.summary ?? (baseFields.summary as string | undefined);
  if (summary === undefined || summary.trim() === '') throw new ConfigError('A test needs a summary. Pass --summary.');
  return { project: assertProjectKey(project), summary };
}

function hasUpdateInput(input: XrayTestUpdateInput, merged: MergedInput): boolean {
  return (
    Object.keys(merged.fields ?? {}).length > 0 ||
    input.body !== undefined ||
    [merged.summary, merged.type, merged.steps, merged.gherkin, merged.definition, merged.recordDefinition].some(
      (value) => value !== undefined,
    )
  );
}

/** The issue fields that differ from the test as it stands, keyed by field id. */
async function changedIssueFields(
  backend: XrayBackend,
  instance: XrayInstance,
  test: string,
  current: XrayTestRecord,
  merged: MergedInput,
  notes: string[],
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  if (merged.summary !== undefined && merged.summary !== current.summary) fields.summary = merged.summary;

  if (merged.type !== undefined && merged.type.toLowerCase() !== current.type?.toLowerCase()) {
    if (current.steps.length > 0) {
      throw new ConfigError(
        `${test} has steps, so its type cannot change here: Xray does not document what happens to them. ` +
          'Delete the steps first.',
      );
    }
    const project = test.slice(0, test.lastIndexOf('-'));
    fields[instance.requireField('testType')] = {
      value: await resolveTypeValue(backend.jira(), instance, project, merged.type, notes),
    };
  }

  const kind = (merged.type ?? current.type ?? '').toLowerCase();
  const wanted = merged.gherkin ?? merged.definition ?? merged.recordDefinition;
  // Only a change is checked, so a record of a custom-typed test still round-trips with no write.
  if (wanted !== undefined && wanted !== current.definition) {
    Object.assign(fields, definitionField(instance, kind, assertDefinitionFits(merged, kind)));
  }

  const extra = await resolveExtraFields(backend, instance, merged);
  notes.push(...extra.notes);
  for (const { name, id } of extra.resolved) {
    if (JSON.stringify(current.fields[name]) !== JSON.stringify(merged.fields?.[name])) {
      fields[id] = extra.values[id];
    }
  }
  return fields;
}

async function planStepsForUpdate(
  backend: XrayBackend,
  test: string,
  current: XrayTestRecord,
  merged: MergedInput,
  notes: string[],
): Promise<Pick<XrayStepPlan, 'operations' | 'deletes'>> {
  const type = merged.type ?? current.type;
  const steps = merged.steps ?? [];
  if (steps.length > 0) assertManual(test, type);
  // An export of a Cucumber test carries an empty list, which is not a request to touch steps.
  if (merged.steps === undefined || (steps.length === 0 && type?.toLowerCase() !== 'manual')) {
    return { operations: [], deletes: false };
  }
  const existing = await readCurrentSteps(backend, test);
  const plan = planStepChanges(test, existing, steps);
  notes.push(...plan.warnings, ...untouchedColumnNotes(test, [...existing, ...steps]), ...attachmentNotes(steps));
  return plan;
}

interface MergedInput {
  readonly summary?: string;
  readonly type?: string;
  readonly steps?: readonly XrayStepInput[];
  readonly gherkin?: string;
  readonly definition?: string;
  /** A record's `definition`, which fits whichever kind the test turns out to be. */
  readonly recordDefinition?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Names that came from a flag, which are refused rather than noted when not writable. */
  readonly flagFields: ReadonlySet<string>;
  readonly notes: string[];
}

function mergeInput(input: XrayTestInput): MergedInput {
  const record = input.record ?? {};
  const ignored = Object.keys(record).filter((name) => !RECORD_APPLIED.has(name));
  const notes =
    ignored.length === 0
      ? []
      : [`Ignored from the record, as this command does not write them: ${ignored.join(', ')}.`];
  const recordFields = record.fields ?? {};
  if (!isRecord(recordFields)) throw new ConfigError('The record\'s "fields" must be an object.');
  const fields = { ...recordFields, ...input.fields };
  return {
    summary: input.summary ?? optionalString(record.summary, 'summary'),
    type: input.type ?? optionalString(record.type, 'type'),
    steps: input.steps ?? recordSteps(record.steps),
    gherkin: input.gherkin,
    definition: input.definition,
    recordDefinition: optionalString(record.definition, 'definition'),
    fields,
    flagFields: new Set(Object.keys(input.fields ?? {})),
    notes,
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`The record's "${name}" must be a string.`);
  return value;
}

function recordSteps(value: unknown): XrayStepInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ConfigError('The record\'s "steps" must be a list.');
  return value.map((step: unknown, position) => {
    if (!isRecord(step)) throw new ConfigError(`Step ${position + 1} of the record is not an object.`);
    const column = (name: string): string => optionalString(step[name], `steps[${position}].${name}`) ?? '';
    return {
      id: typeof step.id === 'number' ? String(step.id) : optionalString(step.id, `steps[${position}].id`),
      action: column('action'),
      data: column('data'),
      result: column('result'),
      attachments: Array.isArray(step.attachments) ? (step.attachments as string[]) : [],
      ...(isRecord(step.extra) ? { extra: step.extra } : {}),
    };
  });
}

function inferType(merged: MergedInput, steps: readonly XrayStepInput[]): string {
  if (steps.length > 0) return 'Manual';
  if (merged.gherkin !== undefined) return 'Cucumber';
  if (merged.definition !== undefined) return 'Generic';
  throw new ConfigError('Pass --type, or the steps, Gherkin or definition it can be told from.');
}

/** The definition to write, refusing one that does not belong to this kind of test. */
function assertDefinitionFits(merged: MergedInput, kind: string): string | undefined {
  if (merged.gherkin !== undefined && kind !== 'cucumber') {
    throw new ConfigError(`Gherkin belongs to a Cucumber test; this one is ${kind === '' ? 'untyped' : kind}.`);
  }
  if (merged.definition !== undefined && kind !== 'generic') {
    throw new ConfigError(`--definition belongs to a Generic test; this one is ${kind === '' ? 'untyped' : kind}.`);
  }
  const definition = merged.gherkin ?? merged.definition ?? merged.recordDefinition;
  if (merged.recordDefinition !== undefined && kind !== 'cucumber' && kind !== 'generic') {
    throw new ConfigError('The record has a definition, but only Cucumber and Generic tests have one.');
  }
  return definition;
}

function definitionField(
  instance: XrayInstance,
  kind: string,
  definition: string | undefined,
): Record<string, unknown> {
  if (definition === undefined) return {};
  return { [instance.requireField(kind === 'cucumber' ? 'cucumberScenario' : 'genericDefinition')]: definition };
}

function assertCucumberTypeGiven(instance: XrayInstance, values: Readonly<Record<string, unknown>>): void {
  const given = (instance.field('cucumberType') ?? '') in values;
  const version = instance.record.xrayVersion;
  if (!given && version !== null && compareVersions(version, CUCUMBER_TYPE_OPTIONAL_FROM) < 0) {
    throw new ConfigError(
      `Xray ${version} requires the Cucumber type on create. Pass --field cucumberType=Scenario, or Scenario Outline.`,
    );
  }
}

/** Tests - REST: the steps field's value, whose column names differ from what the field returns. */
function stepsFieldValue(steps: readonly XrayStepInput[]): unknown {
  return {
    steps: steps.map((step, position) => ({
      index: position + 1,
      fields: { action: step.action, data: step.data, 'expected result': step.result },
    })),
  };
}

function attachmentNotes(steps: readonly XrayStepInput[]): string[] {
  return steps.some((step) => !hasId(step) && (step.attachments?.length ?? 0) > 0)
    ? ['Attachments named on new steps were not written: a record holds only their file names.']
    : [];
}

/**
 * The value the type field takes, matched against what it allows here. If the instance will not say,
 * a known type is sent with its documented spelling and anything else as given, so Jira's own
 * 400 is what reports a mistake.
 */
async function resolveTypeValue(
  client: JiraClient,
  instance: XrayInstance,
  project: string,
  type: string,
  notes: string[],
): Promise<string> {
  const allowed = await allowedTestTypes(client, instance, project);
  if (allowed === undefined) {
    notes.push(`The test types ${project} allows could not be read, so "${type}" was not checked.`);
    return DOCUMENTED_TYPES.get(type.toLowerCase()) ?? type;
  }
  const match = allowed.find((value) => value.toLowerCase() === type.toLowerCase());
  if (match === undefined)
    throw new ConfigError(`"${type}" is not a test type in ${project}. Allowed: ${allowed.join(', ')}.`);
  return match;
}

const DOCUMENTED_TYPES = new Map([
  ['manual', 'Manual'],
  ['cucumber', 'Cucumber'],
  ['generic', 'Generic'],
]);

/** Jira's create metadata for the type field: the per-type endpoint, then the one Jira 9 removed. */
async function allowedTestTypes(
  client: JiraClient,
  instance: XrayInstance,
  project: string,
): Promise<string[] | undefined> {
  const fieldId = instance.requireField('testType');
  const typeName = instance.requireIssueType('test');
  const values = (allowed: unknown): string[] | undefined =>
    Array.isArray(allowed)
      ? allowed.flatMap((option: unknown) =>
          isRecord(option) && typeof option.value === 'string' ? [option.value] : [],
        )
      : undefined;
  try {
    const base = `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
    const types = await client.getFromRoot<{ values?: Array<{ id?: string; name?: string }> }>(base);
    const id = types.values?.find((candidate) => candidate.name === typeName)?.id;
    if (id !== undefined) {
      const meta = await client.getFromRoot<{ values?: Array<{ fieldId?: string; allowedValues?: unknown }> }>(
        `${base}/${encodeURIComponent(id)}`,
        { maxResults: 200 },
      );
      return values(meta.values?.find((field) => field.fieldId === fieldId)?.allowedValues);
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
  }
  try {
    const legacy = await client.getFromRoot<{
      projects?: Array<{ issuetypes?: Array<{ name?: string; fields?: Record<string, { allowedValues?: unknown }> }> }>;
    }>('/rest/api/2/issue/createmeta', {
      projectKeys: project,
      issuetypeNames: typeName,
      expand: 'projects.issuetypes.fields',
    });
    return values(legacy.projects?.[0]?.issuetypes?.[0]?.fields?.[fieldId]?.allowedValues);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return undefined;
  }
}

interface ResolvedExtraFields {
  readonly resolved: ResolvedField[];
  /** Field id → value in the shape Jira takes. */
  readonly values: Record<string, unknown>;
  readonly notes: string[];
}

/** The extra field names that can be written, so `update` can read their current values. */
async function writableExtraNames(
  backend: XrayBackend,
  instance: XrayInstance,
  merged: MergedInput,
): Promise<string[]> {
  return (await resolveExtraFields(backend, instance, merged)).resolved.map((field) => field.name);
}

/**
 * Resolves `fields` names as `--fields` does. A record holds simplified values (`["Accounts"]`), so
 * each is shaped back through the field's schema. Xray's own fields are noted when a record carries
 * them, since an export with `--fields steps` does, and refused when asked for by flag.
 */
async function resolveExtraFields(
  backend: XrayBackend,
  instance: XrayInstance,
  merged: MergedInput,
): Promise<ResolvedExtraFields> {
  const names = Object.keys(merged.fields ?? {});
  if (names.length === 0) return { resolved: [], values: {}, notes: [] };
  const notWritable = new Set(NOT_WRITABLE_ROLES.flatMap((role) => instance.field(role) ?? []));
  const all = await backend.resolveFields(instance, names);
  const skipped: string[] = [];
  const resolved = all.filter((field) => {
    if (!notWritable.has(field.id)) return true;
    if (merged.flagFields.has(field.name)) {
      throw new ConfigError(`"${field.name}" cannot be set with --field. Use its own flag, or leave it out.`);
    }
    skipped.push(field.name);
    return false;
  });
  const schemas = new Map((await listFields(backend.jira())).map((field) => [field.id, field.schema]));
  const cucumberType = instance.field('cucumberType');
  const values = Object.fromEntries(
    resolved.map(({ name, id }) => {
      const value = merged.fields?.[name];
      if (id === cucumberType) return [id, typeof value === 'string' ? { value } : value];
      return [id, shapeFieldValue(schemas.get(id), value)];
    }),
  );
  const notes =
    skipped.length === 0 ? [] : [`Ignored from the record's fields, as they are Xray's own: ${skipped.join(', ')}.`];
  return { resolved, values, notes };
}

/** Puts a simplified or typed value back in the shape the field's schema calls for. */
function shapeFieldValue(schema: JiraField['schema'], value: unknown): unknown {
  if (schema?.type === 'array') {
    const items = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : value;
    return Array.isArray(items) ? items.map((item: unknown) => shapeScalar(schema.items, item)) : value;
  }
  return shapeScalar(schema?.type, value);
}

function shapeScalar(type: string | undefined, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (type === 'number') {
    const parsed = Number(value);
    return value.trim() === '' || Number.isNaN(parsed) ? value : parsed;
  }
  if (type === 'option') return { value };
  if (type === 'string' || type === 'any' || type === 'date' || type === 'datetime' || type === undefined) return value;
  return { name: value };
}

/** Links the created test to its requirements, reporting the key and what is left if one fails. */
async function linkRequirements(client: JiraClient, test: string, verifies: readonly string[]): Promise<void> {
  const done: string[] = [`created ${test}`];
  /* eslint-disable no-await-in-loop -- sequential, so a failure can say exactly which links exist. */
  for (const [position, key] of verifies.entries()) {
    try {
      const { body } = await buildIssueLinkBody(client, test, VERIFIES_PHRASE, key);
      await client.createIssueLink(body);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      const rest = verifies.slice(position);
      throw new XrayPartialWriteError(
        `${test} was created, but a link failed: ${error.message}`,
        done,
        rest.map((other) => `link to ${other}`),
        `Finish with "jira issue link create ${test} tests ${rest[0] ?? key}"; the test was not deleted.`,
      );
    }
    done.push(`link to ${key}`);
  }
  /* eslint-enable no-await-in-loop */
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
