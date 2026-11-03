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

import { CliError, ConfigError, XrayPartialWriteError } from './errors.js';
import { assertIssueKey } from './jira-issues.js';
import type { XrayBackend } from './xray-backend.js';
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
