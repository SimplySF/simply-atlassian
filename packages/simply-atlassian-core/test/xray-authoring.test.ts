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
import { planStepChanges, type XrayStepInput } from '../src/xray-authoring.js';
import type { ParsedStep } from '../src/xray-tests.js';

function current(id: string | null, action: string, attachments: string[] = []): ParsedStep {
  return { id, action, data: '', result: '', attachments };
}

function wanted(id: string | null | undefined, action: string): XrayStepInput {
  return { id, action, data: '', result: '' };
}

const THREE = [current('1', 'a'), current('2', 'b'), current('3', 'c')];

describe('planStepChanges by id', () => {
  it('plans nothing for an unchanged list', () => {
    const plan = planStepChanges('OM-1', THREE, [wanted('1', 'a'), wanted('2', 'b'), wanted('3', 'c')]);
    expect(plan).toEqual({ operations: [], warnings: [], deletes: false });
  });

  it('updates only the columns that changed', () => {
    const plan = planStepChanges('OM-1', THREE, [
      wanted('1', 'a'),
      { id: '2', action: 'b', data: 'new', result: '' },
      wanted('3', 'c'),
    ]);
    expect(plan.operations).toEqual([{ op: 'update', id: '2', changes: { data: 'new' } }]);
  });

  it('does not count a line-ending difference as an edit', () => {
    const plan = planStepChanges('OM-1', [current('1', 'a\nb')], [wanted('1', 'a\r\nb')]);
    expect(plan.operations).toEqual([]);
  });

  it('adds a step with no id after the kept ones', () => {
    const plan = planStepChanges('OM-1', THREE, [
      wanted('1', 'a'),
      wanted('2', 'b'),
      wanted('3', 'c'),
      wanted(null, 'd'),
    ]);
    expect(plan.operations).toEqual([{ op: 'add', action: 'd', data: '', result: '' }]);
    expect(plan.deletes).toBe(false);
  });

  it('deletes a step missing from the input, after every other operation', () => {
    const plan = planStepChanges('OM-1', THREE, [wanted('1', 'edited'), wanted('3', 'c'), wanted(null, 'd')]);
    expect(plan.operations.map((operation) => operation.op)).toEqual(['update', 'add', 'delete']);
    expect(plan.operations[2]).toEqual({ op: 'delete', id: '2', action: 'b' });
    expect(plan.deletes).toBe(true);
  });

  it('refuses a stale id before anything is sent', () => {
    expect(() => planStepChanges('OM-1', THREE, [wanted('99', 'a')])).toThrow(/Step 99 is not on OM-1.*1, 2, 3/);
  });

  it('refuses a duplicate id', () => {
    expect(() => planStepChanges('OM-1', THREE, [wanted('1', 'a'), wanted('1', 'a')])).toThrow(/appears twice/);
  });

  it('refuses a reorder and says how to get there', () => {
    expect(() => planStepChanges('OM-1', THREE, [wanted('2', 'b'), wanted('1', 'a'), wanted('3', 'c')])).toThrow(
      /reorders the steps.*delete and re-add/,
    );
  });

  it('refuses a new step placed before a kept one', () => {
    expect(() => planStepChanges('OM-1', THREE, [wanted(null, 'new'), wanted('1', 'a')])).toThrow(
      /a new step always goes last/,
    );
  });

  it('refuses a call step in the input', () => {
    const call = { ...wanted('1', ''), extra: { testCallBean: { key: 'OM-2' } } };
    expect(() => planStepChanges('OM-1', THREE, [call])).toThrow(/calls another test/);
  });
});

describe('planStepChanges by position', () => {
  it('plans nothing for equal text', () => {
    const plan = planStepChanges('OM-1', THREE, [
      wanted(undefined, 'a'),
      wanted(undefined, 'b'),
      wanted(undefined, 'c'),
    ]);
    expect(plan.operations).toEqual([]);
  });

  it('adds the steps past the end', () => {
    const plan = planStepChanges('OM-1', [current('1', 'a')], [wanted(undefined, 'a'), wanted(undefined, 'b')]);
    expect(plan.operations).toEqual([{ op: 'add', action: 'b', data: '', result: '' }]);
  });

  it('deletes the steps past the end of the input', () => {
    const plan = planStepChanges('OM-1', THREE, [wanted(undefined, 'a')]);
    expect(plan.operations.map((operation) => operation.op)).toEqual(['delete', 'delete']);
    expect(plan.deletes).toBe(true);
  });

  it('updates a middle step', () => {
    const plan = planStepChanges('OM-1', THREE, [
      wanted(undefined, 'a'),
      wanted(undefined, 'B'),
      wanted(undefined, 'c'),
    ]);
    expect(plan.operations).toEqual([{ op: 'update', id: '2', changes: { action: 'B' } }]);
  });

  it('warns when a step with attachments changes text', () => {
    const plan = planStepChanges('OM-1', [current('1', 'a', ['shot.png'])], [wanted(undefined, 'b')]);
    expect(plan.warnings.join()).toContain('shot.png');
  });

  it('refuses to overwrite a call step', () => {
    const call = { ...current('1', ''), extra: { testCallBean: { key: 'OM-2' } } };
    expect(() => planStepChanges('OM-1', [call], [wanted(undefined, 'plain')])).toThrow(/calls another test/);
  });

  it('leaves a call step alone when its text does not change', () => {
    const call = { ...current('1', ''), extra: { testCallBean: { key: 'OM-2' } } };
    expect(planStepChanges('OM-1', [call], [wanted(undefined, '')]).operations).toEqual([]);
  });
});
